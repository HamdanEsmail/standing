// Checks: one row per lookup, its candidates, the 24-hour cache lookup, and the purge of public
// lookups that nobody watches. Timestamps are ISO 8601 UTC strings from `toISOString()`, which
// sort the same as the instants they name, so SQL compares them as text.
import type { Flag } from "../core/status";
import type { RecordType, RegistryRow } from "../registries/types";
import { isoTime } from "./time";
import type { CandidateRow, CheckRow } from "./types";

type JsonColumn = "variants_tried" | "flags" | "suggestions";
const JSON_COLUMNS: ReadonlySet<string> = new Set<JsonColumn>(["variants_tried", "flags", "suggestions"]);

/** The fields a new check can carry. Everything is optional: `id` is generated, `started_at` is now,
 *  `state` is `pending`, `trigger` is `request`. The JSON columns are passed as arrays. A cached copy
 *  of an earlier result is born `done`, with that result's `checked_at`. */
export type NewCheck = Partial<Omit<CheckRow, JsonColumn>> & {
  variants_tried?: string[];
  flags?: Flag[];
  suggestions?: string[];
};

// Every column insertCheck writes. A key of the input that is not in this list is ignored, so a
// caller can never turn an object key into SQL.
const INSERT_COLUMNS = [
  "id", "state", "registry", "record_type", "jurisdiction", "profession", "query_raw", "query_normalized", "number",
  "cache_key", "variants_tried", "outcome", "status", "flags", "record_id", "run_id", "method", "cached_from_check_id",
  "evidence_key", "spend_usd", "callback_url", "candidates_total", "suggestions", "trigger", "monitor_run_id", "ip_hash",
  "added_by", "expires_at", "started_at", "checked_at", "error",
] as const satisfies readonly (keyof CheckRow)[];

// The columns finishCheck will write: what a check learns while it runs and when it ends. What the
// check was asked (registry, query, who asked) is fixed at insert.
const PATCH_COLUMNS = [
  "state", "outcome", "status", "flags", "variants_tried", "suggestions", "record_id", "run_id", "method",
  "evidence_key", "spend_usd", "candidates_total", "cache_key", "checked_at", "error", "cached_from_check_id",
] as const satisfies readonly (keyof CheckRow)[];

export type CheckPatch = Pick<NewCheck, (typeof PATCH_COLUMNS)[number]>;

/** The columns that hold a time: stored as `toISOString()` text whatever shape the caller gives. */
const TIME_COLUMNS: ReadonlySet<string> = new Set(["started_at", "checked_at", "expires_at"]);

/** `registry|record_type|profession|query or number`, lowercase, whitespace collapsed, a `|` inside a part
 *  turned into a space so it cannot move a boundary. The caller passes the number when it has one, else
 *  the normalized query. Example: `gmc|doctor||christopher wickfold`. */
