import { AGENT_MAX_STEPS } from "../core/limits";
import { applyStatusMap, type Flag, type Status, type StatusMap } from "../core/status";
import { REGISTRY_META } from "./meta";
import { asDigits, asText, isRecord, notRegisterName, quoteGoalValue, readAgentBasics, tidy } from "./parse-util";

// The register's own names, which a run that could not read a licence page has reported as the business.
const REGISTER_NAME = /contractors.{0,3}state license board|department of consumer affairs/i;
// CSLB's standing disclaimer on every licence page; it is not a sanction.
const DISCLAIMER = /^disclaimer:/i;
import type { AgentEntry, AgentOutcome, ParsedRecord, RegistryAdapter, RegistryRow } from "./types";

/**
 * CSLB prints a licence's status as a sentence ("This license is current and active.", "This license
 * is revoked and not able to contract at this time."). Only its first sentence is the status: the
 * sentences after it describe other things ("A prior license was revoked."). The patterns run on that
 * first sentence, tidied, case-insensitive, first match wins, so "revoked and suspended" is `removed`.
 * "This license is not current and active." matches nothing and is `unknown`, like anything else.
 */
export const CSLB_MAP: StatusMap = [
  { pattern: /^(?:this licen[cs]e is )?(?:current and )?active$/i, status: "active" },
  { pattern: /^(?:this licen[cs]e (?:is|has been) )?revoked\b/i, status: "removed" },
  { pattern: /^(?:this licen[cs]e (?:is|has been) )?cancell?ed\b/i, status: "removed" },
  { pattern: /^(?:this licen[cs]e (?:is|has been) )?suspended\b/i, status: "suspended" },
  { pattern: /^(?:this licen[cs]e (?:is|has) )?expired\b/i, status: "expired" },
  { pattern: /^(?:this licen[cs]e is )?inactive\b/i, status: "not_licensed" },
];

/** The first sentence of a CSLB status text, without its full stop. */
function firstSentence(raw: string | null): string | null {
  if (raw === null) return null;
  const first = tidy(raw).split(/\.(?:\s|$)/)[0] ?? "";
  return first === "" ? null : first;
}

function normalizeStatus(raw: string | null, hints: { hasConditions?: boolean; hasInterimOrder?: boolean }) {
  return applyStatusMap(CSLB_MAP, firstSentence(raw), hints);
}

/** CSLB has no record page read by Fetch (a licence page read by Fetch comes back as the search page); this maps the status sentence. */
function statusFromRecord(parsed: ParsedRecord, _todayIso: string): { status: Status; flags: Flag[] } {
  return applyStatusMap(CSLB_MAP, firstSentence(parsed.status_raw));
}

/** The status sentence only. The sanctions text (a bond notice, a citation) is kept with the record as
 *  a restriction but never read as a status. No status sentence: `unknown`. */
function statusFromAgentEntry(entry: AgentEntry, _todayIso: string): { status: Status; flags: Flag[] } {
  if (entry.status_raw === null) return { status: "unknown", flags: [] };
  return applyStatusMap(CSLB_MAP, firstSentence(entry.status_raw));
}

// ---------------------------------------------------------------------------
// Agent: goal, schema, result
// ---------------------------------------------------------------------------

/**
 * The one-run goal: start at CheckLicense.aspx, search there by
 * business name or licence number, and read the licence detail page in the same run by opening it
 * from the results, never by typing an address (Fetch cannot read those pages). The business match
 * rule of spec 4.5 is spelled out: the name with its suffix, ignoring case and punctuation. EVERY
 * matching row is reported first; `results_found` is the register's own total. Values are quoted on
 * one line.
 */
