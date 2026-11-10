import { applyStatusMap, type Flag, type Status, type StatusMap } from "../core/status";
import type { Env } from "../env";
import { TinyFishError } from "../tinyfish/client";
import { fetchPage } from "../tinyfish/fetch";
import { REGISTRY_META } from "./meta";
import { asText, isRecord, nextNonBlank, quoteForGoal, readAgentBasics, splitCells, tidy, toLines } from "./parse-util";
import type { AgentEntry, AgentOutcome, ParsedRecord, RegistryAdapter, RegistryRow } from "./types";

// Florida Division of Corporations (Sunbiz). Read with plain Fetch only, like Companies House: the name
// search is a GET page listing 20 entities alphabetically from the searched name, and each row links to
// the entity's detail page. No Agent run is ever made for this register (coverage lookup "fetch").

const SEARCH_RESULTS = "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults";
const DETAIL = "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail";

/**
 * A detail page's status line: "ACTIVE", or "INACTIVE" followed by the page's last event
 * ("INACTIVE - ADMIN DISSOLUTION FOR ANNUAL REPORT"). Dissolutions are `dissolved`; a revocation or
 * cancellation is `removed`. "INACTIVE" on its own, a merger and anything else stay `unknown` with
 * `status_raw` kept: the page does not say which.
 */
export const SUNBIZ_MAP: StatusMap = [
  { pattern: /^active$/i, status: "active" },
  { pattern: /^inactive - .*\bdissolution\b/i, status: "dissolved" },
  { pattern: /^inactive - .*\bdissolved\b/i, status: "dissolved" },
  { pattern: /^inactive - .*\b(?:revoked|revocation|cancell?ed|cancell?ation)\b/i, status: "removed" },
];

/** Search rows that are not the entity under that name: a former name ("NAME HS") or a cross reference. */
const NOT_CURRENT_NAME = /^(?:name hs|cross rf)$/i;

/** The search page for a name: Sunbiz lists entities alphabetically from `searchNameOrder`, the name in
 *  capitals without spaces or punctuation. */
