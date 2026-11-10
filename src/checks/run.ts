// POST /api/checks (spec 4.4): validate, count the public visitor's checks, serve the 24-hour
// cache unless `fresh`, then one of three paths:
//   - a number on a registry with a record URL: TinyFetch the record page, parse it, and finish a
//     `match` (method fetch) with markdown and screenshot evidence; if the page cannot be read or
//     lacks the name or the status line, queue one Agent run that searches by the number instead;
//   - a name on a registry whose search is a GET page (Companies House): TinyFetch the search,
//     classify the rows, and on a match read the company page;
//   - otherwise: queue one Agent run (src/checks/queue.ts); its callback resolves the check
//     (src/checks/resolve.ts).
import { classifyRows } from "../core/classify";
import { nameHasEveryWord } from "../core/names";
import {
  AGENT_ESTIMATE_USD,
  CACHE_HOURS,
  CANDIDATES_MAX,
  FETCH_ESTIMATE_USD,
  PUBLIC_AGENT_CHECKS_PER_DAY,
  PUBLIC_CHECKS_PER_IP_PER_DAY,
  PUBLIC_RECORD_TTL_HOURS,
} from "../core/limits";
import type { Flag } from "../core/status";
import {
  cacheKey,
  copyCandidates,
  countPublicAgentChecksToday,
  findCached,
  finishPendingCheck,
  getCheck,
  insertCheck,
  markQueued,
  recentSameRequest,
  type CheckPatch,
  type NewCheck,
} from "../db/checks";
import { bump, unbump } from "../db/publicUse";
import { upsertRecord } from "../db/records";
import type { CheckRow } from "../db/types";
import type { Env } from "../env";
import { getAdapter, SUPPORTED } from "../registries/index";
import type { Jurisdiction, RecordType, RegistryAdapter, RegistryRow } from "../registries/types";
import { TinyFishError } from "../tinyfish/client";
import { storeFetchEvidence } from "./evidence";
import { answerFromStored, registerSideFailure } from "./fallback";
import { firstMethod, nameMatches, planSearch, type SearchPlan } from "./plan";
import { enqueueAgentCheck, pumpQueue, spendPaused } from "./queue";
import { normalizePage, readRecordPage, todayIso, type PageRead } from "./record";
import { callbackUrlAllowed, notifyFinished, type Defer } from "./view";
import { dropForRecord } from "../site/htmlCache";

export { resolveFromRows, settleAgentRun } from "./resolve";
export { enqueueAgentCheck, enqueueMonitorRecheck, pumpQueue } from "./queue";

/** The body of POST /api/checks (spec 4.4). */
export interface CheckInput {
  query?: string;
  record_type: string;
  jurisdiction: string;
  number?: string;
  profession?: string;
  fresh?: boolean;
  callback_url?: string;
}

export interface StartedCheck {
  checkId: string;
  status: "done" | "pending";
  cached: boolean;
  estimatedCostUsd: number;
}

/** A request the checks API refuses, with its HTTP status and JSON body. */
export class CheckRejected extends Error {
  constructor(
    readonly status: 400 | 429 | 503,
    readonly body: { error: string; [key: string]: unknown },
  ) {
    super(body.error);
    this.name = "CheckRejected";
  }
}

/** What a public caller is told once the day's public Agent checks are used up. */
export const AGENT_CAP_BODY = {
  error: "daily_agent_checks_used",
  detail:
    "Today's public lookups that need a live registry search are used up. Stored results, cached answers and the read API still work, and the count resets at 00:00 UTC.",
} as const;

// The price estimates live in core/limits.ts (the site prints them too); re-exported for callers here.
export { AGENT_ESTIMATE_USD, FETCH_ESTIMATE_USD };

const MAX_CALLBACK_URL_CHARS = 2048;
const MAX_PROFESSION_CHARS = 80;

function invalidBody(detail: string): CheckRejected {
  return new CheckRejected(400, { error: "invalid_body", detail });
}

function optionalString(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidBody(`${key} must be a string`);
  if (value.length > max) throw invalidBody(`${key} is longer than ${max} characters`);
  return value;
}

/** Reads the JSON body: wrong types are 400 `invalid_body`. Values are checked by `startCheck`. A
 *  number given as a JSON number is read as its digits. */
