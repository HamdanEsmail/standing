// Watches (one per Monitor a record has) and the shared regulator-page monitors.
import { WATCHED_OR_CURATED } from "./records";
import { isoTime, isoTimeOrNull } from "./time";
import type { SharedMonitorRow, WatchRow } from "./types";

/** The statuses the code writes. `active` holds a slot, and so does `creating`: a watch reserved while
 *  its Monitor is being made on TinyFish, which takes seconds (`reserveWatch`). */
export type WatchStatus = "creating" | "active" | "expired" | "failed";
export type WatchAddedBy = "curated" | "public" | "admin";

/** A watch that holds a slot. */
const HOLDS = "status IN ('active', 'creating')";
/** A reservation older than this was left by a request that died; it no longer holds anything. */
const RESERVATION_MINUTES = 10;

export interface NewWatch {
  id?: string;
  record_id: string | null;
  kind: "page" | "topic";
  monitor_id: string | null;
  added_by: WatchAddedBy;
  callback_url?: string | null;
  expires_at?: string | null;
  /** Defaults to `active`. */
  status?: WatchStatus;
  /** The public caller who created it. */
  ip_hash?: string | null;
}

export interface WatchFilter {
  recordId?: string;
  status?: WatchStatus;
  addedBy?: WatchAddedBy;
}