function searchQueryUrl(query: string): string {
  const order = tidy(query).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${SEARCH_RESULTS}?inquiryType=EntityName&searchNameOrder=${encodeURIComponent(order)}&searchTerm=${encodeURIComponent(tidy(query))}`;
}

/** A row's detail link without the search that led to it: `searchNameOrder` and `aggregateId` are the
 *  entity's own, so the address is stable (a Page monitor can watch it). */
function stableDetailUrl(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "search.sunbiz.org" || !u.pathname.endsWith("/SearchResultDetail")) return null;
  const order = u.searchParams.get("searchNameOrder");
  const aggregate = u.searchParams.get("aggregateId");
  if (!order || !aggregate) return null;
  return `${DETAIL}?inquirytype=EntityName&directionType=Initial&searchNameOrder=${encodeURIComponent(order)}&aggregateId=${encodeURIComponent(aggregate)}`;
}

/**
 * The search page (markdown, with its links): one row per table line, name / document number / status.
 * A row whose status is "NAME HS" (a former name) or "CROSS RF" keeps its name with "(former name)" or
 * "(cross reference)" after it, so it is a candidate but never equals the searched name: the entity no
 * longer carries that name. Each row's record page is the detail link whose aggregate id names its
 * document number.
 */
export function parseSearch(markdown: string, links: string[] = []): RegistryRow[] {
  const rows: RegistryRow[] = [];
  const details = links.map(stableDetailUrl).filter((u): u is string => u !== null);
  for (const raw of toLines(markdown)) {
    const line = raw.trim();
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = splitCells(line);
    if (cells.length < 3) continue;
    const [name, number, status] = cells.map(tidy) as [string, string, string];
    if (name === "" || !/^[A-Z0-9]{4,14}$/i.test(number)) continue;
    const note = /^name hs$/i.test(status) ? " (former name)" : /^cross rf$/i.test(status) ? " (cross reference)" : "";
    const url = details.find((d) => d.toLowerCase().includes(`-${number.toLowerCase()}-`)) ?? null;
    rows.push({ name: `${name}${note}`, number: number.toUpperCase(), status_raw: status || null, detail: NOT_CURRENT_NAME.test(status) ? status : null, url });
  }
  return rows;
}

/** A Sunbiz date (MM/DD/YYYY) as ISO, or null. */
function usDate(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[3]), Number(m[1]), Number(m[2])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
}

export interface SunbizRecord extends ParsedRecord {
  raw_fields: {
    entity_type: string | null;
    state: string | null;
    principal_address: string | null;
    last_event: string | null;
    last_annual_report: { year: number; filed: string | null } | null;
  };
}

/**
 * A detail page (markdown). The page prints the filing values without their labels, always in this
 * order: document number, FEI/EIN, date filed, state, status, and for an inactive entity its last event,
 * event date filed and event effective date. Officers and the registered agent are people and are not
 * read. Null for a page that is not a Sunbiz detail page.
 */
function parseRecordPage(markdown: string, _url?: string): SunbizRecord | null {
  const lines = toLines(markdown).map((l) => l.trim());
  const head = lines.findIndex((l) => /^#+\s*Detail by Entity Name$/i.test(l));
  const filing = lines.findIndex((l) => /^Filing Information$/i.test(l));
  if (head === -1 || filing === -1) return null;

  const typeAt = nextNonBlank(lines, head);
  const nameAt = typeAt === -1 ? -1 : nextNonBlank(lines, typeAt);
  const entity_type = typeAt !== -1 && typeAt < filing ? lines[typeAt]! : null;
  const full_name = nameAt !== -1 && nameAt < filing ? tidy(lines[nameAt]!) : null;

  const values: string[] = [];
  for (let i = nextNonBlank(lines, filing); i !== -1 && i < lines.length && lines[i] !== ""; i++) values.push(tidy(lines[i]!));
  const [number, , filed, state, status, lastEvent] = values;
  const licence_number = number && /^[A-Z0-9]{4,14}$/i.test(number) ? number.toUpperCase() : null;
  const statusWord = status && /^[A-Z][A-Z /]*$/i.test(status) ? status.toUpperCase() : null;
  const event = lastEvent && !usDate(lastEvent) && !/^none$/i.test(lastEvent) ? lastEvent : null;
  const status_raw = statusWord === null ? null : event !== null && statusWord !== "ACTIVE" ? `${statusWord} - ${event}` : statusWord;

  let principal_address: string | null = null;
  const addr = lines.findIndex((l) => /^Principal Address$/i.test(l));
  if (addr !== -1) {
    const parts: string[] = [];
    for (let i = addr + 1; i < lines.length && parts.length < 3; i++) {
      const l = lines[i]!;
      if (l === "" && parts.length > 0) break;
      if (l === "" || /^Changed:/i.test(l)) continue;
      parts.push(tidy(l));
    }
    if (parts.length > 0) principal_address = parts.join(", ");
  }

  let last_annual_report: SunbizRecord["raw_fields"]["last_annual_report"] = null;
  for (const l of lines) {
    if (!l.startsWith("|")) continue;
    const [year, date] = splitCells(l);
    if (year && /^\d{4}$/.test(year) && (!last_annual_report || Number(year) > last_annual_report.year)) {
      last_annual_report = { year: Number(year), filed: date ? usDate(date) : null };
    }
  }

  return {
    full_name,
    licence_number,
    status_raw,
    registered_since: filed ? usDate(filed) : null,
    expiry_date: null,
    raw_fields: { entity_type, state: state && /^[A-Z]{2}$/.test(state) ? state : null, principal_address, last_event: event, last_annual_report },
  };
}

function normalizeStatus(raw: string | null, hints: { hasConditions?: boolean; hasInterimOrder?: boolean }) {
  return applyStatusMap(SUNBIZ_MAP, raw, hints);
}

function statusFromRecord(parsed: ParsedRecord, _todayIso: string): { status: Status; flags: Flag[] } {
  return applyStatusMap(SUNBIZ_MAP, parsed.status_raw);
}

/** No Agent run is made for Sunbiz; this keeps the adapter's shape. */
function statusFromAgentEntry(entry: AgentEntry, _todayIso: string): { status: Status; flags: Flag[] } {
  return applyStatusMap(SUNBIZ_MAP, entry.status_raw);
}

/** Never used (lookup "fetch"); a goal exists only because every adapter has one. */
function goal(q: { variants: string[]; number?: string; profession?: string }): string {
  if (q.variants.length === 0 && !q.number) throw new Error("Sunbiz goal needs a name");
  return `Navigate to ${REGISTRY_META["fl-sunbiz"].searchUrl}. Search by entity name ${quoteForGoal(q.variants[0] ?? q.number ?? "")} and report the result rows. Do not open anything.`;
}

const outputSchema = { type: "object", required: ["blocked"], properties: { blocked: { type: "boolean" } } };

function parseAgentResult(result: unknown): AgentOutcome {
  const r = isRecord(result) ? result : {};
  const rows: RegistryRow[] = [];
  for (const item of Array.isArray(r.rows) ? r.rows.filter(isRecord) : []) {
    const name = asText(item.name);
    if (name !== null) rows.push({ name, number: asText(item.number), status_raw: asText(item.status), detail: null, url: null });
  }
  return { ...readAgentBasics(r), rows, opened: null };
}

/** One search page by name. A read that failed throws (an empty list would read as no_match when the
 *  search never ran). Sunbiz pages forward with a session-bound link, so only page 1 is read; a caller
 *  that needs page 2 gets a throw and treats the result as incomplete. */
async function fetchSearch(env: Env, query: string, pageNumber = 1): Promise<RegistryRow[]> {
  if (pageNumber !== 1) throw new TinyFishError(501, "next_page_unavailable", "Sunbiz search is read one page only");
  const page = await fetchPage(env, searchQueryUrl(query), "markdown", flSunbiz.searchFetchOptions);
  if (!page.ok) throw new TinyFishError(page.status ?? 502, page.error, `Sunbiz search could not be read: ${page.error}`);
  return parseSearch(page.text, page.links);
}

export const flSunbiz = {
  id: "fl-sunbiz",
  name: REGISTRY_META["fl-sunbiz"].name,
  country: REGISTRY_META["fl-sunbiz"].country,
  recordTypes: ["company"],
  searchUrl: REGISTRY_META["fl-sunbiz"].searchUrl,
  allowSurnameOnly: false,
  browserProfile: "lite",
  decisionPages: [],
  outputSchema,
  goal,
  normalizeStatus,
  statusFromRecord,
  statusFromAgentEntry,
  parseAgentResult,
  agentRowsListed: 20,
  // A record page's address carries an id that cannot be built from the document number, so there is
  // no recordUrl: a lookup is by name, and the matched row's own link is read.
  recordUrl: undefined,
  parseRecordPage,
  fetchSearch,
  parseSearch,
  searchFetchOptions: { links: true },
  searchQueryUrl,
  // A full search page lists 20 entities.
  searchPageRows: 20,
  // Sunbiz lists the 20 names that follow the searched one alphabetically, whatever they are.
  searchNearest: true,
  topicQuery: undefined,
  coverage: {
    lookup: "fetch",
    watch: "page",
    notes:
      "search and record pages are read with plain Fetch; lookups are by company name (a record page's address cannot be built from the document number); a former name (\"NAME HS\") is listed but never matched",
  },
  noMatchSuggestions: ["Try the exact registered name, including INC or LLC.", "Search the name as Sunbiz files it (for example without \"The\")."],
} satisfies RegistryAdapter;
