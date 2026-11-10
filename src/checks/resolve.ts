// A finished Agent run turned into the check's outcome (spec 4.5). Used by the Agent
// callback and by the cron's follow-up of runs whose callback never came, so both
// settle a run the same way: the result is read through the adapter, classified by the match rule
// (the classifier always wins over what the Agent opened), the check is finished exactly once
// (finishPendingCheck), the Agent steps are billed only by the call that finished it, the slot is
// released and the queue pumped.
import { classifyRows } from "../core/classify";
import { CANDIDATES_MAX } from "../core/limits";
import { PRICES, recordSpend } from "../core/spend";
import { finishPendingCheck, getCheck, requeueByNumber, type CheckPatch } from "../db/checks";
import { getRecord, upsertRecord } from "../db/records";
import type { CheckRow, RecordRow } from "../db/types";
import type { Env } from "../env";
import { getAdapterById } from "../registries/index";
import type { AgentEntry, RegistryAdapter, RegistryRow } from "../registries/types";
import type { AgentRun, AgentStep } from "../tinyfish/agent";
import { errorCodeOrNull } from "../tinyfish/client";
import { storeAgentEvidence, storeScreenshot } from "./evidence";
import { nameMatches, planSearch, type SearchPlan } from "./plan";
import { pumpQueue, spendPaused } from "./queue";
import {
  mergeWithEntry,
  normalizeAgentEntry,
  normalizePage,
  normalizeResultsRow,
  readRecordPage,
  sameNumber,
  todayIso,
  type Normalized,
} from "./record";
import { releaseSlot } from "./slot";
import { eventForRecheck } from "../monitoring/events";
import { notifyFinished, type Defer } from "./view";
import { dropForRecord } from "../site/htmlCache";

export type TerminalStatus = "COMPLETED" | "FAILED" | "CANCELLED";
const TERMINAL: ReadonlySet<string> = new Set<TerminalStatus>(["COMPLETED", "FAILED", "CANCELLED"]);

export function isTerminal(status: string | null | undefined): status is TerminalStatus {
  return typeof status === "string" && TERMINAL.has(status);
}

/** A run that has ended, as the resolver needs it. `errorCode` is a short shaped code or null:
 *  a run's own error text can echo page content and is never stored. */
export interface FinishedRun {
  runId: string;
  status: TerminalStatus;
  result: unknown;
  num_of_steps: number | null;
  finished_at: string | null;
  /** Read with screenshots (getRun `"url"`); the evidence step is picked from these. */
  steps: AgentStep[];
  errorCode: string | null;
}

/** A run read with getRun, or null while it has not ended. */
export function finishedRunFrom(runId: string, run: AgentRun): FinishedRun | null {
  const status = run.status.toUpperCase();
  if (!isTerminal(status)) return null;
  return {
    runId,
    status,
    result: run.result,
    num_of_steps: run.num_of_steps,
    finished_at: run.finished_at,
    steps: run.steps,
    errorCode: errorCodeOrNull(run.error),
  };
}

/** What settling a run did, for callers that act on it (the re-check events of a watch). */
export interface Settled {
  /** False when another caller had already finished the check: nothing was written or billed. */
  applied: boolean;
  outcome: CheckRow["outcome"];
  recordId: string | null;
  /** The record as it was before this run refreshed it (only when the check named its record). */
  before: RecordRow | null;
  /** The check went back to the queue for one search by number; it is still pending. */
  requeued?: boolean;
}

