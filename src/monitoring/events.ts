// Events on watched records (spec 4.6): what a Monitor run, or the Agent re-check it triggered,
// found. A status_change is written only when the normalized status, flags, disciplinary entries or
// status text really differ (recordDiff); an identical re-read is a recheck.
import { toPublicRecord, type RecordResult } from "../core/schema";
import { enqueueMonitorRecheck } from "../checks/queue";
import { callbackUrlAllowed, type Defer } from "../checks/view";
import { hasPendingRecheck, latestMatchCheck, professionOfRecord } from "../db/checks";
import { insertEvent, setEventNotified, type NewEvent } from "../db/events";
import { comparableView, getRecord, recordRowDiff } from "../db/records";
import type { CheckRow, EventRow, RecordRow, WatchRow } from "../db/types";
import { activeWatchForRecord } from "../db/watches";
import type { Env } from "../env";
import { getAdapterById } from "../registries/index";
import { dropForRecord } from "../site/htmlCache";

/**
 * The public record of a stored record as it stands now: the latest match check gives the query,
 * method and spend fields; the record's own current status, flags and evidence override the check's
 * (a Monitor re-read may have moved them on since).
 */
export function recordView(env: Env, record: RecordRow, check: CheckRow | null, watch: WatchRow | null): RecordResult {
  const base: CheckRow = check ?? {
    id: record.id,
    state: "done",
    registry: record.registry,
    record_type: record.record_type,
    jurisdiction: null,
    profession: null,
    query_raw: null,
    query_normalized: null,
    number: record.licence_number,
    cache_key: null,
    variants_tried: "[]",
    outcome: "match",
    status: null,
    flags: "[]",
    record_id: record.id,
    run_id: null,
    method: null,
    cached_from_check_id: null,
    evidence_key: null,
    spend_usd: 0,
    callback_url: null,
    candidates_total: null,
    suggestions: "[]",
    trigger: "request",
    monitor_run_id: null,
    ip_hash: null,
    added_by: null,
    expires_at: null,
    started_at: null,
    checked_at: null,
    error: null,
  };
  const current: CheckRow = {
    ...base,
    outcome: "match",
    status: record.status,
    flags: record.flags,
    evidence_key: record.evidence_key ?? base.evidence_key,
    checked_at: record.last_checked_at ?? base.checked_at,
    cached_from_check_id: null,
  };
  const w = watch !== null && (watch.kind === "page" || watch.kind === "topic") ? { watch_id: watch.id, kind: watch.kind } : null;
  return toPublicRecord(current, record, [], env.PUBLIC_BASE_URL, w);
}

/** The record's public view, built from the database. */
export async function recordViewById(env: Env, recordId: string): Promise<RecordResult | null> {
  const record = await getRecord(env.DB, recordId);
  if (record === null) return null;
  return recordView(env, record, await latestMatchCheck(env.DB, record.id), await activeWatchForRecord(env.DB, record.id));
}

/** One event as the API shows it. */
export function eventJson(e: EventRow): {
  id: string;
  at: string | null;
  kind: EventRow["kind"];
  before: unknown;
  after: unknown;
  fields: string[];
  source_url: string | null;
  monitor_run_id: string | null;
} {
  const parse = (text: string | null): unknown => {
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const fields = parse(e.fields);
  return {
    id: e.id,
    at: e.at,
    kind: e.kind,
    before: parse(e.before),
    after: parse(e.after),
    fields: Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [],
    source_url: e.source_url,
    monitor_run_id: e.monitor_run_id,
  };
}

const CALLBACK_TIMEOUT_MS = 5_000;

/** POSTs `{ event, record }` to the watch's callback_url (https, another host; 5 s; best effort) and
 *  stamps `notified_at` on a 2xx. */
async function postEvent(env: Env, callbackUrl: string, eventId: string, recordId: string): Promise<void> {
  try {
    const event = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<EventRow>();
    const record = await recordViewById(env, recordId);
    if (event === null || record === null) return;
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: eventJson(event), record }),
      redirect: "manual",
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (res.ok) await setEventNotified(env.DB, eventId, new Date().toISOString());
  } catch {
    console.error("event callback failed");
  }
}

/** Writes an event, and tells the record's watch callback about it (in `defer` when given). */
export async function writeEvent(env: Env, e: NewEvent & { record_id: string }, defer?: Defer): Promise<string> {
  const id = await insertEvent(env.DB, e);
  // The site's stored screens that show this record (an R2 delete, after the response when deferred).
  const drop = dropForRecord(env, e.record_id);
  if (defer) defer(drop);
  else await drop;
  const watch = await activeWatchForRecord(env.DB, e.record_id);
  const url = watch?.callback_url ?? null;
  if (url !== null && callbackUrlAllowed(env, url)) {
    const work = postEvent(env, url, id, e.record_id);
    if (defer) defer(work);
    else await work;
  }
  return id;
}

/**
 * One Agent re-check of a record for a Monitor run (by its number, else its exact name), unless one is
 * already queued or running for it (the fan-out guard). It goes through the single-slot queue and the
 * spend pause like every check. Returns the check id, or null when none was queued.
 */
export async function requestRecheck(env: Env, record: RecordRow, monitorRunId: string | null, defer?: Defer): Promise<string | null> {
  if (await hasPendingRecheck(env.DB, record.id)) return null;
  // A register read only with Fetch (Companies House, Sunbiz) is never searched by the Agent: its watch
  // re-reads the page itself on the next Monitor run.
  const adapter = record.registry === null ? null : getAdapterById(record.registry);
  if (adapter === null || adapter.coverage.lookup === "fetch") return null;
  const profession = await professionOfRecord(env.DB, record.id);
  return enqueueMonitorRecheck(env, record, monitorRunId, profession === null ? {} : { profession }, defer);
}

/**
 * The event a finished Monitor re-check writes (called once, by the call that settled it). A match on
 * the same record compares the record before and after the run: a real difference is a status_change
 * with the comparable fields, otherwise a recheck. Any other outcome is a notice that says what the
 * re-check found; the record is left as it was (an ambiguous re-check never erases a record).
 */
export async function eventForRecheck(
  env: Env,
  check: CheckRow,
  settled: { outcome: CheckRow["outcome"]; recordId: string | null; before: RecordRow | null },
  defer?: Defer,
): Promise<void> {
  if (check.trigger !== "monitor" || check.record_id === null) return;
  const recordId = check.record_id;
  const done = await env.DB.prepare("SELECT * FROM checks WHERE id = ?").bind(check.id).first<CheckRow>();
  const base = { record_id: recordId, monitor_run_id: check.monitor_run_id };
  if (settled.outcome === "match" && settled.recordId === recordId && settled.before !== null) {
    const after = await getRecord(env.DB, recordId);
    if (after === null) return;
    const diff = recordRowDiff(settled.before, after);
    await writeEvent(
      env,
      diff.changed
        ? { ...base, kind: "status_change", before: comparableView(settled.before), after: comparableView(after), fields: diff.fields, source_url: after.source_url }
        : { ...base, kind: "recheck", after: comparableView(after), source_url: after.source_url },
      defer,
    );
    return;
  }
  await writeEvent(
    env,
    { ...base, kind: "notice", after: { recheck_outcome: settled.outcome, error: done?.error ?? null }, source_url: null },
    defer,
  );
}
