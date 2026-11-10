// What one Monitor run means for Standing (spec 4.6), called by POST /hooks/monitor/:secret after the
// secret. The raw payload is stored first (R2 `raw/monitor/<run id>.json`, the fixture source after
// deploy); a run already stored is a duplicate delivery and does nothing else.
//
// - Page watch, outcome `changed`: the record page is read again with Fetch. A real difference
//   (recordDiff) is a status_change, an identical re-read a recheck. A read that fails or lacks the
//   status line never writes a status_change: one Agent re-check by number decides.
// - Topic watch with new results: one notice per new result URL, and one Agent re-check.
// - Shared decision page, outcome `changed`: the diff's added lines are scanned for each watched record
//   of that registry (its number, or its given name and surname as whole words); each hit is a notice
//   and one Agent re-check.
// - Anything else: the run's spend only.
import { normalizePerson } from "../core/names";
import { PRICES, recordSpend } from "../core/spend";
import { normalizePage, readRecordPage, todayIso } from "../checks/record";
import type { Defer } from "../checks/view";
import { getRecord, recordDiff, upsertRecord, comparableView } from "../db/records";
import type { RecordRow, SharedMonitorRow, WatchRow } from "../db/types";
import { getSharedMonitorByMonitorId, getWatchByMonitorId } from "../db/watches";
import type { Env } from "../env";
import { getAdapterById } from "../registries/index";
import { requestRecheck, writeEvent } from "./events";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** The parts of a Monitor payload Standing reads, from the top level or a nested `run`. */
export interface MonitorPayload {
  monitorId: string | null;
  runId: string | null;
  outcome: string | null;
  diff: string;
  /** New results of a Topic run: `{ url, title }` per new result position. */
  newResults: { url: string; title: string | null }[];
}

/** Reads a payload tolerantly (the Monitor payload names its ids in more than one way): Page by `fetch_monitor_id`; Topic by `search_monitor_id`,
 *  else `monitor_id`, else the id inside `request_id` "search-monitor:<id>:run:<id>". The run id is
 *  `id`, else the run part of `request_id`. */
export function readMonitorPayload(data: unknown): MonitorPayload {
  const layers = [data, isRecord(data) ? data.run : undefined].filter(isRecord);
  const pick = (key: string): unknown => {
    for (const layer of layers) if (layer[key] !== undefined && layer[key] !== null) return layer[key];
    return undefined;
  };
  const requestId = str(pick("request_id"));
  const fromRequest = requestId === null ? null : /^search-monitor:([^:]+):run:([^:]+)$/.exec(requestId);
  const monitorId = str(pick("fetch_monitor_id")) ?? str(pick("search_monitor_id")) ?? str(pick("monitor_id")) ?? fromRequest?.[1] ?? null;
  const runId = str(pick("id")) ?? fromRequest?.[2] ?? null;

  const results = pick("results");
  const positions = pick("new_result_positions");
  const newResults: { url: string; title: string | null }[] = [];
  if (Array.isArray(results) && Array.isArray(positions)) {
    // TinyFish documents each result with its own `position` (its rank in the search, counted from 1)
    // and `new_result_positions` as the positions of the new ones, so a new result is found by its
    // position, never by counting along the list. Only a payload whose results carry no position is
    // read by place in the list, from 0. No real Topic webhook with a new result has arrived yet.
    const ranked = results.some((r) => isRecord(r) && typeof r.position === "number");
    for (const p of positions) {
      if (typeof p !== "number" || !Number.isInteger(p)) continue;
      const item = ranked ? results.find((r) => isRecord(r) && r.position === p) : results[p];
      const url = isRecord(item) ? str(item.url) : null;
      if (url !== null && /^https?:\/\//i.test(url) && !newResults.some((r) => r.url === url)) {
        newResults.push({ url, title: isRecord(item) ? str(item.title) : null });
      }
    }
  }
  const diff = pick("diff");
  return { monitorId, runId, outcome: str(pick("outcome")), diff: typeof diff === "string" ? diff : "", newResults };
}