export function parseCheckInput(body: unknown): CheckInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalidBody("the body must be a JSON object");
  const b = body as Record<string, unknown>;
  const number = typeof b.number === "number" && Number.isSafeInteger(b.number) && b.number >= 0 ? String(b.number) : optionalString(b, "number", 200);
  if (b.fresh !== undefined && b.fresh !== null && typeof b.fresh !== "boolean") throw invalidBody("fresh must be true or false");
  return {
    query: optionalString(b, "query", 1000),
    record_type: typeof b.record_type === "string" ? b.record_type : "",
    jurisdiction: typeof b.jurisdiction === "string" ? b.jurisdiction : "",
    number,
    profession: optionalString(b, "profession", MAX_PROFESSION_CHARS),
    fresh: b.fresh === true,
    callback_url: optionalString(b, "callback_url", MAX_CALLBACK_URL_CHARS),
  };
}

function parseStrings(text: string | null): string[] {
  try {
    const value: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** A cache hit: a NEW check row copying the original's result and its `checked_at` (when the register
 *  was actually read), with `cached_from_check_id` and no spend; the candidates are copied first, so the
 *  copy is never seen without them. */
async function serveCached(env: Env, hit: CheckRow, base: NewCheck, defer?: Defer): Promise<string> {
  const id = crypto.randomUUID();
  if (hit.outcome === "ambiguous") await copyCandidates(env.DB, hit.id, id);
  await insertCheck(env.DB, {
    ...base,
    id,
    state: "done",
    outcome: hit.outcome,
    status: hit.status,
    flags: parseStrings(hit.flags) as Flag[],
    record_id: hit.record_id,
    evidence_key: hit.evidence_key,
    variants_tried: parseStrings(hit.variants_tried),
    suggestions: parseStrings(hit.suggestions),
    candidates_total: hit.candidates_total,
    method: hit.method,
    checked_at: hit.checked_at,
    cached_from_check_id: hit.cached_from_check_id ?? hit.id,
    spend_usd: 0,
  });
  await notifyById(env, id, defer);
  return id;
}

async function notifyById(env: Env, id: string, defer?: Defer): Promise<void> {
  const done = await getCheck(env.DB, id);
  if (done) await notifyFinished(env, done, defer);
}

/** Finishes a Fetch-method match: evidence (markdown and screenshot), the record, the check. */
async function finishFetchMatch(env: Env, id: string, adapter: RegistryAdapter, recordType: RecordType, url: string, read: Extract<PageRead, { ok: true }>, variants: string[]): Promise<void> {
  const { record, restrictions } = normalizePage(adapter, read.parsed, url, todayIso());
  const evidence = await storeFetchEvidence(env, id, url, read.markdown);
  const recordId = await upsertRecord(env.DB, {
    registry: adapter.id,
    record_type: recordType,
    record,
    source_url: url,
    evidence_key: evidence.key.endsWith(".jpg") ? evidence.key : null,
    restrictions,
    checked_at: read.readAt,
  });
  // The site's stored screens that show this record now show an older read.
  await dropForRecord(env, recordId);
  await finishPendingCheck(env.DB, id, {
    outcome: "match",
    status: record.status,
    flags: record.flags,
    record_id: recordId,
    method: "fetch",
    evidence_key: evidence.key,
    spend_usd: evidence.spentUsd,
    variants_tried: variants,
    checked_at: read.readAt,
  });
}

/** Runs a Fetch path; anything unexpected ends the check as `error: "internal_error"` instead of
 *  leaving it pending for good. */
async function guarded(env: Env, id: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    console.error("check failed");
    await finishPendingCheck(env.DB, id, { outcome: "error", error: "internal_error", spend_usd: 0 });
  }
}

/** The number path for a registry with a record URL. "page" when the check finished from the page;
 *  "queued" when it was put in the queue for an Agent search by number (a page that cannot be read,
 *  including a Fetch that throws, takes the same Agent fallback); "capped" when it would have been, but
 *  `agentCap` (a public check) is used up: the check is then still pending and was never queued. When
 *  the register itself did not answer and Standing holds an earlier result for the number, that stored
 *  result is the answer instead. */