function goal(q: { variants: string[]; number?: string; profession?: string }): string {
  const variants = q.variants.map(quoteGoalValue);
  const number = q.number !== undefined && q.number.trim() !== "" ? quoteGoalValue(q.number) : null;
  if (variants.length === 0 && number === null) throw new Error("CSLB goal needs a business name or a licence number");

  const search =
    number !== null
      ? [
          `Search by licence number ${number}: enter that number in the License Number search and nothing else.`,
          `The licence to open is the one whose license number is exactly ${number}. If there is no such licence, open nothing.`,
        ]
      : [
          "Search by business name: enter these names in the Business Name search, one at a time, in this order. Stop at the first that returns any result rows and do not try the later ones.",
          ...variants.map((v, i) => `  ${i + 1}. ${v}`),
          "",
          "The searched name is name 1. Open a licence only when exactly one result row's business name matches the searched name; otherwise open nothing and just report the rows.",
          "A row matches when its business name is the same as the searched name, ignoring capital letters, punctuation and extra spaces, and reading these suffixes as the same: LTD and LIMITED, INC and INCORPORATED, CO and COMPANY, PLC and PUBLIC LIMITED COMPANY (\"&\" reads as \"and\").",
          "A name with a different or missing suffix does not match (\"Acme Roofing Inc\" is not \"Acme Roofing LLC\", and not \"Acme Roofing\"). If no row matches, or two or more rows match, do not open anything.",
        ];

  return [
    `Navigate to ${REGISTRY_META.cslb.searchUrl} to complete the goal. This is the California Contractors State License Board "Check a License" page. Use it and no other site.`,
    "Read the licence detail page in this same run by opening it from the search results; never type a licence page address yourself.",
    "On the licence detail page the business name, the licence status, the classifications and the city are below the disclaimer and the \"Is this your license?\" banner: scroll down to read them. If the search took you to a licence detail page, results_found is at least 1, even if you could not read the fields.",
    `You have at most ${AGENT_MAX_STEPS} steps, so do not explore other pages.`,
    "",
    ...search,
    "",
    "Return these fields, and use null for anything that is not shown on the page (never guess a value):",
    "  - blocked: true if a CAPTCHA or a block page stopped you, with the message shown in block_message; otherwise false.",
    "  - variants_tried: the names you searched, in order, as entered (empty when you searched by licence number).",
    "  - results_found: the register's own total count of result rows for the search that returned results (the full count it shows, which can be more than the rows you list; 0 if none).",
    number !== null
      ? "  - rows: up to 10 of the result rows, in the order shown, each with name (the business name as printed), number (the license number), status (the status shown on the row, if any) and detail (the classification(s) and the city, as shown)."
      : "  - rows: first EVERY result row whose name matches the searched name (all of them, even if that is more than 10), then, in the order shown, as many of the other result rows as fit, up to 10 rows in total. Each row has name (the business name as printed), number (the license number), status (the status shown on the row, if any) and detail (the classification(s) and the city, as shown).",
    "  - for a licence you opened (read on its detail page in this same run): business_name, license_number, status (the licence status sentence as printed, e.g. \"This license is current and active.\"), classifications (as printed), city, and sanctions_text (any disciplinary action, citation, bond or suspension notice shown, as printed). If you opened no licence, all six are null.",
  ].join("\n");
}

const nullableString = { type: "string", nullable: true };

/** JSON Schema for the Agent run's `output_schema`. */
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
    business_name: nullableString,
    license_number: nullableString,
    status: nullableString,
    classifications: nullableString,
    city: nullableString,
    sanctions_text: nullableString,
  },
};

/**
 * Read an Agent result of the schema above. A CSLB licence number is digits only. A row without a name
 * is kept (with an empty name) when it shows a number, a status or a detail. The opened licence exists
 * when it shows a business name or a licence number; its classifications and city go to `raw_fields`.
 * No URL from the run is trusted: a licence page is not readable by Fetch, so the record's source is the
 * search page. Never throws.
 */
function parseAgentResult(result: unknown): AgentOutcome {
  const r = isRecord(result) ? result : {};
  const rows: RegistryRow[] = [];
  for (const item of Array.isArray(r.rows) ? r.rows.filter(isRecord) : []) {
    const name = notRegisterName(asText(item.name), REGISTER_NAME);
    const number = asDigits(item.number);
    const status_raw = asText(item.status);
    const detail = asText(item.detail);
    if (name === null && number === null && status_raw === null && detail === null) continue;
    rows.push({ name: name ?? "", number, status_raw, detail, url: null });
  }

  const full_name = notRegisterName(asText(r.business_name), REGISTER_NAME);
  const licence_number = asDigits(r.license_number);
  let opened: AgentEntry | null = null;
  if (full_name !== null || licence_number !== null) {
    const raw_fields: Record<string, unknown> = {};
    const classifications = asText(r.classifications);
    const city = asText(r.city);
    if (classifications !== null) raw_fields.classifications = classifications;
    if (city !== null) raw_fields.city = city;
    opened = { full_name, licence_number, status_raw: asText(r.status), url: null, sanctions_text: DISCLAIMER.test(asText(r.sanctions_text) ?? "") ? null : asText(r.sanctions_text), raw_fields };
  }
  return { ...readAgentBasics(r), rows, opened };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const cslb = {
  id: "cslb",
  name: REGISTRY_META.cslb.name,
  country: REGISTRY_META.cslb.country,
  recordTypes: ["contractor"],
  searchUrl: REGISTRY_META.cslb.searchUrl,
  // A contractor is a business: the classifier uses the business rule, so this is never read.
  allowSurnameOnly: false,
  // Standard browser only: Standing does not get past robot checks or CAPTCHAs; a register that refuses
  // automated visitors is reported as blocked.
  browserProfile: "lite",
  decisionPages: [],
  outputSchema,
  goal,
  normalizeStatus,
  statusFromRecord,
  statusFromAgentEntry,
  parseAgentResult,
  agentRowsListed: 10,
  // No record page: a licence page read by Fetch is the search page (fixtures cslb-detail-*.md),
  // so the lookup is the Agent's and the watch is a Topic monitor.
  recordUrl: undefined,
  parseRecordPage: undefined,
  recordFetchOptions: undefined,
  topicQuery: (businessName: string) => `"${tidy(businessName).replace(/"/g, "")}" contractor CSLB license OR revoked OR suspended OR citation`,
  coverage: {
    lookup: "agent",
    watch: "topic",
    notes: "licence pages are not readable by Fetch (they redirect to the search page)",
  },
  noMatchSuggestions: ["Try the CSLB licence number.", "Try the exact business name as licensed, including INC or LLC."],
} satisfies RegistryAdapter;