/** The lines a diff added (`+` lines, not the `+++` header). */
export function addedLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1).trim())
    .filter((l) => l !== "");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (word: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(word)}(?=$|[^\\p{L}\\p{N}])`, "iu");

/** Whether an added line names this record: its registration number, or both its given name and its
 *  surname as whole words (a surname alone is not enough). */
export function lineNamesRecord(line: string, record: Pick<RecordRow, "licence_number" | "full_name">): boolean {
  const number = record.licence_number?.trim();
  if (number && wholeWord(number).test(line)) return true;
  if (!record.full_name) return false;
  const p = normalizePerson(record.full_name);
  if (p.given === "" || p.surname === "") return false;
  return wholeWord(p.given).test(line) && p.surname.split(" ").every((part) => wholeWord(part).test(line));
}

export type HookResult =
  | { status: 404; body: null }
  | { status: 404 | 400; body: { error: string } }
  | { status: 200; body: { ok: true; [key: string]: unknown } };

const RUN_ID = /^[A-Za-z0-9:_-]{1,200}$/;

/** Handles one payload (the secret was already checked). */
export async function handleMonitorPayload(env: Env, data: unknown, defer?: Defer): Promise<HookResult> {
  const p = readMonitorPayload(data);
  if (p.monitorId === null || p.runId === null || !RUN_ID.test(p.runId)) return { status: 400, body: { error: "invalid_payload" } };
  const watch = await getWatchByMonitorId(env.DB, p.monitorId);
  const shared = watch === null ? await getSharedMonitorByMonitorId(env.DB, p.monitorId) : null;
  if (watch === null && shared === null) return { status: 404, body: { error: "unknown_monitor" } };

  const key = `raw/monitor/${p.runId}.json`;
  if ((await env.STORE.head(key)) !== null) return { status: 200, body: { ok: true, duplicate: true } };
  await env.STORE.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
  await recordSpend(env.DB, "monitor_check", PRICES.monitor_check, p.monitorId);

  if (watch !== null) {
    if (watch.status !== "active" || watch.record_id === null) return { status: 200, body: { ok: true, ignored: "watch_not_active" } };
    const record = await getRecord(env.DB, watch.record_id);
    if (record === null) return { status: 200, body: { ok: true, ignored: "record_gone" } };
    return watch.kind === "page" ? pageRun(env, watch, record, p, defer) : topicRun(env, record, p, defer);
  }
  return sharedRun(env, shared!, p, defer);
}

async function pageRun(env: Env, watch: WatchRow, record: RecordRow, p: MonitorPayload, defer?: Defer): Promise<HookResult> {
  if (p.outcome !== "changed") return { status: 200, body: { ok: true, outcome: p.outcome } };
  const adapter = record.registry === null ? null : getAdapterById(record.registry);
  const url = record.source_url;
  const read = adapter === null || url === null ? ({ ok: false } as const) : await readRecordPage(env, adapter, url, record.licence_number);
  if (adapter === null || url === null || !read.ok) {
    // The page did not show its name and status line: never a status_change from it.
    const recheck = await requestRecheck(env, record, p.runId, defer);
    return { status: 200, body: { ok: true, recheck } };
  }
  const { record: after, restrictions } = normalizePage(adapter, read.parsed, url, todayIso());
  const diff = recordDiff(record, after);
  await upsertRecord(env.DB, {
    id: record.id,
    registry: adapter.id,
    record_type: record.record_type ?? adapter.recordTypes[0]!,
    record: after,
    source_url: url,
    restrictions,
    checked_at: read.readAt,
  });
  const refreshed = (await getRecord(env.DB, record.id)) ?? record;
  const base = { record_id: record.id, monitor_run_id: p.runId, source_url: url };
  const eventId = diff.changed
    ? await writeEvent(env, { ...base, kind: "status_change", before: comparableView(record), after: comparableView(refreshed), fields: diff.fields }, defer)
    : await writeEvent(env, { ...base, kind: "recheck", after: comparableView(refreshed) }, defer);
  return { status: 200, body: { ok: true, event: diff.changed ? "status_change" : "recheck", event_id: eventId, watch_id: watch.id } };
}

async function topicRun(env: Env, record: RecordRow, p: MonitorPayload, defer?: Defer): Promise<HookResult> {
  if (p.newResults.length === 0) return { status: 200, body: { ok: true, notices: 0 } };
  for (const r of p.newResults) {
    await writeEvent(env, { record_id: record.id, kind: "notice", after: { url: r.url, title: r.title }, source_url: r.url, monitor_run_id: p.runId }, defer);
  }
  const recheck = await requestRecheck(env, record, p.runId, defer);
  return { status: 200, body: { ok: true, notices: p.newResults.length, recheck } };
}

async function sharedRun(env: Env, shared: SharedMonitorRow, p: MonitorPayload, defer?: Defer): Promise<HookResult> {
  if (p.outcome !== "changed") return { status: 200, body: { ok: true, outcome: p.outcome } };
  const lines = addedLines(p.diff);
  const { results: watched } = await env.DB.prepare("SELECT * FROM records WHERE registry = ? AND watched = 1").bind(shared.registry).all<RecordRow>();
  let hits = 0;
  for (const record of watched) {
    const line = lines.find((l) => lineNamesRecord(l, record));
    if (line === undefined) continue;
    hits++;
    await writeEvent(env, { record_id: record.id, kind: "notice", after: { line: line.slice(0, 500) }, source_url: shared.url, monitor_run_id: p.runId }, defer);
    await requestRecheck(env, record, p.runId, defer);
  }
  return { status: 200, body: { ok: true, hits } };
}