async function numberViaFetch(
  env: Env,
  id: string,
  adapter: RegistryAdapter,
  recordType: RecordType,
  url: string,
  number: string,
  agentCap: number | null,
): Promise<"page" | "queued" | "capped"> {
  let finished = false;
  await guarded(env, id, async () => {
    const read = await readRecordPage(env, adapter, url, number);
    if (!read.ok) {
      if (read.error !== undefined && (await answerFromStored(env, id, read.error))) finished = true;
      return;
    }
    await finishFetchMatch(env, id, adapter, recordType, url, read, []);
    finished = true;
  });
  if (finished || (await getCheck(env.DB, id))?.state !== "pending") return "page";
  // Queued and counted against the day's cap in one statement: a check the cap refuses never becomes
  // `method = 'agent'`, so no pump can start a run for it.
  if (await markQueued(env.DB, id, agentCap)) return "queued";
  return (await getCheck(env.DB, id))?.state === "pending" ? "capped" : "page";
}

/** When a full search page has a row with the exact name this close to its end, the next page is read
 *  too: a reused name (a dissolved namesake) can sit just past the page break. */
const NEXT_PAGE_WHEN_EXACT_IN_LAST = 5;

/**
 * The name path for a registry whose search results are a GET page (Companies House). Page 1 is
 * classified; when it is a full page (`searchPageRows`) and a row with the exact name sits in its last
 * five rows, page 2 is read as well (free, same options) and both pages are classified together. If
 * page 2 cannot be read, the result cannot be a match: it is ambiguous with page 1's rows.
 */
async function nameViaFetchSearch(env: Env, id: string, adapter: RegistryAdapter & Required<Pick<RegistryAdapter, "fetchSearch">>, recordType: RecordType, plan: Extract<SearchPlan, { by: "name" }>): Promise<void> {
  const variants = [plan.query];
  const finish = (patch: CheckPatch, candidates: RegistryRow[] = []) =>
    finishPendingCheck(env.DB, id, { method: "fetch", spend_usd: 0, variants_tried: variants, ...patch }, candidates);
  await guarded(env, id, async () => {
    const readAt = new Date().toISOString();
    let rows: RegistryRow[];
    try {
      rows = await adapter.fetchSearch(env, plan.query);
    } catch (err) {
      // The search never ran, so this is an error, never a no_match (or the last stored result, when
      // the register did not answer).
      const code = err instanceof TinyFishError ? err.code : "fetch_error";
      if (await answerFromStored(env, id, code)) return;
      await finish({ outcome: "error", error: code });
      return;
    }
    let nextPageUnread = false;
    const pageRows = adapter.searchPageRows;
    if (
      pageRows !== undefined &&
      rows.length >= pageRows &&
      rows.slice(-NEXT_PAGE_WHEN_EXACT_IN_LAST).some((row) => nameMatches(plan, row.name))
    ) {
      try {
        rows = [...rows, ...(await adapter.fetchSearch(env, plan.query, 2))];
      } catch {
        nextPageUnread = true;
      }
    }
    // On a register that lists its nearest names for anything, only rows that hold every significant
    // word of the query are candidates: a name that does not exist leaves none, which is no_match.
    if (adapter.searchNearest) rows = rows.filter((row) => nameHasEveryWord(plan.query, row.name));
    let classified =
      plan.subject === "person"
        ? classifyRows(rows, { kind: "person", normalized: plan.normalized })
        : classifyRows(rows, { kind: "business", normalized: plan.normalized });
    if (classified.outcome === "match" && nextPageUnread) {
      const row = classified.row;
      classified = { outcome: "ambiguous", candidates: [row, ...rows.filter((r) => r !== row)].slice(0, CANDIDATES_MAX), total: rows.length };
    }
    if (classified.outcome === "no_match") {
      await finish({ outcome: "no_match", suggestions: adapter.noMatchSuggestions ?? [], checked_at: readAt });
      return;
    }
    if (classified.outcome === "ambiguous") {
      await finish({ outcome: "ambiguous", candidates_total: classified.total, checked_at: readAt }, classified.candidates);
      return;
    }
    const number = classified.row.number;
    // The row's own record link (Sunbiz), else the record URL built from its number (Companies House).
    const url = classified.row.url ?? (number !== null && adapter.recordUrl ? adapter.recordUrl(number) : null);
    const read: PageRead = url === null ? { ok: false } : await readRecordPage(env, adapter, url, number);
    if (url === null || !read.ok) {
      // The record page could not be read: the register's own code when it did not answer, else this one.
      const failed = !read.ok && read.error !== undefined && registerSideFailure(read.error) ? read.error : "record_page_unreadable";
      if (await answerFromStored(env, id, failed)) return;
      await finish({ outcome: "error", error: "record_page_unreadable", checked_at: readAt });
      return;
    }
    await finishFetchMatch(env, id, adapter, recordType, url, read, variants);
  });
}

