// The daily reader check. Once a UTC day Standing reads one known business record on each register
// it reads with Fetch, and looks for the record's number, its name and a status where its own reader
// looks for them. A register changes its pages without notice; this is how Standing finds out that
// its reader no longer understands one, before a lookup does.
//
// It is a check on Standing, not on anyone. It never reads again a record someone looked up or
// watches (a watched record is read again only when its TinyFish Monitor reports a change), it
// writes nothing to checks, records, events or watches, and it stores no evidence. The three records
// are businesses: GMC's pages are doctors' own records and Standing does not choose a person to read,
// and NMC and SRA are read only by the Agent, which costs money for each read.
//
// The hourly job calls it after its own work (src/index.ts). Each run reads at most one register,
// the first not tried yet that day, and a register is tried once a day whatever happens: its row is
// written before the page is read, so a run that dies leaves it marked "started" and nothing retries it.
import { claimReaderCheck, finishReaderCheck, latestReaderChecks, triedOn, type ReaderCheckRow, type ReaderOutcome } from "./db/readerChecks";
import type { Env } from "./env";
import { getAdapterById } from "./registries/index";
import type { RegistryId } from "./registries/meta";
import type { ParsedRecord, RegistryAdapter, RegistryRow } from "./registries/types";
import { cacheKey, dropScreens } from "./site/htmlCache";
import { TinyFishError } from "./tinyfish/client";
import { fetchPage } from "./tinyfish/fetch";

export interface KnownRecord {
  registry: RegistryId;
  /** The name exactly as the register prints it. */
  name: string;
  /** The number as the register's reader returns it. */
  number: string;
  /** What the register needs beside the number to build the record's address (California DCA). */
  profession?: string;
}

/** One public business record on each register Standing reads with Fetch, in the order they are tried. */
export const KNOWN_RECORDS: readonly KnownRecord[] = [
  { registry: "companies-house", name: "GREGGS PLC", number: "00502851" },
  { registry: "ca-dca", name: "SANTA FE FAMILY PHARMACY", number: "59020", profession: "pharmacy" },
  { registry: "fl-sunbiz", name: "PUBLIX ASSET MANAGEMENT COMPANY", number: "P01000027088" },
];

/** "GREGGS PLC (00502851)": how a known record is named on the page and in the API. */
export const recordLabel = (k: KnownRecord): string => `${k.name} (${k.number})`;

/** Each known record with its latest try, as /api/stats, /api/registries and the coverage page show it. Null fields: never tried. */
export interface ReaderCheckView {
  registry: string;
  record: string;
  day: string | null;
  started_at: string | null;
  finished_at: string | null;
  outcome: ReaderOutcome | null;
  detail: string | null;
  source_url: string | null;
}

export async function readerChecksNow(db: D1Database): Promise<ReaderCheckView[]> {
  const latest = await latestReaderChecks(db);
  return KNOWN_RECORDS.map((k) => {
    const row = latest.find((r) => r.registry === k.registry);
    return {
      registry: k.registry,
      record: recordLabel(k),
      day: row?.day ?? null,
      started_at: row?.started_at ?? null,
      finished_at: row?.finished_at ?? null,
      outcome: row?.outcome ?? null,
      detail: row?.detail ?? null,
      source_url: row?.source_url ?? null,
    };
  });
}

type Read = { outcome: "understood" | "no_answer" | "not_understood"; detail: string | null; source_url: string | null };

const plain = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().toUpperCase();

/** Whether the page holds the known record: its number, its name and a status, as the reader returned them. */
function judge(parsed: ParsedRecord | null, known: KnownRecord, url: string): Read {
  const notUnderstood = (detail: string): Read => ({ outcome: "not_understood", detail, source_url: url });
  if (parsed === null) return notUnderstood("the page is not read as a record");
  if (plain(parsed.licence_number) !== plain(known.number)) return notUnderstood("the page shows another number");
  if (plain(parsed.full_name) !== plain(known.name)) return notUnderstood("the page shows another name");
  const status = (parsed.status_raw ?? "").trim();
  if (status === "") return notUnderstood("the page shows no status");
  return { outcome: "understood", detail: status, source_url: url };
}

/** The record's address: from its number, or, where the register has none (Sunbiz), from the name search as a lookup reads it. */
async function recordAddress(env: Env, adapter: RegistryAdapter, known: KnownRecord): Promise<{ url: string } | Read> {
  if (adapter.recordUrl !== undefined) {
    const url = adapter.recordUrl(known.number, known.profession);
    return url === null ? { outcome: "not_understood", detail: "no record address for the number", source_url: null } : { url };
  }
  const search = adapter.searchQueryUrl?.(known.name) ?? null;
  let rows: RegistryRow[];
  try {
    rows = await adapter.fetchSearch!(env, known.name);
  } catch (err) {
    if (err instanceof TinyFishError) return { outcome: "no_answer", detail: err.code, source_url: search };
    return { outcome: "not_understood", detail: "the reader failed on the search page", source_url: search };
  }
  const url = rows.find((r) => plain(r.number) === plain(known.number))?.url ?? null;
  return url === null ? { outcome: "not_understood", detail: "the search no longer lists the record", source_url: search } : { url };
}

async function readKnown(env: Env, known: KnownRecord): Promise<Read> {
  const adapter = getAdapterById(known.registry);
  if (adapter === null || adapter.parseRecordPage === undefined) return { outcome: "not_understood", detail: "the register has no reader", source_url: null };
  const address = await recordAddress(env, adapter, known);
  if (!("url" in address)) return address;
  const page = await fetchPage(env, address.url, "markdown", adapter.recordFetchOptions ?? {});
  if (!page.ok) return { outcome: "no_answer", detail: page.error, source_url: address.url };
  try {
    return judge(adapter.parseRecordPage(page.text, page.finalUrl), known, address.url);
  } catch {
    return { outcome: "not_understood", detail: "the reader failed on the page", source_url: address.url };
  }
}

/**
 * Tries the first known record whose register has not been tried on `now`'s UTC day, and returns its
 * row; null when all three were tried that day, or when another run took the try first. Never throws.
 */
export async function runReaderCheck(env: Env, now: Date = new Date()): Promise<ReaderCheckRow | null> {
  try {
    const day = now.toISOString().slice(0, 10);
    const tried = await triedOn(env.DB, day);
    const known = KNOWN_RECORDS.find((k) => !tried.has(k.registry));
    if (known === undefined) return null;
    if (!(await claimReaderCheck(env.DB, known.registry, day, now.toISOString()))) return null;
    const read = await readKnown(env, known);
    const row = await finishReaderCheck(env.DB, known.registry, day, { ...read, finished_at: new Date().toISOString() });
    // The coverage page shows the result: its stored copy is dropped, so the next visit reads it.
    await dropScreens(env, [cacheKey.coverage()]);
    return row;
  } catch {
    console.error("reader check failed");
    return null;
  }
}