function storedStrings(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** A time the repositories can store, or undefined (stamped now). */
function safeTime(value: string | null): string | undefined {
  return value !== null && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

const agentCost = (run: FinishedRun) => round((run.num_of_steps ?? 0) * PRICES.agent_step);

/** Finishes the check once, with `spend_usd` = what the check had already spent (an earlier run of a
 *  requeued check) + this run's steps + any screenshot, and `checked_at` = the run's `finished_at`; the
 *  `agent_step` spend row is written only when this call finished it. */
async function finishRun(
  env: Env,
  check: CheckRow,
  run: FinishedRun,
  patch: CheckPatch,
  opts: { extraUsd?: number; candidates?: RegistryRow[] } = {},
): Promise<boolean> {
  const agentUsd = agentCost(run);
  const spend = round((check.spend_usd ?? 0) + agentUsd + (opts.extraUsd ?? 0));
  const applied = await finishPendingCheck(
    env.DB,
    check.id,
    { ...patch, method: "agent", spend_usd: spend, checked_at: safeTime(run.finished_at) },
    opts.candidates ?? [],
  );
  if (applied && agentUsd > 0) await recordSpend(env.DB, "agent_step", agentUsd, check.id);
  return applied;
}

// Anything that looks like a URL or a host name keeps a block message out of the check.
const LOOKS_LIKE_URL = /[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+\.(?:[a-z0-9-]+\.)*[a-z]{2,}\b/i;

/** `blocked`, with the block page's message only when it holds no URL (a block page's link is never shown). */
function blockedError(message: string | null): string {
  const text = (message ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return text === "" || LOOKS_LIKE_URL.test(text) ? "blocked" : `blocked: ${text}`;
}

type Decision =
  | { outcome: "match"; row: RegistryRow }
  | { outcome: "ambiguous"; candidates: RegistryRow[]; total: number }
  | { outcome: "no_match" }
  /** The run listed rows (or opened an entry) but nothing a number search can be decided on. */
  | { outcome: "incomplete" };

/** The rows a run lists for a name search when the adapter does not say: every goal asks for up to 10
 *  (beyond the matching ones). */
const DEFAULT_ROWS_LISTED = 10;

function ambiguous(first: RegistryRow[], rows: RegistryRow[], total: number): Decision {
  const rest = rows.filter((r) => !first.includes(r));
  return { outcome: "ambiguous", candidates: [...first, ...rest].slice(0, CANDIDATES_MAX), total: Math.max(total, rows.length) };
}

type Entry = AgentEntry;

function rowOf(entry: Entry): RegistryRow {
  return { name: entry.full_name ?? "", number: entry.licence_number, status_raw: entry.status_raw, detail: null, url: entry.url };
}

/**
 * The match rule on what the run reported. A number search matches the one row whose number is the
 * input number, or, when no row shows it, the opened entry whose number is (the goal asks for a row's
 * number only "if the row shows it"); several equal rows are ambiguous; it is no_match only when every
 * row and the opened entry carry a number and none is the input. A row or an entry without a number
 * could be the registrant, so it makes the result `incomplete` (never no_match). A name search uses
 * classifyRows, and is never a match when the run may have listed fewer rows than there were:
 * `results_found` above the rows listed, or no `results_found` with a full list of
 * `listSize` (the adapter's `agentRowsListed`); nor beside a row the run listed without a name (it could
 * be the same person). The match then becomes ambiguous with `candidates_total` the larger count.
 */
export function decideRows(
  plan: SearchPlan,
  rows: RegistryRow[],
  resultsFound: number | null,
  opened: Entry | null = null,
  listSize: number = DEFAULT_ROWS_LISTED,
): Decision {
  const found = resultsFound ?? 0;
  if (plan.by === "number") {
    const equal = rows.filter((r) => sameNumber(r.number, plan.number));
    if (equal.length > 1) return ambiguous(equal, rows, found);
    if (equal.length === 1) return { outcome: "match", row: equal[0]! };
    if (opened !== null && sameNumber(opened.licence_number, plan.number)) return { outcome: "match", row: rowOf(opened) };
    const numberless = rows.some((r) => r.number === null) || (opened !== null && opened.licence_number === null);
    return numberless ? { outcome: "incomplete" } : { outcome: "no_match" };
  }
  const classified =
    plan.subject === "person"
      ? classifyRows(rows, { kind: "person", normalized: plan.normalized })
      : classifyRows(rows, { kind: "business", normalized: plan.normalized });
  const truncated = found > rows.length || (resultsFound === null && rows.length >= listSize);
  const unnamed = rows.some((r) => r.name.trim() === "");
  if (classified.outcome === "match") {
    return truncated || unnamed ? ambiguous([classified.row], rows, found) : classified;
  }
  if (classified.outcome === "ambiguous") return { ...classified, total: Math.max(classified.total, found) };
  return classified;
}

/** The entry the run opened, when it is the matched row: its number agrees, or (with no number to
 *  compare) its name passes the match rule, or (a number search) its number is the input. An entry that
 *  names nothing comparable is not tied to the row and is not used: the classifier's row stands alone. */
function entryFor(opened: Entry | null, row: RegistryRow, plan: SearchPlan): Entry | null {
  if (opened === null) return null;
  if (opened.licence_number !== null && row.number !== null) return sameNumber(opened.licence_number, row.number) ? opened : null;
  if (plan.by === "name" && opened.full_name !== null) return nameMatches(plan, opened.full_name) ? opened : null;
  if (plan.by === "number" && opened.licence_number !== null) return sameNumber(opened.licence_number, plan.number) ? opened : null;
  return null;
}

type MatchRead =
  | { kind: "record"; normalized: Normalized; sourceUrl: string | null }
  /** Nothing showed the match's status: search the same check again by this number. */
  | { kind: "requeue"; number: string };

/**
 * The record for a match, from the first of: the record page read with Fetch (the same acceptance test
 * as the number path: name, status line, the asked number when shown; the entry fills gaps); the
 * accepted opened entry; and, when neither exists, never the results row's status: a NAME
 * search with the row's number asks for one Agent run by that number, and otherwise (no number, or
 * this already was the number search) the match keeps the row with status `unknown`.
 */
async function readMatch(
  env: Env,
  check: CheckRow,
  adapter: RegistryAdapter,
  plan: SearchPlan,
  row: RegistryRow,
  entry: Entry | null,
): Promise<MatchRead> {
  const number = row.number ?? entry?.licence_number ?? null;
  const built = number !== null && adapter.recordUrl ? adapter.recordUrl(number, check.profession ?? undefined) : null;
  // Without a URL of its own (a DCA name search with no profession), the page the run opened is read,
  // when the adapter trusted its address (an https URL on the register's own site) and can parse it.
  const url = built ?? (adapter.parseRecordPage && entry?.url ? entry.url : null);
  if (url !== null) {
    const read = await readRecordPage(env, adapter, url, number);
    if (read.ok) {
      return { kind: "record", normalized: normalizePage(adapter, mergeWithEntry(read.parsed, entry), url, todayIso()), sourceUrl: url };
    }
  }
  if (entry !== null) {
    const normalized = normalizeAgentEntry(
      adapter,
      { ...entry, full_name: entry.full_name ?? (row.name === "" ? null : row.name), licence_number: entry.licence_number ?? number },
      todayIso(),
    );
    return { kind: "record", normalized, sourceUrl: url ?? entry.url ?? row.url };
  }
  if (number !== null && plan.by === "name") return { kind: "requeue", number };
  return { kind: "record", normalized: normalizeResultsRow(row, number), sourceUrl: url ?? row.url };
}

/**
 * A COMPLETED run's result to the check's outcome. `blocked` is an error; a run that found rows but
 * listed none uses the entry it opened as the one row, or is `error: "incomplete_agent_result"`
 * (never no_match); then the match rule (`decideRows`, which also ends a number search with nothing
 * numbered to compare as incomplete). A match is read (`readMatch`: record page, else the accepted
 * entry, never the results row's status); when only the row is left on a name search with a number,
 * the check goes back to the queue for one run by that number instead of finishing. Otherwise the
 * evidence is stored (the run's record-page step, else a TinyBrowser screenshot of the source URL)
 * and the record upserted. Ambiguous stores the candidates with the finish; no_match stores the
 * adapter's suggestions. `variants_tried` is the run's own list, else the goal's, else (a requeued
 * check's number run) the list the name run stored.
 */
export async function resolveFromRows(env: Env, check: CheckRow, adapter: RegistryAdapter, run: FinishedRun): Promise<Settled> {
  const settled = (applied: boolean, outcome: CheckRow["outcome"], recordId: string | null = null, before: RecordRow | null = null): Settled => ({
    applied,
    outcome,
    recordId,
    before,
  });
  const plan = check.record_type === null ? null : planSearch(adapter, check.record_type, check.query_raw, check.number, check.profession);
  if (plan === null || "invalid" in plan) {
    return settled(await finishRun(env, check, run, { outcome: "error", error: "invalid_query" }), "error");
  }
  const result = adapter.parseAgentResult(run.result);
  // The run's own list, else the goal's; a requeued check's number run keeps the name run's list.
  const variants_tried =
    result.variantsTried.length > 0 ? result.variantsTried : plan.variants.length > 0 ? plan.variants : storedStrings(check.variants_tried);

  if (result.blocked) {
    return settled(await finishRun(env, check, run, { outcome: "error", error: blockedError(result.blockMessage), variants_tried }), "error");
  }

  let rows = result.rows;
  // A run that reports no rows, no entry and no count of its own never said the register had nothing: it
  // may never have searched (a live GMC run that could not find the search box returned all nulls).
  // Only a run that reports `results_found: 0` is a no_match.
  if (rows.length === 0 && result.opened === null && result.resultsFound === null) {
    return settled(await finishRun(env, check, run, { outcome: "error", error: "incomplete_agent_result", variants_tried }), "error");
  }
  if (rows.length === 0 && ((result.resultsFound ?? 0) > 0 || result.opened !== null)) {
    if (result.opened === null) {
      return settled(await finishRun(env, check, run, { outcome: "error", error: "incomplete_agent_result", variants_tried }), "error");
    }
    const o = result.opened;
    rows = [{ name: o.full_name ?? "", number: o.licence_number, status_raw: o.status_raw, detail: null, url: o.url }];
  }

  const decision = decideRows(plan, rows, result.resultsFound, result.opened, adapter.agentRowsListed);
  if (decision.outcome === "incomplete") {
    return settled(await finishRun(env, check, run, { outcome: "error", error: "incomplete_agent_result", variants_tried }), "error");
  }
  if (decision.outcome === "no_match") {
    const applied = await finishRun(env, check, run, { outcome: "no_match", variants_tried, suggestions: adapter.noMatchSuggestions ?? [] });
    return settled(applied, "no_match");
  }
  if (decision.outcome === "ambiguous") {
    const applied = await finishRun(
      env,
      check,
      run,
      { outcome: "ambiguous", variants_tried, candidates_total: decision.total },
      { candidates: decision.candidates },
    );
    return settled(applied, "ambiguous");
  }

  const entry = entryFor(result.opened, decision.row, plan);
  const read = await readMatch(env, check, adapter, plan, decision.row, entry);
  if (read.kind === "requeue" && check.added_by === "public" && check.trigger === "request") {
    // A public check costs one run, the price it was quoted and the one the day's cap counted. The
    // run found the person but not their status, so the row is offered as the one candidate: the
    // visitor verifies it by its number, which is a check of its own.
    const applied = await finishRun(env, check, run, { outcome: "ambiguous", variants_tried, candidates_total: 1 }, { candidates: [decision.row] });
    return settled(applied, "ambiguous");
  }
  if (read.kind === "requeue") {
    // The check stays pending and goes back to the queue for one run by the number; this run's steps
    // are billed now (once: the requeue is guarded on this run) and carried in its spend.
    const agentUsd = agentCost(run);
    const applied = await requeueByNumber(env.DB, check.id, run.runId, read.number, {
      variants_tried,
      spend_usd: round((check.spend_usd ?? 0) + agentUsd),
    });
    if (applied && agentUsd > 0) await recordSpend(env.DB, "agent_step", agentUsd, check.id);
    return { ...settled(applied, null), requeued: true };
  }
  const { normalized, sourceUrl } = read;

  // A match whose page showed neither a name nor a status line was not read at all (a live CSLB run
  // reached the licence page and reported nothing but its number): incomplete, never a match.
  if (normalized.record.full_name === null && normalized.record.status_raw === null) {
    return settled(await finishRun(env, check, run, { outcome: "error", error: "incomplete_agent_result", variants_tried }), "error");
  }

  // A Monitor re-check refreshes the record it was asked about, never another one: a match whose number
  // differs from the stored record's ends as an error (the event says so) and the record is untouched.
  const before = check.record_id === null ? null : await getRecord(env.DB, check.record_id);
  if (
    before !== null &&
    before.licence_number !== null &&
    normalized.record.licence_number !== null &&
    !sameNumber(before.licence_number, normalized.record.licence_number)
  ) {
    return settled(await finishRun(env, check, run, { outcome: "error", error: "recheck_other_record", variants_tried }), "error");
  }

  let evidenceKey = await storeAgentEvidence(env, check.id, run.runId, run.steps);
  let shotUsd = 0;
  if (evidenceKey === null && sourceUrl !== null && !(await spendPaused(env.DB))) {
    const shot = await storeScreenshot(env, check.id, sourceUrl);
    evidenceKey = shot.key;
    shotUsd = shot.spentUsd;
  }

  const recordId = await upsertRecord(env.DB, {
    ...(check.record_id === null ? {} : { id: check.record_id }),
    registry: adapter.id,
    record_type: check.record_type!,
    record: normalized.record,
    source_url: sourceUrl,
    evidence_key: evidenceKey,
    restrictions: normalized.restrictions,
    checked_at: safeTime(run.finished_at),
  });
  // The site's stored screens that show this record now show an older read.
  await dropForRecord(env, recordId);
  const applied = await finishRun(
    env,
    check,
    run,
    {
      outcome: "match",
      status: normalized.record.status,
      flags: normalized.record.flags,
      record_id: recordId,
      evidence_key: evidenceKey,
      variants_tried,
    },
    { extraUsd: shotUsd },
  );
  return settled(applied, "match", recordId, before);
}

/** A FAILED or CANCELLED run: `error` with a shaped code only, its steps still billed. */
async function failRun(env: Env, check: CheckRow, run: FinishedRun): Promise<Settled> {
  const error = run.errorCode ?? (run.status === "CANCELLED" ? "agent_cancelled" : "agent_failed");
  return { applied: await finishRun(env, check, run, { outcome: "error", error }), outcome: "error", recordId: null, before: null };
}

/**
 * Settles a finished run for its check: resolves it (or records the failure), then releases the slot
 * if this check holds it and this call settled it (a losing duplicate leaves the slot alone), tells the
 * check's callback_url, and pumps the queue (inline). A resolver
 * that throws leaves the check `error: "resolve_failed"`; if even that cannot be written, the slot is
 * still released (in `finally`) and the error propagates, so the check stays pending for a retry.
 */
export async function settleAgentRun(env: Env, check: CheckRow, run: FinishedRun, defer?: Defer): Promise<Settled> {
  const adapter = check.registry === null ? null : getAdapterById(check.registry);
  let settled: Settled | undefined;
  try {
    try {
      if (adapter === null) {
        settled = { applied: await finishRun(env, check, run, { outcome: "error", error: "unknown_registry" }), outcome: "error", recordId: null, before: null };
      } else if (run.status === "COMPLETED") {
        settled = await resolveFromRows(env, check, adapter, run);
      } else {
        settled = await failRun(env, check, run);
      }
    } catch {
      console.error("agent run could not be resolved");
      settled = { applied: await finishRun(env, check, run, { outcome: "error", error: "resolve_failed" }), outcome: "error", recordId: null, before: null };
    }
  } finally {
    // Only the call that finished (or requeued) the check frees its slot. A losing duplicate must not:
    // the slot is held by check id, and a requeued check's next run may already hold it again. When
    // nothing could be written at all (settled unset), the slot is freed so the queue is not stuck.
    if (settled === undefined || settled.applied) {
      await releaseSlot(env.DB, check.id).catch(() => console.error("agent slot could not be released"));
    }
  }
  if (settled.applied && !settled.requeued) {
    const done = await getCheck(env.DB, check.id);
    if (done) await notifyFinished(env, done, defer);
    // A Monitor re-check writes its event (status_change, recheck or notice) once, here.
    if (check.trigger === "monitor") {
      await eventForRecheck(env, check, settled, defer).catch(() => console.error("re-check event could not be written"));
    }
  }
  await pumpQueue(env, defer);
  return settled;
}
