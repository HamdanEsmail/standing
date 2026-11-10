// Events: what Monitor caught on a record. Only watched or curated records ever have a feed.
import { WATCHED_OR_CURATED } from "./records";
import { isoTime, isoTimeOrNull } from "./time";
import type { EventRow } from "./types";

export interface NewEvent {
  id?: string;
  record_id: string | null;
  kind: "status_change" | "notice" | "recheck";
  /** The names of the fields that changed. */
  fields?: string[];
  /** Stored as JSON text. */
  before?: unknown;
  after?: unknown;
  source_url?: string | null;
  monitor_run_id?: string | null;
  notified_at?: string | null;
  /** Defaults to now. */
  at?: string;
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Inserts an event and returns its id. `before`, `after` and `fields` are stringified here; `at` and
 *  `notified_at` are stored as millisecond ISO (an unparseable time throws). */
export async function insertEvent(db: D1Database, e: NewEvent): Promise<string> {
  const id = e.id ?? crypto.randomUUID();
  const at = e.at === undefined ? new Date().toISOString() : isoTime(e.at);
  const notifiedAt = isoTimeOrNull(e.notified_at);
  await db
    .prepare(
      `INSERT INTO events (id, record_id, kind, fields, before, after, source_url, monitor_run_id, notified_at, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      e.record_id,
      e.kind,
      JSON.stringify(e.fields ?? []),
      json(e.before),
      json(e.after),
      e.source_url ?? null,
      e.monitor_run_id ?? null,
      notifiedAt,
      at,
    )
    .run();
  return id;
}

/**
 * The feed behind `/api/events`, newest first: events at or after `sinceIso` (all of them when null)
 * of records that are watched or the subject of a curated check, and of no others. A one-off public
 * lookup has no row here by construction, and the SQL enforces it too. A limit below 1 (or NaN)
 * returns nothing; it never becomes SQLite's "no limit".
 */
export async function listEvents(
  db: D1Database,
  sinceIso: string | null,
  limit: number,
  kind: EventRow["kind"] = null,
): Promise<(EventRow & { registry: string | null; full_name: string | null })[]> {
  const max = Math.max(0, Math.trunc(limit)) || 0;
  const where = [`(${WATCHED_OR_CURATED})`];
  const values: (string | number)[] = [];
  if (sinceIso !== null) {
    where.push("e.at >= ?");
    values.push(isoTime(sinceIso));
  }
  if (kind !== null) {
    where.push("e.kind = ?");
    values.push(kind);
  }
  const { results } = await db
    .prepare(
      `SELECT e.*, r.registry AS registry, r.full_name AS full_name FROM events e JOIN records r ON r.id = e.record_id
       WHERE ${where.join(" AND ")} ORDER BY e.at DESC, e.rowid DESC LIMIT ?`,
    )
    .bind(...values, max)
    .all<EventRow & { registry: string | null; full_name: string | null }>();
  return results;
}

/** Marks an event's callback as delivered. */
export async function setEventNotified(db: D1Database, id: string, atIso: string): Promise<void> {
  await db.prepare("UPDATE events SET notified_at = ? WHERE id = ?").bind(isoTime(atIso), id).run();
}

/** Events by kind, every kind present (for /api/stats). */
export async function eventCounts(db: D1Database): Promise<{ status_change: number; notice: number; recheck: number }> {
  const { results } = await db.prepare("SELECT kind, COUNT(*) AS n FROM events GROUP BY kind").all<{ kind: string | null; n: number }>();
  const out = { status_change: 0, notice: 0, recheck: 0 };
  for (const r of results) if (r.kind === "status_change" || r.kind === "notice" || r.kind === "recheck") out[r.kind] += r.n;
  return out;
}

/** Every event of one record, newest first. */
export async function listEventsForRecord(db: D1Database, recordId: string): Promise<EventRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM events WHERE record_id = ? ORDER BY at DESC, rowid DESC")
    .bind(recordId)
    .all<EventRow>();
  return results;
}

/** One status change for the home's feed, with what the page needs to name the record (a person by type and number). */
export interface FeedChange {
  id: string;
  record_id: string;
  at: string | null;
  before: string | null;
  after: string | null;
  registry: string | null;
  record_type: string | null;
  full_name: string | null;
  licence_number: string | null;
  watch_kind: "page" | "topic" | null;
}

/** The newest status changes of watched or curated records, for the home. */
export async function statusChangeFeed(db: D1Database, limit: number): Promise<FeedChange[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.record_id, e.at, e.before, e.after, r.registry, r.record_type, r.full_name, r.licence_number,
              (SELECT w.kind FROM watches w WHERE w.record_id = r.id ORDER BY w.created_at DESC LIMIT 1) AS watch_kind
       FROM events e JOIN records r ON r.id = e.record_id
       WHERE e.kind = 'status_change' AND (${WATCHED_OR_CURATED})
       ORDER BY e.at DESC, e.rowid DESC LIMIT ?`,
    )
    .bind(Math.max(0, Math.trunc(limit)))
    .all<FeedChange>();
  return results;
}
