import { applyStatusMap, type Flag, type Status, type StatusMap } from "../core/status";
import type { Env } from "../env";
import { TinyFishError } from "../tinyfish/client";
import { fetchPage } from "../tinyfish/fetch";
import { REGISTRY_META } from "./meta";
import {
  asText,
  isRecord,
  nextNonBlank,
  parseHumanDate,
  quoteForGoal,
  readAgentBasics,
  splitCells,
  tidy,
  toLines,
} from "./parse-util";
import type { AgentEntry, AgentOutcome, ParsedRecord, RegistryAdapter, RegistryRow } from "./types";

/**
 * Companies House's own company status text to the fixed status set. Matched on tidied text
 * (trimmed, whitespace collapsed, every dash folded to "-"), case-insensitive, first match wins.
 * Companies House prints "Active - Proposal to Strike off"; the spec writes it with an em dash,
 * so the separator is a dash or just a space. That row comes before plain "Active" and carries
 * the `proposal_to_strike_off` flag (the company is still `active`). Anything else is `unknown`;
 * the caller keeps `status_raw`.
 */
export const CH_MAP: StatusMap = [
  // The live page also prints "Active — Active proposal to strike off" (seen 9 Nov 2026).
  { pattern: /^active(?: ?- ?| )(?:active )?proposal to strike[ -]?off$/i, status: "active", flags: ["proposal_to_strike_off"] },
  { pattern: /^active$/i, status: "active" },
  { pattern: /^dissolved$/i, status: "dissolved" },
  {
    pattern:
      /^(?:liquidation|(?:in )?administration|receivership|receiver action|administrative receiver|voluntary arrangement|insolvency proceedings)$/i,
    status: "insolvency",
  },
  { pattern: /^(?:converted ?\/ ?closed|closed|removed)$/i, status: "removed" },
  { pattern: /^(?:open|registered)$/i, status: "active" },
];

const COMPANY_URL = "https://find-and-update.company-information.service.gov.uk/company/";

// A Companies House number is eight characters: eight digits, or two letters/digits for the
// register ("SC", "NI", "OC", "R0") then six digits.
const CH_NUMBER = /^(?:\d{8}|[A-Z0-9]{2}\d{6})$/;

/** The company URL for a number: uppercased, an all-digit number left-padded with zeros to
 *  eight. Null for anything that is not a Companies House number. */
function recordUrl(number: string): string | null {
  const n = number.trim().toUpperCase();
  const padded = /^\d{1,8}$/.test(n) ? n.padStart(8, "0") : n;
  return CH_NUMBER.test(padded) ? `${COMPANY_URL}${padded}` : null;
}

// ---------------------------------------------------------------------------
// Search page
// ---------------------------------------------------------------------------

const HEADING = /^\s*(?:\*\s+)?###\s+(.+?)\s*$/;
// "00502851 - Incorporated on 29 December 1951" / "SC702856 - Dissolved on 11 August 2026"
const NUMBER_LINE = /^([A-Za-z0-9]{8})\s+-\s+(.+?)\s+on\s+(.+?)\s*$/;

