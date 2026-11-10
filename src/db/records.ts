// Records: the current state of one registrant, keyed by (registry, licence_number), and the
// comparison that decides whether a re-read is a change. Only the status, the flags, the
// disciplinary entries and the registry's own status text count as a change (spec 4.6); a
// timestamp, the "Results of search on" line, the order of specialties or raw fields never do.
import type { RecordType } from "../registries/types";
import { isoTime } from "./time";
import type { NormalizedRecord, RecordFields, RecordRow } from "./types";

/** SQL: a record (alias `r`) that is watched or the subject of a curated check. The feed, the export
 *  and the home page show these and no others; a one-off public lookup is neither. */
export const WATCHED_OR_CURATED =
  "r.watched = 1 OR EXISTS (SELECT 1 FROM checks c WHERE c.record_id = r.id AND c.added_by = 'curated')";

/** What `upsertRecord` needs: the normalized record plus what only the caller knows. */
export interface RecordInput {
  /** The record to refresh when the caller holds its id (a Monitor re-read). Optional: records are keyed by number. */
  id?: string;
  registry: string;
  record_type: RecordType;
  record: NormalizedRecord;
  source_url: string | null;
  /** R2 key of the evidence screenshot. A re-read without evidence keeps the stored key. */
  evidence_key?: string | null;
  /** Current restriction texts, for `fields.restrictions`. Defaults to none. */
  restrictions?: string[];
  /** When the page was read, in any form `Date.parse` reads (stored as millisecond ISO). Defaults to now. */
  checked_at?: string;
}

// ---------------------------------------------------------------------------------------------
// The comparable view of a record

const collapse = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

interface Comparable {
  status: string | null;
  /** Sorted, without duplicates. */
  flags: string[];
  /** One entry each, `[date, whitespace-collapsed summary]` as JSON text, sorted. */
  disciplinary: string[];
  status_raw: string;
}