export function cacheKey(
  registry: string,
  recordType: RecordType | string,
  normalizedOrNumber: string,
  profession?: string | null,
): string {
  const part = (s: string | null | undefined) => (s ?? "").replace(/\|/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return [registry, recordType, profession, normalizedOrNumber].map(part).join("|");
}

/**
 * The latest finished check for this cache key, read within the last `withinHours` hours, whose
 * outcome is `match`, `ambiguous` or `no_match` (an `error`, an `unsupported` and a pending check are
 * never served). A `match` is skipped when its record has had a `status_change` event after the check
 * was read, so a cached result never pairs its old `checked_at` with facts read later; the one
 * exception is a change reported by the check's own Monitor run, which is what that check read.
 * The filter runs before the `LIMIT`, so an older check that is still true can be served instead.
 * The row's `checked_at` is the time it was read, not now.
 */
export function findCached(db: D1Database, key: string, withinHours: number): Promise<CheckRow | null> {
  const cutoff = new Date(Date.now() - withinHours * 3_600_000).toISOString();
  return db
    .prepare(
      `SELECT c.* FROM checks c
       WHERE c.cache_key = ?1
         AND c.state = 'done'
         AND c.outcome IN ('match', 'ambiguous', 'no_match')
         AND c.checked_at >= ?2
         AND ${NOT_STALE}
       ORDER BY c.checked_at DESC, c.started_at DESC, c.rowid DESC
       LIMIT 1`,
    )
    .bind(key, cutoff)
    .first<CheckRow>();
}

/** A match whose record has had a status_change after it was read (other than one its own Monitor run
 *  reported) is stale: its old read time would pair with facts read later. */
const NOT_STALE = `NOT (
           c.outcome = 'match' AND c.record_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM events e
             WHERE e.record_id = c.record_id AND e.kind = 'status_change' AND e.at > c.checked_at
               AND NOT COALESCE(e.monitor_run_id = c.monitor_run_id, 0)
           )
         )`;

/** A check that is not a stored answer given because a live read failed (that row keeps the failed
 *  read's code in `error` beside an outcome that is not `error`). */
export const NOT_FALLBACK = "(error IS NULL OR outcome = 'error')";

/**
 * The last result Standing read for this question, however old, for when the register cannot be read
 * now: the newest finished match, ambiguous or no_match for the cache key (`{ key }`), or the newest
 * match of a record (`{ recordId }`), never a stale match (as findCached). Null when there is none.
 */
export function lastResult(db: D1Database, by: { key: string } | { recordId: string }): Promise<CheckRow | null> {
  const where = "key" in by ? "c.cache_key = ?1 AND c.outcome IN ('match', 'ambiguous', 'no_match')" : "c.record_id = ?1 AND c.outcome = 'match'";
  return db
    .prepare(
      `SELECT c.* FROM checks c
       WHERE ${where}
         AND c.state = 'done'
         AND c.checked_at IS NOT NULL
         AND ${NOT_STALE}
       ORDER BY c.checked_at DESC, c.started_at DESC, c.rowid DESC
       LIMIT 1`,
    )
    .bind("key" in by ? by.key : by.recordId)
    .first<CheckRow>();
}

/**
 * The same request from the same caller (`ipHash`, or the admin when null) started since `sinceIso`:
 * a form post sent again (a reload, a double click) finds the check it already started. Null if none.
 * `readOnly`: only a check that read the register itself, never a cached copy (a "Fresh check" right
 * after a stored result must read the register, not open that stored copy again).
 */
export function recentSameRequest(
  db: D1Database,
  key: string,
  ipHash: string | null,
  sinceIso: string,
  readOnly = false,
): Promise<{ id: string; state: string | null } | null> {
  return db
    .prepare(
      `SELECT id, state FROM checks
       WHERE cache_key = ?1 AND trigger = 'request' AND started_at >= ?3
         AND (ip_hash = ?2 OR (?2 IS NULL AND ip_hash IS NULL AND added_by = 'admin'))
         AND (?4 = 0 OR cached_from_check_id IS NULL)
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(key, ipHash, sinceIso, readOnly ? 1 : 0)
    .first<{ id: string; state: string | null }>();
}

/**
 * A stored answer of this outcome to show as an example (the API page, the home): a company's, so no
 * person is named, one that does not expire first, then the newest. An ambiguous example must have a
 * candidate whose name starts with what was searched, so a search for nonsense (the register then lists
 * its nearest names) is never the example. Null when none is stored.
 */
export function sampleCheck(db: D1Database, outcome: "match" | "ambiguous" | "no_match", durableOnly = false): Promise<CheckRow | null> {
  return db
    .prepare(
      `SELECT * FROM checks c WHERE state = 'done' AND outcome = ?1 AND record_type = 'company' AND (?2 = 0 OR expires_at IS NULL) AND ${NOT_FALLBACK}
         AND (outcome != 'ambiguous' OR EXISTS (
           SELECT 1 FROM candidates k WHERE k.check_id = c.id AND upper(k.full_name) LIKE upper(trim(c.query_raw)) || '%'
         ))
       ORDER BY (expires_at IS NULL) DESC, checked_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(outcome, durableOnly ? 1 : 0)
    .first<CheckRow>();
}

/** A new check's column values, in INSERT_COLUMNS order (the id first). */
function insertValues(row: NewCheck): unknown[] {
  const defaults: Record<string, unknown> = {
    id: crypto.randomUUID(),
    state: "pending",
    trigger: "request",
    started_at: new Date().toISOString(),
  };
  const input = row as Record<string, unknown>;
  return INSERT_COLUMNS.map((column) => {
    const value = input[column];
    if (JSON_COLUMNS.has(column)) return JSON.stringify(Array.isArray(value) ? value : []);
    if (TIME_COLUMNS.has(column) && typeof value === "string") return isoTime(value);
    return value ?? defaults[column] ?? null;
  });
}

/** Inserts a check and returns its id. */
export async function insertCheck(db: D1Database, row: NewCheck): Promise<string> {
  const values = insertValues(row);
  await db
    .prepare(`INSERT INTO checks (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})`)
    .bind(...values)
    .run();
  return String(values[0]);
}

/** Today's public checks that hold one of the day's Agent checks: they started a run or wait for one.
 *  One bind: the start of the UTC day. */
const HOLDS_AGENT_CHECK = `added_by = 'public' AND trigger = 'request' AND method = 'agent' AND cached_from_check_id IS NULL
  AND started_at >= ? AND (run_id IS NOT NULL OR state = 'pending')`;

function utcDayStart(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Inserts a public check that needs the Agent only while fewer than `cap` of today's public checks
 * hold one of the day's Agent checks. The count and the insert are one statement, so of any number of
 * requests arriving together only as many as fit are stored. Returns the id, or null when the day's
 * checks are used.
 */
export async function insertCheckUnderAgentCap(db: D1Database, row: NewCheck, cap: number): Promise<string | null> {
  const values = insertValues(row);
  const result = await db
    .prepare(
      `INSERT INTO checks (${INSERT_COLUMNS.join(", ")}) SELECT ${INSERT_COLUMNS.map(() => "?").join(", ")}
       WHERE (SELECT COUNT(*) FROM checks WHERE ${HOLDS_AGENT_CHECK}) < ?`,
    )
    .bind(...values, utcDayStart(), cap)
    .run();
  return result.meta.changes > 0 ? String(values[0]) : null;
}

export function getCheck(db: D1Database, id: string): Promise<CheckRow | null> {
  return db.prepare("SELECT * FROM checks WHERE id = ?").bind(id).first<CheckRow>();
}

export function getCheckByRunId(db: D1Database, runId: string): Promise<CheckRow | null> {
  return db.prepare("SELECT * FROM checks WHERE run_id = ?").bind(runId).first<CheckRow>();
}

/** The UPDATE for a patch: the whitelisted columns, `state = 'done'` unless the patch gives a state, and
 *  `checked_at` stamped with now when the check ends `done` without one. With `pendingOnly` it applies
 *  only while the check is still `pending`. Throws before touching the database on a bad timestamp. */
function patchStatement(db: D1Database, id: string, patch: CheckPatch, pendingOnly: boolean): D1PreparedStatement {
  const sets: string[] = [];
  const values: unknown[] = [];
  const given = patch as Record<string, unknown>;
  for (const column of PATCH_COLUMNS) {
    const value = given[column];
    if (value === undefined) continue;
    if (JSON_COLUMNS.has(column)) {
      if (!Array.isArray(value)) continue;
      sets.push(`${column} = ?`);
      values.push(JSON.stringify(value));
    } else {
      sets.push(`${column} = ?`);
      values.push(TIME_COLUMNS.has(column) && typeof value === "string" ? isoTime(value) : value);
    }
  }
  if (patch.state === undefined) sets.push("state = 'done'");
  if (patch.checked_at === undefined && (patch.state === undefined || patch.state === "done")) {
    sets.push("checked_at = COALESCE(checked_at, ?)");
    values.push(new Date().toISOString());
  }
  return db
    .prepare(`UPDATE checks SET ${sets.join(", ")} WHERE id = ?${pendingOnly ? " AND state = 'pending'" : ""}`)
    .bind(...values, id);
}

/**
 * Writes the patch to the check and, unless the patch gives another `state`, marks it `done`. A check
 * that ends up `done` without a `checked_at` (an error, say) is stamped with now; a `checked_at` that is
 * already set is never moved. Columns not in the whitelist are ignored; the JSON columns are passed as arrays.
 * Times are stored as millisecond ISO strings (see `isoTime`). This writes whatever the state is: to finish
 * a check exactly once, use `finishPendingCheck`.
 */
export async function finishCheck(db: D1Database, id: string, patch: CheckPatch): Promise<void> {
  await patchStatement(db, id, patch, false).run();
}

/**
 * `finishCheck` for a check that is still `pending`: one UPDATE with `WHERE id = ? AND state = 'pending'`,
 * resolving to whether it applied. Of two racing callbacks for the same run, exactly one gets `true` and
 * only its patch is stored; a check that is already `done` (or unknown) is left alone and gets `false`.
 *
 * `candidates` (an ambiguous result's rows, in the order given) are stored in the same transaction, each
 * insert guarded by the check still being `pending`, so a reader never sees an ambiguous check without
 * its candidates and a racing duplicate stores none.
 */
export async function finishPendingCheck(
  db: D1Database,
  id: string,
  patch: CheckPatch,
  candidates: RegistryRow[] = [],
): Promise<boolean> {
  const update = patchStatement(db, id, patch, true);
  if (candidates.length === 0) return (await update.run()).meta.changes > 0;
  const inserts = candidates.map((row, position) =>
    db
      .prepare(
        `INSERT INTO candidates (check_id, position, licence_number, full_name, status_raw, detail, source_url)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM checks WHERE id = ? AND state = 'pending')`,
      )
      .bind(id, position, row.number, row.name, row.status_raw, row.detail, row.url, id),
  );
  const results = await db.batch([...inserts, update]);
  return (results[results.length - 1]?.meta.changes ?? 0) > 0;
}

/** Stores the registry rows of an ambiguous check at positions 0..n-1 in the order given (the classifier
 *  has already put the exact-name rows first); it does not re-sort. */
export async function insertCandidates(db: D1Database, checkId: string, rows: RegistryRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(
    rows.map((row, position) =>
      db
        .prepare(
          `INSERT INTO candidates (check_id, position, licence_number, full_name, status_raw, detail, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(checkId, position, row.number, row.name, row.status_raw, row.detail, row.url),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// The Agent queue (one run in flight; see src/checks/queue.ts)

/** The oldest queued check: `pending`, waiting for the Agent (`method = 'agent'`) and with no run yet.
 *  A Fetch-path check is `pending` with no run while its request reads the registry, so `method` is
 *  what keeps the queue from starting a run for it. Oldest by `started_at`, then insertion order. */
export function nextQueuedCheck(db: D1Database): Promise<CheckRow | null> {
  return db
    .prepare(
      `SELECT * FROM checks WHERE state = 'pending' AND run_id IS NULL AND method = 'agent'
       ORDER BY started_at, rowid LIMIT 1`,
    )
    .first<CheckRow>();
}

/** Puts a pending check without a run into the Agent queue (a Fetch-path check falling back to an
 *  Agent search). With `cap` (a public check), only while fewer than `cap` other public checks hold
 *  one of the day's Agent checks: the count and the change are one statement, and until it succeeds the
 *  check is not `method = 'agent'`, so nothing can start a run for it. False when the check is not
 *  pending, already has a run, or the day's checks are used. */
export async function markQueued(db: D1Database, id: string, cap: number | null = null): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE checks SET method = 'agent' WHERE id = ?1 AND state = 'pending' AND run_id IS NULL
         AND (?2 IS NULL OR (SELECT COUNT(*) FROM checks c WHERE c.added_by = 'public' AND c.trigger = 'request' AND c.method = 'agent'
               AND c.cached_from_check_id IS NULL AND c.started_at >= ?3 AND (c.run_id IS NOT NULL OR c.state = 'pending') AND c.id IS NOT ?1) < ?2)`,
    )
    .bind(id, cap, utcDayStart())
    .run();
  return result.meta.changes > 0;
}

/**
 * Sends a NAME check whose run has settled back to the Agent queue for one search by `number`: the
 * run matched a row by name but neither a record page nor an opened entry showed its status (a results
 * row is never enough for a status). One guarded UPDATE: only while the check is pending with that run, and only once
 * (`number IS NULL`, so the number run never falls back again). `number` becomes the number searched,
 * `run_id` is cleared so the queue picks the check up, and the first run's `variants_tried` and cost
 * (`spend_usd`) are carried over.
 */
export async function requeueByNumber(
  db: D1Database,
  id: string,
  runId: string,
  number: string,
  carry: { variants_tried: string[]; spend_usd: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE checks SET number = ?, run_id = NULL, method = 'agent', variants_tried = ?, spend_usd = ?
       WHERE id = ? AND state = 'pending' AND run_id = ? AND number IS NULL`,
    )
    .bind(number, JSON.stringify(carry.variants_tried), carry.spend_usd, id, runId)
    .run();
  return result.meta.changes > 0;
}

/** Records the run started for a queued check. Only a pending check without a run takes one, so a
 *  run id is never overwritten. */
export async function setRunId(db: D1Database, id: string, runId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE checks SET run_id = ? WHERE id = ? AND state = 'pending' AND run_id IS NULL")
    .bind(runId, id)
    .run();
  return result.meta.changes > 0;
}

/** Copies one check's candidates, positions and all, to another check (a cached copy of an ambiguous
 *  result). One statement, so the copy is exact. */
export async function copyCandidates(db: D1Database, fromCheckId: string, toCheckId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO candidates (check_id, position, licence_number, full_name, status_raw, detail, source_url)
       SELECT ?, position, licence_number, full_name, status_raw, detail, source_url FROM candidates WHERE check_id = ?`,
    )
    .bind(toCheckId, fromCheckId)
    .run();
}

export async function listCandidates(db: D1Database, checkId: string): Promise<CandidateRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM candidates WHERE check_id = ? ORDER BY position")
    .bind(checkId)
    .all<CandidateRow>();
  return results;
}

// ---------------------------------------------------------------------------------------------
// Purging public lookups nobody watches (spec 4.7)

/** SQL, for a checks alias `a` and the cutoff bound as `?1`: a public check started before the cutoff
 *  whose record is not watched (or that has no record). `COALESCE` makes an unknown (a missing
 *  `started_at`, say) count as "does not expire", so the negated form below never drops a check by accident. */
const expiring = (a: string) =>
  `COALESCE(${a}.added_by = 'public' AND ${a}.started_at < ?1 AND NOT EXISTS (SELECT 1 FROM records w WHERE w.id = ${a}.record_id AND w.watched = 1), 0)`;

/** SQL, for a records alias `r`: an unwatched record that an expiring check references and that no remaining
 *  check of any kind references (so a curated or admin check keeps it). */
const deletableRecord = (r: string) =>
  `${r}.watched = 0
     AND ${r}.id IN (SELECT c.record_id FROM checks c WHERE c.record_id IS NOT NULL AND ${expiring("c")})
     AND NOT EXISTS (SELECT 1 FROM checks k WHERE k.record_id = ${r}.id AND NOT ${expiring("k")})`;

const EVIDENCE_EXTENSION = /\.(jpg|md)$/;
const KEYS_PER_LOOKUP = 200;

/** The R2 keys of one check's evidence: its screenshot and the markdown that sits beside it. */
function evidenceKeysOf(key: string): string[] {
  const base = key.replace(EVIDENCE_EXTENSION, "");
  return base === key ? [key] : [`${base}.jpg`, `${base}.md`];
}

/**
 * Deletes the public checks started before `olderThanIso` whose record is not watched, with their
 * candidates, and the records those checks leave unreferenced (unwatched, and no remaining check of any
 * kind references them), with those records' events so none is left pointing at a dead record. Admin and
 * curated checks never expire, and a record they reference stays. One transaction, with the selection
 * done inside it, so a record watched a moment ago is not purged.
 *
 * Returns the ids deleted and the R2 keys to delete: the screenshot and markdown of each deleted
 * check's `evidence_key` and of each deleted record's `evidence_key` (a record keeps the key of the last
 * read that had a screenshot, which can be a check that expired earlier), except any still named by a
 * remaining check (a cached check copies the original's key) or a remaining record. A key is taken from
 * the `evidence_key` value, not the check's own id, so the last holder of a copied key releases it.
 * The cutoff is read as a time, whatever its shape; an unparseable one throws.
 */
export async function expirePublicChecks(
  db: D1Database,
  olderThanIso: string,
): Promise<{ ids: string[]; evidenceKeys: string[] }> {
  olderThanIso = isoTime(olderThanIso);
  const deleteEvents = db
    .prepare(`DELETE FROM events WHERE record_id IN (SELECT r.id FROM records r WHERE ${deletableRecord("r")})`)
    .bind(olderThanIso);
  const deleteRecords = db
    .prepare(`DELETE FROM records WHERE id IN (SELECT r.id FROM records r WHERE ${deletableRecord("r")}) RETURNING id, evidence_key`)
    .bind(olderThanIso);
  const deleteCandidates = db
    .prepare(`DELETE FROM candidates WHERE check_id IN (SELECT c.id FROM checks c WHERE ${expiring("c")})`)
    .bind(olderThanIso);
  const deleteChecks = db
    .prepare(`DELETE FROM checks WHERE id IN (SELECT c.id FROM checks c WHERE ${expiring("c")}) RETURNING id, evidence_key`)
    .bind(olderThanIso);

  // The events and records go first and the checks last: those statements read the checks to find what is left.
  const [, deletedRecords, , deleted] = await db.batch<{ id: string; evidence_key: string | null }>([
    deleteEvents,
    deleteRecords,
    deleteCandidates,
    deleteChecks,
  ]);
  const removed = deleted?.results ?? [];

  const candidateKeys = [
    ...new Set(
      [...removed, ...(deletedRecords?.results ?? [])].flatMap((r) => (r.evidence_key ? evidenceKeysOf(r.evidence_key) : [])),
    ),
  ];
  const stillUsed = new Set<string>();
  for (let i = 0; i < candidateKeys.length; i += KEYS_PER_LOOKUP) {
    const { results } = await db
      .prepare(
        `SELECT evidence_key AS key FROM checks WHERE evidence_key IN (SELECT value FROM json_each(?1))
         UNION
         SELECT evidence_key AS key FROM records WHERE evidence_key IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(candidateKeys.slice(i, i + KEYS_PER_LOOKUP)))
      .all<{ key: string }>();
    for (const { key } of results) stillUsed.add(key.replace(EVIDENCE_EXTENSION, ""));
  }

  return {
    ids: removed.map((r) => r.id).sort(),
    evidenceKeys: candidateKeys.filter((key) => !stillUsed.has(key.replace(EVIDENCE_EXTENSION, ""))).sort(),
  };
}

/**
 * Public checks of the current UTC day that started an Agent run or are waiting for one (request
 * checks only: cache copies, Fetch reads that never queued, checks that ended before a run and admin
 * or Monitor checks do not count), not counting `excludeId`. Behind PUBLIC_AGENT_CHECKS_PER_DAY.
 */
export async function countPublicAgentChecksToday(db: D1Database, excludeId: string | null = null): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM checks WHERE ${HOLDS_AGENT_CHECK} AND id IS NOT ?`)
    .bind(utcDayStart(), excludeId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Whether a record already has a Monitor re-check waiting or running (the re-check fan-out guard). */
export async function hasPendingRecheck(db: D1Database, recordId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM checks WHERE record_id = ? AND trigger = 'monitor' AND state = 'pending' LIMIT 1")
    .bind(recordId)
    .first<{ x: number }>();
  return row !== null;
}

/** The latest finished match check of a record (what GET /api/records/:id builds on), or null. A stored
 *  answer given because a live read failed is skipped: it repeats an earlier check. */
export function latestMatchCheck(db: D1Database, recordId: string): Promise<CheckRow | null> {
  return db
    .prepare(`SELECT * FROM checks WHERE record_id = ? AND state = 'done' AND outcome = 'match' AND ${NOT_FALLBACK} ORDER BY checked_at DESC, rowid DESC LIMIT 1`)
    .bind(recordId)
    .first<CheckRow>();
}

/** The profession the record was last checked with (DCA re-checks need it), or null. */
export async function professionOfRecord(db: D1Database, recordId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT profession FROM checks WHERE record_id = ? AND profession IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .bind(recordId)
    .first<{ profession: string }>();
  return row?.profession ?? null;
}