function readSearchRow(name: string, block: string[]): RegistryRow {
  let number: string | null = null;
  let dated: string | null = null; // "Incorporated on <date>", or another label that is no status
  let status_raw: string | null = null;
  let address: string | null = null;
  const previous: string[] = [];
  let inPrevious = false;

  for (const raw of block) {
    const line = raw.trim().replace(/\\$/, "").trim(); // a trailing backslash is a markdown line break
    if (line === "") continue;
    if (number !== null) {
      if (address === null) address = line;
      continue;
    }
    if (/^matching previous names:?$/i.test(line)) {
      inPrevious = true;
      continue;
    }
    const m = NUMBER_LINE.exec(line);
    if (m && CH_NUMBER.test(m[1]!.toUpperCase())) {
      number = m[1]!.toUpperCase();
      inPrevious = false;
      // A search row never says that a live company is active (or in liquidation, or about to be
      // struck off): "Incorporated on <date>" says when it began. Only a label that CH_MAP maps to
      // something other than active ("Dissolved on <date>") is a status. Any other label ("Registered
      // on", or one the map does not know) keeps its text in `detail` and leaves `status_raw` null.
      const label = tidy(m[2]!);
      const text = `${label} on ${m[3]}`;
      const mapped = applyStatusMap(CH_MAP, label).status;
      if (!/^incorporated$/i.test(label) && mapped !== "unknown" && mapped !== "active") status_raw = text;
      else dated = /^incorporated$/i.test(label) ? `Incorporated on ${m[3]}` : text;
      continue;
    }
    if (inPrevious) previous.push(line);
  }

  const detail = [dated, address, previous.length > 0 ? `previously ${previous.join(", ")}` : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return { name, number, status_raw, detail: detail === "" ? null : detail, url: number === null ? null : `${COMPANY_URL}${number}` };
}

/**
 * Read a search page fetched with the `#results` selector (see `searchFetchOptions`): one row
 * per `### NAME` heading. A heading with no number line is kept, with a null number, so it still
 * counts as a row for the ambiguity rule.
 */
function parseSearch(markdown: string): RegistryRow[] {
  const rows: RegistryRow[] = [];
  let name: string | null = null;
  let block: string[] = [];
  const flush = () => {
    if (name !== null) rows.push(readSearchRow(name, block));
  };
  for (const line of toLines(markdown)) {
    const h = HEADING.exec(line);
    if (h) {
      flush();
      name = tidy(h[1]!.replace(/^\[(.+)\]\(.*\)$/, "$1")); // a linked heading: keep the text
      block = [];
    } else if (name !== null) {
      block.push(line);
    }
  }
  flush();
  return rows.filter((row) => row.name !== "");
}

// ---------------------------------------------------------------------------
// Company page
// ---------------------------------------------------------------------------

export type ChRawFields = {
  company_type: string | null;
  address: string | null;
  sic_codes: { code: string; description: string }[];
  previous_names: { name: string; from: string | null; to: string | null }[];
  /** Only when the page shows a "Dissolved on" date. */
  dissolved_on?: string;
};

export interface ChRecord extends ParsedRecord {
  flags: Flag[];
  raw_fields: ChRawFields;
}

const LABELS = ["company status", "company type", "incorporated on", "dissolved on", "registered office address"];

/** The value after a `* Label` line: the next non-blank line without its bullet. Null when the
 *  label is missing, or the next line is another label or a heading (the value is missing). */
function fieldValue(lines: string[], label: string): string | null {
  const want = label.toLowerCase();
  const i = lines.findIndex((l) => l.trim().replace(/^\*\s+/, "").trim().toLowerCase() === want);
  if (i === -1) return null;
  const j = nextNonBlank(lines, i);
  if (j === -1) return null;
  const value = tidy(lines[j]!.trim().replace(/^\*\s+/, ""));
  if (value === "" || value.startsWith("#") || LABELS.includes(value.toLowerCase())) return null;
  return value;
}

/** The lines under a `## heading`, up to the next heading. */
function section(lines: string[], title: string): string[] {
  const start = lines.findIndex((l) => l.trim().toLowerCase().replace(/^##\s+/, "") === title.toLowerCase() && l.trim().startsWith("##"));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("#")) break;
    out.push(lines[i]!);
  }
  return out;
}

/**
 * Read a Companies House company page fetched as plain markdown. The page has no `# NAME`
 * heading: the name and number come from the navigation line "Company Overview for NAME
 * (NUMBER)", the status from the "Company status" block. A missing block is a null
 * `status_raw`, never a guess. Returns null when the page is clearly not a company page.
 */
function parseRecordPage(markdown: string, url?: string): ChRecord | null {
  const lines = toLines(markdown);

  let full_name: string | null = null;
  let licence_number: string | null = null;
  for (const line of lines) {
    const m = /^\s*(?:\*\s+)?Company Overview for (.+) \(([A-Za-z0-9]{8})\)\s*$/.exec(line);
    if (m) {
      full_name = tidy(m[1]!);
      licence_number = m[2]!.toUpperCase();
      break;
    }
  }
  const status_raw = fieldValue(lines, "Company status");
  const address = fieldValue(lines, "Registered office address");
  if (full_name === null && status_raw === null && address === null) return null;

  if (licence_number === null && url !== undefined) {
    const m = /\/company\/([A-Za-z0-9]{8})(?:[/?#]|$)/.exec(url);
    if (m) licence_number = m[1]!.toUpperCase();
  }

  const incorporated = fieldValue(lines, "Incorporated on");
  const dissolved = fieldValue(lines, "Dissolved on");
  const dissolved_on = dissolved === null ? null : parseHumanDate(dissolved);

  const sic_codes: ChRawFields["sic_codes"] = [];
  for (const line of section(lines, "Nature of business (SIC)")) {
    const m = /^\s*[*-]\s+(\d{4,5})\s+-\s+(.+?)\s*$/.exec(line);
    if (m) sic_codes.push({ code: m[1]!, description: tidy(m[2]!) });
  }

  const previous_names: ChRawFields["previous_names"] = [];
  for (const line of section(lines, "Previous company names")) {
    if (!line.trim().startsWith("|")) continue;
    const [name, period] = splitCells(line);
    if (!name || !period || /^-+$/.test(name) || name.toLowerCase() === "name") continue;
    const [from, to] = period.split(/\s+[-–—]\s+/);
    previous_names.push({ name: tidy(name), from: from ? parseHumanDate(from) : null, to: to ? parseHumanDate(to) : null });
  }

  const raw_fields: ChRawFields = {
    company_type: fieldValue(lines, "Company type"),
    address,
    sic_codes,
    previous_names,
    ...(dissolved_on === null ? {} : { dissolved_on }),
  };

  return {
    full_name,
    licence_number,
    status_raw,
    registered_since: incorporated === null ? null : parseHumanDate(incorporated),
    flags: applyStatusMap(CH_MAP, status_raw).flags,
    raw_fields,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** "Dissolved on 11 August 2026", the text of a search row, reads as "Dissolved". A page's own
 *  status block is the bare status, which this leaves alone. */
function withoutDate(raw: string | null): string | null {
  return raw === null ? null : raw.replace(/\s+on\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\s*$/i, "");
}

function normalizeStatus(raw: string | null, hints: { hasConditions?: boolean; hasInterimOrder?: boolean }) {
  return applyStatusMap(CH_MAP, withoutDate(raw), hints);
}

/** A parsed company page, or a search row passed in the same shape: both map correctly. */
function statusFromRecord(parsed: ParsedRecord, _todayIso: string): { status: Status; flags: Flag[] } {
  return applyStatusMap(CH_MAP, withoutDate(parsed.status_raw), {});
}

/** An Agent entry's status text through the same map (the date of "Dissolved on <date>" dropped).
 *  Companies House is read with Fetch, so this only keeps the adapter's shape. */
function statusFromAgentEntry(entry: AgentEntry, _todayIso: string): { status: Status; flags: Flag[] } {
  return applyStatusMap(CH_MAP, withoutDate(entry.status_raw), {});
}

// ---------------------------------------------------------------------------
// Agent (not used at launch)
// ---------------------------------------------------------------------------

/** Companies House is read with Fetch (a GET search and the company page), so no Agent run is
 *  made for it at launch. The goal, schema and result reader exist so the adapter has the same
 *  shape as the others; they are kept minimal. */
function goal(q: { variants: string[]; number?: string; profession?: string }): string {
  const variants = q.variants.map(quoteForGoal);
  const number = q.number !== undefined && q.number.trim() !== "" ? quoteForGoal(q.number) : null;
  if (variants.length === 0 && number === null) throw new Error("Companies House goal needs at least one name variant or a number");
  return [
    `Navigate to ${REGISTRY_META["companies-house"].searchUrl} to complete the goal. This is the Companies House company search.`,
    number !== null ? `Search by company number ${number}.` : `Search by company name, trying these variants one at a time, in order: ${variants.join(", ")}.`,
    "Do not open any company. Return blocked (true if a CAPTCHA or block page stopped you, with block_message), variants_tried, results_found and rows: each result row with name, number, status (the status text shown, if any) and detail (address).",
  ].join("\n");
}

const nullableString = { type: "string", nullable: true };

const outputSchema = {
  type: "object",
  required: ["blocked"],
  properties: {
    blocked: { type: "boolean" },
    block_message: nullableString,
    results_found: { type: "integer", nullable: true },
    variants_tried: { type: "array", items: { type: "string" } },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, number: nullableString, status: nullableString, detail: nullableString },
      },
    },
  },
};

/** Reads `rows[]` of the schema above. Companies House never opens an entry through the
 *  Agent, so `opened` is always null. Never throws. */
function parseAgentResult(result: unknown): AgentOutcome {
  const r = isRecord(result) ? result : {};
  const rows: RegistryRow[] = [];
  if (Array.isArray(r.rows)) {
    for (const item of r.rows) {
      if (!isRecord(item)) continue;
      const name = asText(item.name);
      if (name === null) continue;
      const num = asText(item.number)?.toUpperCase() ?? null;
      const number = num !== null && CH_NUMBER.test(num) ? num : null;
      rows.push({
        name,
        number,
        status_raw: asText(item.status),
        detail: asText(item.detail),
        url: number === null ? null : `${COMPANY_URL}${number}`,
      });
    }
  }
  return { ...readAgentBasics(r), rows, opened: null };
}

// ---------------------------------------------------------------------------
// Search read (TinyFetch)
// ---------------------------------------------------------------------------

/**
 * Read one page of the search results for `query` (page 1 unless `pageNumber` is given) with
 * TinyFetch and parse them. A page that was read and has
 * no result rows is `[]`. A read that failed (a Fetch error, `selector_not_matched` included, or
 * no result at all) THROWS a TinyFishError whose code and message name the Fetch error code,
 * because an empty list would read as `no_match` when the search never actually ran.
 */
async function fetchSearch(env: Env, query: string, pageNumber = 1): Promise<RegistryRow[]> {
  const page = await fetchPage(env, companiesHouse.searchQueryUrl(query, pageNumber), "markdown", companiesHouse.searchFetchOptions);
  if (!page.ok) {
    throw new TinyFishError(page.status ?? 502, page.error, `Companies House search could not be read: ${page.error}`);
  }
  return parseSearch(page.text);
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const companiesHouse = {
  id: "companies-house",
  name: REGISTRY_META["companies-house"].name,
  country: REGISTRY_META["companies-house"].country,
  recordTypes: ["company"],
  searchUrl: REGISTRY_META["companies-house"].searchUrl,
  allowSurnameOnly: false,
  browserProfile: "lite",
  decisionPages: [],
  outputSchema,
  goal,
  normalizeStatus,
  statusFromRecord,
  statusFromAgentEntry,
  recordUrl,
  parseRecordPage,
  fetchSearch,
  parseSearch,
  // The test fixture `ch-search.md` was recorded with exactly this option (see
  // tests/fixtures/registries/README.md), so it shows what production reads. It is needed
  // because plain markdown of the search page drops each company name (it is a link heading),
  // which would leave the exact-name match rule nothing to compare.
  // `fetchPage` takes these options, and `fetchSearch` passes them.
  searchFetchOptions: { include_selectors: ["#results"] },
  // Page 1 is the plain search URL (what the fixture recorded); later pages add `&page=N`.
  searchQueryUrl: (query: string, page = 1) =>
    `${REGISTRY_META["companies-house"].searchUrl}?q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`,
  // A full results page holds 20 companies (`ch-search.md`: 20 rows, page 1 of 57).
  searchPageRows: 20,
  // Companies House lists its 20 nearest names for anything, including a name no company has.
  searchNearest: true,
  parseAgentResult,
  // No Topic monitor for a company: Companies House is watched through its company page.
  topicQuery: undefined,
  // A Fetch search reads a 20-row page: a name match from a full page may have missed rows.
  agentRowsListed: 20,
  coverage: {
    lookup: "fetch",
    watch: "page",
    notes: "search and company pages are read with Fetch (the search with the #results selector, which keeps the company names); page 2 is read too when an exact name sits near the end of a full page",
  },
  noMatchSuggestions: ["Try the company number.", "Try the exact registered name, including LTD or PLC."],
} satisfies RegistryAdapter;