function comparable(
  status: string | null,
  flags: readonly string[],
  disciplinary: readonly { date?: string | null; summary: string }[],
  statusRaw: string | null,
): Comparable {
  return {
    status,
    flags: [...new Set(flags)].sort(),
    disciplinary: disciplinary.map((d) => JSON.stringify([collapse(d.date) || null, collapse(d.summary)])).sort(),
    status_raw: collapse(statusRaw),
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function storedFlags(text: string | null): string[] {
  const value = parseJson(text);
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === "string") : [];
}

function storedDisciplinary(text: string | null): { date: string | null; summary: string }[] {
  const value = parseJson(text);
  if (!Array.isArray(value)) return [];
  const entries: { date: string | null; summary: string }[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { date, summary } = item as { date?: unknown; summary?: unknown };
    if (typeof summary !== "string") continue;
    entries.push({ date: typeof date === "string" ? date : null, summary });
  }
  return entries;
}

function comparableOfRow(row: RecordRow): Comparable {
  return comparable(row.status, storedFlags(row.flags), storedDisciplinary(row.disciplinary), row.status_raw);
}

function comparableOfRecord(r: NormalizedRecord): Comparable {
  return comparable(r.status, r.flags, r.disciplinary, r.status_raw);
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Whether a re-read differs from the stored record, and in which fields. `fields` names, in this order,
 * the ones that differ: `status`, `flags` (as sets), `disciplinary` (each entry's date and
 * whitespace-collapsed summary, order-insensitive) and `status_raw` (whitespace-collapsed). Nothing else counts.
 */
export function recordDiff(before: RecordRow, after: NormalizedRecord): { changed: boolean; fields: string[] } {
  const a = comparableOfRow(before);
  const b = comparableOfRecord(after);
  const fields: string[] = [];
  if (a.status !== b.status) fields.push("status");
  if (!sameList(a.flags, b.flags)) fields.push("flags");
  if (!sameList(a.disciplinary, b.disciplinary)) fields.push("disciplinary");
  if (a.status_raw !== b.status_raw) fields.push("status_raw");
  return { changed: fields.length > 0, fields };
}

/** The same comparison between two stored rows (a Monitor re-check's record before and after the run
 *  refreshed it). */
export function recordRowDiff(before: RecordRow, after: RecordRow): { changed: boolean; fields: string[] } {
  const a = comparableOfRow(before);
  const b = comparableOfRow(after);
  const fields: string[] = [];
  if (a.status !== b.status) fields.push("status");
  if (!sameList(a.flags, b.flags)) fields.push("flags");
  if (!sameList(a.disciplinary, b.disciplinary)) fields.push("disciplinary");
  if (a.status_raw !== b.status_raw) fields.push("status_raw");
  return { changed: fields.length > 0, fields };
}

/** The public, comparable view of a record: what a status_change event shows as before and after. */
export function comparableView(row: Pick<RecordRow, "status" | "status_raw" | "flags" | "disciplinary">): {
  status: string | null;
  status_raw: string | null;
  flags: string[];
  disciplinary: { date: string | null; summary: string }[];
} {
  return { status: row.status, status_raw: row.status_raw, flags: storedFlags(row.flags), disciplinary: storedDisciplinary(row.disciplinary) };
}

/** SHA-256 (hex) of the comparable fields, so equal content gives an equal hash. */
async function normalizedHash(r: NormalizedRecord): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(comparableOfRecord(r)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------
// Queries

export function getRecord(db: D1Database, id: string): Promise<RecordRow | null> {
  return db.prepare("SELECT * FROM records WHERE id = ?").bind(id).first<RecordRow>();
}

/** Marks a record as watched (or no longer). */
export async function markWatched(db: D1Database, recordId: string, watched: boolean): Promise<void> {
  await db.prepare("UPDATE records SET watched = ? WHERE id = ?").bind(watched ? 1 : 0, recordId).run();
}

/** Records that are watched or the subject of a curated check: the ones the home feed and the export show. */
export async function listWatchedAndCurated(db: D1Database): Promise<RecordRow[]> {
  const { results } = await db
    .prepare(`SELECT r.* FROM records r WHERE (${WATCHED_OR_CURATED}) ORDER BY r.first_seen_at, r.id`)
    .all<RecordRow>();
  return results;
}

/**
 * The record the home shows: a curated record before one a visitor watches, newest first (by when it
 * was first seen, so a Monitor re-read does not swap it), and only one with a finished match check.
 * Null on a fresh deploy with nothing curated or watched.
 */
export function homeRecord(db: D1Database): Promise<RecordRow | null> {
  return db
    .prepare(
      `SELECT r.* FROM records r
       WHERE (${WATCHED_OR_CURATED}) AND r.status IS NOT NULL
         AND EXISTS (SELECT 1 FROM checks m WHERE m.record_id = r.id AND m.state = 'done' AND m.outcome = 'match')
       ORDER BY (EXISTS (SELECT 1 FROM watches w WHERE w.record_id = r.id AND w.added_by = 'curated')
              OR EXISTS (SELECT 1 FROM checks k WHERE k.record_id = r.id AND k.added_by = 'curated')) DESC,
              r.first_seen_at DESC, r.id DESC
       LIMIT 1`,
    )
    .first<RecordRow>();
}

/**
 * Inserts the record, or refreshes the one with the same `(registry, licence_number)`, and returns its id.
 * On a refresh the status, status text, flags, disciplinary entries, fields, source URL, last-checked time
 * and hash take the new values; the full name and the licence number keep the stored values when the new
 * ones are null (a re-read that lacks them must not erase them); the evidence key changes only when one is
 * given; `first_seen_at` and `watched` are never touched. A record with no licence number is always a new
 * row, unless the caller holds its id and passes it: then that row is refreshed.
 */
export async function upsertRecord(db: D1Database, input: RecordInput): Promise<string> {
  const r = input.record;
  const now = input.checked_at === undefined ? new Date().toISOString() : isoTime(input.checked_at);
  const fields: RecordFields = {
    registered_since: r.registered_since ?? null,
    expiry_date: r.expiry_date ?? null,
    specialties: r.specialties ?? [],
    restrictions: input.restrictions ?? [],
    raw: r.raw_fields ?? {},
  };
  const hash = await normalizedHash(r);
  const flags = JSON.stringify(r.flags);
  const disciplinary = JSON.stringify(r.disciplinary);
  const evidenceKey = input.evidence_key ?? null;

  if (input.id !== undefined) {
    const updated = await db
      .prepare(
        `UPDATE records SET
           record_type = ?, licence_number = COALESCE(?, licence_number), full_name = COALESCE(?, full_name),
           status = ?, status_raw = ?, flags = ?, disciplinary = ?, fields = ?, source_url = ?,
           evidence_key = COALESCE(?, evidence_key), last_checked_at = ?, normalized_hash = ?
         WHERE id = ?`,
      )
      .bind(
        input.record_type,
        r.licence_number,
        r.full_name,
        r.status,
        r.status_raw,
        flags,
        disciplinary,
        JSON.stringify(fields),
        input.source_url,
        evidenceKey,
        now,
        hash,
        input.id,
      )
      .run();
    if (updated.meta.changes > 0) return input.id;
  }

  const id = input.id ?? crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO records
         (id, registry, record_type, licence_number, full_name, status, status_raw, flags, disciplinary, fields,
          source_url, evidence_key, watched, first_seen_at, last_checked_at, normalized_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (registry, licence_number) DO UPDATE SET
         record_type = excluded.record_type,
         full_name = COALESCE(excluded.full_name, records.full_name),
         status = excluded.status,
         status_raw = excluded.status_raw,
         flags = excluded.flags,
         disciplinary = excluded.disciplinary,
         fields = excluded.fields,
         source_url = excluded.source_url,
         evidence_key = COALESCE(excluded.evidence_key, records.evidence_key),
         last_checked_at = excluded.last_checked_at,
         normalized_hash = excluded.normalized_hash
       RETURNING id`,
    )
    .bind(
      id,
      input.registry,
      input.record_type,
      r.licence_number,
      r.full_name,
      r.status,
      r.status_raw,
      flags,
      disciplinary,
      JSON.stringify(fields),
      input.source_url,
      evidenceKey,
      now,
      now,
      hash,
    )
    .first<{ id: string }>();
  if (!row) throw new Error("upsertRecord: the insert returned no row");
  return row.id;
}