/**
 * Starts a check. Throws CheckRejected for: an unsupported (jurisdiction, record_type), 400
 * `unsupported` with the supported list; nothing to search, 400 `invalid_query`; a callback_url that
 * is not https or points at this Worker, 400 `invalid_body`; a public visitor's check past PUBLIC_CHECKS_PER_IP_PER_DAY in a
 * (UTC) day, 429 `daily_limit` (the admin is not limited); past the cache, any path that would
 * spend money once spending has reached SPEND_PAUSE_USD, 503 `spend_paused`; and a public check that
 * needs the Agent once the day's PUBLIC_AGENT_CHECKS_PER_DAY are used up, 429 `daily_agent_checks_used`
 * (when that need shows only after the page read failed, the check row ends as that error too).
 *
 * `defer` is the request's waitUntil, for the callback_url POST. The Agent queue is pumped inline.
 *
 * `replaySeconds` (the site's form only): the same request from the same caller within that many
 * seconds answers with the check it already started, pending or done, so a reload or a double click
 * never starts a second paid run. It is looked for after validation and before anything is counted.
 */
export async function startCheck(
  env: Env,
  input: CheckInput,
  who: { admin: boolean; ipHash: string },
  defer?: Defer,
  opts: { replaySeconds?: number } = {},
): Promise<StartedCheck> {
  const adapter = getAdapter(input.jurisdiction as Jurisdiction, input.record_type as RecordType);
  if (adapter === null) throw new CheckRejected(400, { error: "unsupported", supported: SUPPORTED });
  const recordType = input.record_type as RecordType;
  const profession = input.profession?.trim() || null;

  const plan = planSearch(adapter, recordType, input.query, input.number, profession);
  if ("invalid" in plan) throw new CheckRejected(400, { error: "invalid_query", detail: plan.invalid });
  const recordUrl = plan.by === "number" && adapter.recordUrl ? adapter.recordUrl(plan.number, profession ?? undefined) : null;
  // A register read only with Fetch whose record address cannot be built from a number (Sunbiz) is looked
  // up by name: a number would otherwise go to the Agent, which such a register never uses.
  if (plan.by === "number" && !adapter.recordUrl && adapter.coverage.lookup === "fetch") {
    throw new CheckRejected(400, {
      error: "invalid_query",
      detail: `${adapter.name} is looked up by name: send the company name as query instead of a number`,
    });
  }
  if (plan.by === "number" && adapter.recordUrl && recordUrl === null) {
    throw new CheckRejected(400, {
      error: "invalid_query",
      detail:
        adapter.numberLookupHint ??
        `${adapter.name} has no record page for that number: check the number (and the profession, where the register needs one)`,
    });
  }
  if (input.callback_url !== undefined && !callbackUrlAllowed(env, input.callback_url)) {
    throw invalidBody("callback_url must be an https URL on another host");
  }

  // A public visitor's check is counted only once it is going to be served (a cache hit, or a path that
  // starts), so a request refused at the spend pause does not use one of the day's checks.
  const countVisit = async () => {
    if (who.admin) return;
    const used = await bump(env.DB, who.ipHash, "checks");
    if (used.checks > PUBLIC_CHECKS_PER_IP_PER_DAY) throw new CheckRejected(429, { error: "daily_limit" });
  };

  const now = new Date();
  const key = cacheKey(adapter.id, recordType, plan.by === "number" ? plan.number : plan.display, profession);
  const base: NewCheck = {
    registry: adapter.id,
    record_type: recordType,
    jurisdiction: adapter.country,
    profession,
    query_raw: input.query?.trim() || null,
    query_normalized: plan.by === "name" ? plan.display : null,
    number: plan.by === "number" ? plan.number : null,
    cache_key: key,
    callback_url: input.callback_url ?? null,
    trigger: "request",
    ip_hash: who.admin ? null : who.ipHash,
    added_by: who.admin ? "admin" : "public",
    expires_at: who.admin ? null : new Date(now.getTime() + PUBLIC_RECORD_TTL_HOURS * 3_600_000).toISOString(),
    started_at: now.toISOString(),
  };

  if (opts.replaySeconds !== undefined) {
    const since = new Date(now.getTime() - opts.replaySeconds * 1000).toISOString();
    const again = await recentSameRequest(env.DB, key, who.admin ? null : who.ipHash, since, input.fresh === true);
    if (again !== null) return { checkId: again.id, status: again.state === "done" ? "done" : "pending", cached: false, estimatedCostUsd: 0 };
  }

  if (!input.fresh) {
    const hit = await findCached(env.DB, key, CACHE_HOURS);
    if (hit !== null) {
      await countVisit();
      return { checkId: await serveCached(env, hit, base, defer), status: "done", cached: true, estimatedCostUsd: 0 };
    }
  }
  if (await spendPaused(env.DB)) throw new CheckRejected(503, { error: "spend_paused" });
  // A public check that goes straight to the Agent is refused once the day's public Agent checks are
  // used up (PUBLIC_AGENT_CHECKS_PER_DAY, across every public caller), before it counts as a visit.
  const agentFromStart = firstMethod(adapter, plan.by, recordUrl) === "agent";
  // The day's cap on public checks that use the Agent; the admin has none. The read here answers early;
  // the cap itself is held where the check is stored or queued, in the same statement.
  const agentCap = who.admin ? null : PUBLIC_AGENT_CHECKS_PER_DAY;
  if (agentFromStart && agentCap !== null && (await countPublicAgentChecksToday(env.DB)) >= agentCap) {
    throw new CheckRejected(429, { ...AGENT_CAP_BODY });
  }
  await countVisit();

  let id: string;
  let estimate: number;
  if (plan.by === "number" && recordUrl !== null) {
    id = await insertCheck(env.DB, { ...base, method: "fetch" });
    const how = await numberViaFetch(env, id, adapter, recordType, recordUrl, plan.number, agentCap);
    estimate = how === "page" ? FETCH_ESTIMATE_USD : AGENT_ESTIMATE_USD;
    if (how === "capped") {
      // The page could not be read and the Agent fallback would pass the day's public cap.
      await finishPendingCheck(env.DB, id, { outcome: "error", error: AGENT_CAP_BODY.error, spend_usd: 0 });
      throw new CheckRejected(429, { ...AGENT_CAP_BODY });
    }
    if (how === "queued") await pumpQueue(env, defer);
  } else if (plan.by === "name" && adapter.fetchSearch) {
    id = await insertCheck(env.DB, { ...base, method: "fetch" });
    await nameViaFetchSearch(env, id, adapter as RegistryAdapter & Required<Pick<RegistryAdapter, "fetchSearch">>, recordType, plan);
    estimate = FETCH_ESTIMATE_USD;
  } else {
    const queued = await enqueueAgentCheck(env, base, defer, agentCap);
    if (queued === null) {
      // Others took the day's last Agent checks while this request was on its way: it was not served,
      // so it does not count as one of the visitor's checks.
      if (!who.admin) await unbump(env.DB, who.ipHash, "checks");
      throw new CheckRejected(429, { ...AGENT_CAP_BODY });
    }
    id = queued;
    estimate = AGENT_ESTIMATE_USD;
  }

  const check = await getCheck(env.DB, id);
  const done = check?.state === "done";
  // A Fetch check is told here; so is a stored answer given because the register could not be read
  // (its method is that of the check that read it).
  if (done && check && (check.method === "fetch" || check.cached_from_check_id !== null)) await notifyFinished(env, check, defer);
  // A check that ended before its Agent run could start (`busy`) spent nothing and never will.
  if (done && check && check.method === "agent" && check.run_id === null && check.error !== "run_not_recorded") estimate = 0;
  return { checkId: id, status: done ? "done" : "pending", cached: false, estimatedCostUsd: estimate };
}