/** Inserts a watch and returns its id. `created_at` is now; `id` is generated when absent. */
export async function insertWatch(db: D1Database, w: NewWatch): Promise<string> {
  const id = w.id ?? crypto.randomUUID();
  const expiresAt = isoTimeOrNull(w.expires_at);
  await db
    .prepare(
      `INSERT INTO watches (id, record_id, kind, monitor_id, added_by, callback_url, expires_at, created_at, status, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      w.record_id,
      w.kind,
      w.monitor_id,
      w.added_by,
      w.callback_url ?? null,
      expiresAt,
      new Date().toISOString(),
      w.status ?? "active",
      w.ip_hash ?? null,
    )
    .run();
  return id;
}

/** The caps a new watch must fit under, each counted in the same statement that inserts it. */
export interface WatchCaps {
  /** Watches of every kind (the account's Monitors less the shared ones). */
  all: number;
  /** Watches added by `added_by`, when that kind has slots of its own (public, curated). */
  ofKind: number | null;
  /** A public visitor's watches in one UTC day. */
  perVisitor: number | null;
}

/**
 * Reserves a watch before its Monitor is made: one INSERT that happens only when the record has no
 * watch holding a slot and every cap still has room, so of any number of requests arriving together
 * only as many as fit get a row. The row is `creating`, with no Monitor yet; `activateWatch` or
 * `dropReservation` ends it. Returns the new id, or null when it did not fit.
 */
export async function reserveWatch(db: D1Database, w: Omit<NewWatch, "monitor_id" | "status">, caps: WatchCaps): Promise<string | null> {
  const id = w.id ?? crypto.randomUUID();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const stale = new Date(now.getTime() - RESERVATION_MINUTES * 60_000).toISOString();
  const [, inserted] = await db.batch([
    db.prepare("DELETE FROM watches WHERE status = 'creating' AND created_at < ?").bind(stale),
    db
      .prepare(
        `INSERT INTO watches (id, record_id, kind, monitor_id, added_by, callback_url, expires_at, created_at, status, ip_hash)
         SELECT ?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, 'creating', ?8
         WHERE NOT EXISTS (SELECT 1 FROM watches WHERE record_id = ?2 AND ${HOLDS})
           AND (SELECT COUNT(*) FROM watches WHERE ${HOLDS}) < ?9
           AND (?10 IS NULL OR (SELECT COUNT(*) FROM watches WHERE ${HOLDS} AND added_by = ?4) < ?10)
           AND (?11 IS NULL OR (
                 (SELECT COUNT(*) FROM watches WHERE added_by = 'public' AND ip_hash = ?8 AND created_at >= ?12) < ?11
                 AND COALESCE((SELECT watches FROM public_use WHERE ip_hash = ?8 AND day = ?13), 0) < ?11))`,
      )
      .bind(
        id,
        w.record_id,
        w.kind,
        w.added_by,
        w.callback_url ?? null,
        isoTimeOrNull(w.expires_at),
        now.toISOString(),
        w.ip_hash ?? null,
        caps.all,
        caps.ofKind,
        caps.perVisitor,
        `${day}T00:00:00.000Z`,
        day,
      ),
  ]);
  return (inserted?.meta.changes ?? 0) > 0 ? id : null;
}

/** The reserved watch now has its Monitor. False when the reservation is gone (it went stale). */
export async function activateWatch(db: D1Database, id: string, monitorId: string): Promise<boolean> {
  const result = await db.prepare("UPDATE watches SET monitor_id = ?, status = 'active' WHERE id = ? AND status = 'creating'").bind(monitorId, id).run();
  return result.meta.changes > 0;
}

/** Gives a reservation back: its Monitor could not be made. */
export async function dropReservation(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM watches WHERE id = ? AND status = 'creating'").bind(id).run();
}

/** How many watches a public visitor has started today (UTC), whatever became of them. */
export async function visitorWatchesToday(db: D1Database, ipHash: string): Promise<number> {
  const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM watches WHERE added_by = 'public' AND ip_hash = ? AND created_at >= ?")
    .bind(ipHash, dayStart)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function getWatch(db: D1Database, id: string): Promise<WatchRow | null> {
  return db.prepare("SELECT * FROM watches WHERE id = ?").bind(id).first<WatchRow>();
}

export function getWatchByMonitorId(db: D1Database, monitorId: string): Promise<WatchRow | null> {
  return db.prepare("SELECT * FROM watches WHERE monitor_id = ? ORDER BY created_at, id LIMIT 1").bind(monitorId).first<WatchRow>();
}

/** Watches, oldest first, optionally only those of one record, one status or one adder. */
export async function listWatches(db: D1Database, filter: WatchFilter = {}): Promise<WatchRow[]> {
  const where: string[] = [];
  const values: string[] = [];
  if (filter.recordId !== undefined) {
    where.push("record_id = ?");
    values.push(filter.recordId);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    values.push(filter.status);
  }
  if (filter.addedBy !== undefined) {
    where.push("added_by = ?");
    values.push(filter.addedBy);
  }
  const sql = `SELECT * FROM watches ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
  const { results } = await db.prepare(sql).bind(...values).all<WatchRow>();
  return results;
}

/** Watches that hold a slot (active, or reserved while their Monitor is made), optionally only those
 *  added by one kind of user. Expired and failed watches hold no slot. */
export async function countWatches(db: D1Database, addedBy?: WatchAddedBy): Promise<number> {
  const statement =
    addedBy === undefined
      ? db.prepare(`SELECT COUNT(*) AS n FROM watches WHERE ${HOLDS}`)
      : db.prepare(`SELECT COUNT(*) AS n FROM watches WHERE ${HOLDS} AND added_by = ?`).bind(addedBy);
  const row = await statement.first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Marks the active public watches whose `expires_at` is at or before `nowIso` as `expired` and returns
 * them (with the new status), soonest-expired first. The cron deletes their Monitors; the watch rows,
 * the record and its events stay. One UPDATE, so a watch is returned by exactly one call.
 */
export async function expireWatches(db: D1Database, nowIso: string): Promise<WatchRow[]> {
  const now = isoTime(nowIso);
  const { results } = await db
    .prepare(
      `UPDATE watches SET status = 'expired'
       WHERE status = 'active' AND added_by = 'public' AND expires_at IS NOT NULL AND expires_at <= ?
       RETURNING *`,
    )
    .bind(now)
    .all<WatchRow>();
  return [...results].sort((a, b) => (a.expires_at ?? "").localeCompare(b.expires_at ?? "") || a.id.localeCompare(b.id));
}

export function getSharedMonitor(db: D1Database, registry: string): Promise<SharedMonitorRow | null> {
  return db.prepare("SELECT * FROM monitors_shared WHERE registry = ?").bind(registry).first<SharedMonitorRow>();
}

/** The shared monitor with this TinyFish monitor id (webhook routing). */
export function getSharedMonitorByMonitorId(db: D1Database, monitorId: string): Promise<SharedMonitorRow | null> {
  return db.prepare("SELECT * FROM monitors_shared WHERE monitor_id = ?").bind(monitorId).first<SharedMonitorRow>();
}

export async function listSharedMonitors(db: D1Database): Promise<SharedMonitorRow[]> {
  const { results } = await db.prepare("SELECT * FROM monitors_shared ORDER BY registry").all<SharedMonitorRow>();
  return results;
}

/** Records the shared monitor of a registry, replacing its monitor id and url. `created_at` is set once. */
export async function putSharedMonitor(
  db: D1Database,
  m: { registry: string; monitor_id: string | null; url: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO monitors_shared (registry, monitor_id, url, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (registry) DO UPDATE SET monitor_id = excluded.monitor_id, url = excluded.url`,
    )
    .bind(m.registry, m.monitor_id, m.url, new Date().toISOString())
    .run();
}

/** The record's active watch, or null. */
export function activeWatchForRecord(db: D1Database, recordId: string): Promise<WatchRow | null> {
  return db
    .prepare("SELECT * FROM watches WHERE record_id = ? AND status = 'active' ORDER BY created_at, id LIMIT 1")
    .bind(recordId)
    .first<WatchRow>();
}

/** The watch that holds the record's slot: its active watch, or one being created right now. */
export function heldWatchForRecord(db: D1Database, recordId: string): Promise<WatchRow | null> {
  return db
    .prepare(`SELECT * FROM watches WHERE record_id = ? AND ${HOLDS} ORDER BY created_at, id LIMIT 1`)
    .bind(recordId)
    .first<WatchRow>();
}

export async function setWatchStatus(db: D1Database, id: string, status: WatchStatus): Promise<void> {
  await db.prepare("UPDATE watches SET status = ? WHERE id = ?").bind(status, id).run();
}

/** Active watches by kind and all watches by status, every key present (for /api/stats). */
export async function watchCounts(db: D1Database): Promise<{ byKind: { page: number; topic: number }; byStatus: { active: number; failed: number; expired: number } }> {
  const { results } = await db
    .prepare("SELECT kind, status, COUNT(*) AS n FROM watches GROUP BY kind, status")
    .all<{ kind: string | null; status: string | null; n: number }>();
  const byKind = { page: 0, topic: 0 };
  const byStatus = { active: 0, failed: 0, expired: 0 };
  for (const r of results) {
    if (r.status === "active" && (r.kind === "page" || r.kind === "topic")) byKind[r.kind] += r.n;
    if (r.status === "active" || r.status === "failed" || r.status === "expired") byStatus[r.status] += r.n;
  }
  return { byKind, byStatus };
}

/** The public watch slots: how many are in use and when the soonest of them expires (null when none). */
export async function publicSlots(db: D1Database): Promise<{ used: number; nextFreesAt: string | null }> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n, MIN(expires_at) AS soonest FROM watches WHERE status = 'active' AND added_by = 'public'")
    .first<{ n: number; soonest: string | null }>();
  return { used: row?.n ?? 0, nextFreesAt: row?.soonest ?? null };
}

/** A record's latest public watch, active or expired (its expiry is what the record page says). */
export function latestPublicWatch(db: D1Database, recordId: string): Promise<WatchRow | null> {
  return db
    .prepare("SELECT * FROM watches WHERE record_id = ? AND added_by = 'public' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(recordId)
    .first<WatchRow>();
}

/** One watchlist row: the record, its active watch (if any), whether it is curated, and its latest event. */
export interface WatchlistRow {
  id: string;
  registry: string | null;
  record_type: string | null;
  full_name: string | null;
  licence_number: string | null;
  status: string | null;
  /** JSON `Flag[]`. */
  flags: string;
  last_checked_at: string | null;
  watch_kind: "page" | "topic" | null;
  watch_added_by: "curated" | "public" | "admin" | null;
  watch_expires_at: string | null;
  curated: number;
  last_event_at: string | null;
  last_event_kind: "status_change" | "notice" | "recheck" | null;
}

/** Every watched or curated record, curated first, then by when it was first seen (newest first). */
export async function watchlistRows(db: D1Database): Promise<WatchlistRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.registry, r.record_type, r.full_name, r.licence_number, r.status, r.flags, r.last_checked_at,
              w.kind AS watch_kind, w.added_by AS watch_added_by, w.expires_at AS watch_expires_at,
              (EXISTS (SELECT 1 FROM watches cw WHERE cw.record_id = r.id AND cw.added_by = 'curated')
                OR EXISTS (SELECT 1 FROM checks k WHERE k.record_id = r.id AND k.added_by = 'curated')) AS curated,
              (SELECT e.at FROM events e WHERE e.record_id = r.id ORDER BY e.at DESC, e.rowid DESC LIMIT 1) AS last_event_at,
              (SELECT e.kind FROM events e WHERE e.record_id = r.id ORDER BY e.at DESC, e.rowid DESC LIMIT 1) AS last_event_kind
       FROM records r
       LEFT JOIN watches w ON w.id = (SELECT x.id FROM watches x WHERE x.record_id = r.id AND x.status = 'active' ORDER BY x.created_at, x.id LIMIT 1)
       WHERE ${WATCHED_OR_CURATED}
       ORDER BY curated DESC, r.first_seen_at DESC, r.id`,
    )
    .all<WatchlistRow>();
  return results;
}
