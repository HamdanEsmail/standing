// A record as read (a parsed record page, or the entry an Agent run opened) turned into what
// upsertRecord stores: the status and flags from the adapter's own map, the disciplinary entries
// from the page's conditions blocks, and the restrictions in force today. A status is never
// inferred: a missing status line is `unknown`.
import type { Flag } from "../core/status";
import type { NormalizedRecord } from "../db/types";
import type { Env } from "../env";
import type { AgentEntry, ParsedRecord, RegistryAdapter, RegistryRow } from "../registries/types";
import { fetchPage } from "../tinyfish/fetch";

export interface Normalized {
  record: NormalizedRecord;
  restrictions: string[];
}

/** Today as `YYYY-MM-DD` (UTC), the date the adapters judge "current" conditions against. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const unique = (flags: Flag[]): Flag[] => [...new Set(flags)];

/** A parsed record page: the adapter's `statusFromRecord` gives the status (it derives the hints from
 *  what the page showed); each conditions block is one disciplinary entry with its "From" date; the
 *  blocks still in force are the restrictions. */
export function normalizePage(adapter: RegistryAdapter, parsed: ParsedRecord, sourceUrl: string | null, today: string): Normalized {
  const { status, flags } = adapter.statusFromRecord(parsed, today);
  const conditions = parsed.conditions ?? [];
  return {
    record: {
      ...parsed,
      status,
      flags: unique([...(parsed.flags ?? []), ...flags]),
      disciplinary: conditions.map((c) => ({ date: c.from, summary: c.text, source_url: sourceUrl })),
    },
    restrictions: conditions.filter((c) => c.to === null || c.to > today).map((c) => c.text).filter((t) => t !== ""),
  };
}

/** The entry an Agent run opened, when no record page could be read for it: the adapter's own
 *  `statusFromAgentEntry` reads the status text (and what of the sanctions text that register's
 *  wording says is in force). The entry's distinguishing fields (`raw_fields`: NMC register part,
 *  SRA firm, CSLB classifications, DCA board) are kept, and the sanctions text is kept as the
 *  restriction it reports. */
export function normalizeAgentEntry(adapter: RegistryAdapter, entry: AgentEntry, today: string): Normalized {
  const sanctions = entry.sanctions_text;
  const { status, flags } = adapter.statusFromAgentEntry(entry, today);
  return {
    record: {
      full_name: entry.full_name,
      licence_number: entry.licence_number,
      status_raw: entry.status_raw,
      raw_fields: { ...(entry.raw_fields ?? {}), ...(sanctions === null ? {} : { sanctions_text: sanctions }) },
      status,
      flags,
      disciplinary: [],
    },
    restrictions: sanctions === null ? [] : [sanctions],
  };
}

/**
 * A match the run neither opened nor could read a page for, when there is nothing left to try (no
 * number, or the check already searched by number): the row's name, number and status text are kept,
 * but a results row is never enough for a status, so the status is `unknown`.
 */
export function normalizeResultsRow(row: RegistryRow, number: string | null): Normalized {
  return {
    record: {
      full_name: row.name === "" ? null : row.name,
      licence_number: number,
      status_raw: row.status_raw,
      raw_fields: {},
      status: "unknown",
      flags: [],
      disciplinary: [],
    },
    restrictions: [],
  };
}

/** A failed read keeps TinyFetch's code when the page itself could not be fetched; a page that was
 *  fetched but lacks what the parser needs has none. */
export type PageRead = { ok: true; markdown: string; readAt: string; parsed: ParsedRecord } | { ok: false; error?: string };

/**
 * Reads a record page with the adapter's Fetch options. Only a page that shows the name and the status
 * line counts as read, and when it shows a number it must be `number`. A Fetch that fails
 * or throws, or a parser that throws, is an unreadable page, never an error of the check: the caller
 * then takes its fallback.
 */
export async function readRecordPage(env: Env, adapter: RegistryAdapter, url: string, number: string | null): Promise<PageRead> {
  if (!adapter.parseRecordPage) return { ok: false };
  try {
    const readAt = new Date().toISOString();
    const page = await fetchPage(env, url, "markdown", adapter.recordFetchOptions);
    if (!page.ok) return { ok: false, error: page.error };
    const parsed = adapter.parseRecordPage(page.text, url);
    if (parsed === null || !parsed.full_name || !parsed.status_raw) return { ok: false };
    if (number !== null && parsed.licence_number !== null && !sameNumber(parsed.licence_number, number)) return { ok: false };
    return { ok: true, markdown: page.text, readAt, parsed };
  } catch {
    console.error("record page could not be read");
    return { ok: false };
  }
}

/** The page's fields first; the Agent's entry fills only what the page lacks. */
export function mergeWithEntry(parsed: ParsedRecord, entry: AgentEntry | null): ParsedRecord {
  if (entry === null) return parsed;
  return {
    ...parsed,
    full_name: parsed.full_name ?? entry.full_name,
    licence_number: parsed.licence_number ?? entry.licence_number,
    status_raw: parsed.status_raw ?? entry.status_raw,
  };
}

/** Two registration numbers are the same when their letters and digits are (case-insensitive,
 *  punctuation and spaces ignored, leading zeros of an all-digit number ignored). */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string) => {
    const t = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, "") : t;
  };
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const x = norm(a);
  return x !== "" && x === norm(b);
}
