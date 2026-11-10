import { AGENT_MAX_STEPS } from "../core/limits";
import { applyStatusMap, type Flag, type Status, type StatusMap } from "../core/status";
import { REGISTRY_META } from "./meta";
import { asDigits, asText, isRecord, liveClauses, nextNonBlank, parseHumanDate, personMatchRuleLines, quoteGoalValue, readAgentBasics, tidy, toLines } from "./parse-util";
import type { AgentEntry, AgentOutcome, DecisionEntry, ParsedRecord, RegistryAdapter, RegistryRow } from "./types";

/**
 * The SRA register's status terms for a person (its glossary, `sra-status-glossary.md`) to the fixed
 * status set. Matched on tidied text (every dash folded to "-"), case-insensitive, anchored, first
 * match wins; the "(Conditions apply)" and ", not practising" rows come before the bare solicitor row
 * (anchoring alone already keeps them apart). "Prohibited" means not allowed to practise: `removed`,
 * with `status_raw` keeping the word. The firm terms are not a person's status and stay `unknown`.
 */
export const SRA_MAP: StatusMap = [
  { pattern: /^sra[- ]regulated solicitor \(conditions apply\)$/i, status: "conditions" },
  { pattern: /^sra[- ]regulated solicitor, not practi[cs]ing$/i, status: "not_licensed" },
  { pattern: /^sra[- ]regulated solicitor$/i, status: "active" },
  { pattern: /^sra[- ]regulated (?:lawyer|freelance)$/i, status: "active" },
  { pattern: /^not an sra[- ]regulated lawyer$/i, status: "not_licensed" },
  { pattern: /^prohibited$/i, status: "removed" },
];

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const CONDITIONS_APPLY = /\bconditions apply\b/i;
const INTERIM = /\binterim\b/i;
// Both wordings seen live (9 Nov 2026): "suspended from practice as a solicitor…" and "Suspended from 25/09/2026".
const SUSPENDED_FROM_PRACTICE = /\bsuspended (?:from|until|for)\b/i;
const STRUCK_OFF = /\bstruck off\b/i;

function normalizeStatus(raw: string | null, hints: { hasConditions?: boolean; hasInterimOrder?: boolean }) {
  return applyStatusMap(SRA_MAP, raw, hints);
}

/** The SRA has no record page, so this only maps the status term. */
function statusFromRecord(parsed: ParsedRecord, _todayIso: string): { status: Status; flags: Flag[] } {
  return applyStatusMap(SRA_MAP, parsed.status_raw);
}

/**
 * The opened entry's status through the SRA map. The sanctions text adds only what the SRA's own words
 * say is in force: "conditions apply" (`active` becomes `conditions`) and an interim measure
 * (`interim_order`); a rebuke or a fine changes nothing. No status line: `unknown`.
 */
function statusFromAgentEntry(entry: AgentEntry, todayIso: string): { status: Status; flags: Flag[] } {
  if (entry.status_raw === null) return { status: "unknown", flags: [] };
  const live = entry.sanctions_text === null ? [] : liveClauses(entry.sanctions_text, todayIso);
  // The register shows "Prohibited" for a solicitor suspended from practice too (seen 9 Nov 2026): when
  // the entry's own decision text says a suspension is in force, the status is `suspended`, not `removed`.
  if (/^prohibited$/i.test(tidy(entry.status_raw)) && live.some((c) => SUSPENDED_FROM_PRACTICE.test(c)) && !live.some((c) => STRUCK_OFF.test(c))) {
    return { status: "suspended", flags: [] };
  }
  return applyStatusMap(SRA_MAP, entry.status_raw, {
    hasConditions: live.some((c) => CONDITIONS_APPLY.test(c)),
    hasInterimOrder: live.some((c) => INTERIM.test(c)),
  });
}

// ---------------------------------------------------------------------------
// Agent: goal, schema, result
// ---------------------------------------------------------------------------

/**
 * The one-run goal of spec 4.2 on the SRA register (solicitors). Same shape as the GMC goal: the
 * variants in order, stop at the first that returns rows, open an entry only on exactly one matching
 * row, report EVERY matching row first, `results_found` the register's own total. An SRA ID skips the
 * name search. Every value from the caller is quoted on one line.
 */
function goal(q: { variants: string[]; number?: string; profession?: string }): string {
  const variants = q.variants.map(quoteGoalValue);
  const number = q.number !== undefined && q.number.trim() !== "" ? quoteGoalValue(q.number) : null;
  if (variants.length === 0 && number === null) throw new Error("SRA goal needs at least one name variant or an SRA ID");

  const search =
    number !== null
      ? [
          `Search for a person by SRA ID (SRA number) ${number}: enter that number in the search and nothing else.`,
          `The entry to open is the one person whose SRA ID is exactly ${number}. If there is no such person, open nothing.`,
        ]
      : [
          "Search for the person (a solicitor or another person the SRA regulates, not a firm) with these name variants, one at a time, in this order. Enter a variant as the search takes it.",
          "Read a variant of two or more words as first name(s) then surname, except that a last word of one letter is a first-name initial after the surname (\"smith j\" is surname Smith, first name J).",
          ...variants.map((v, i) => `  ${i + 1}. ${v}`),
          "After each search read the results for people. Stop at the first variant that returns any result rows and do not try the later ones. If a variant returns no rows, try the next one.",
          "",
          ...personMatchRuleLines(),
        ];

  return [
    `Navigate to ${REGISTRY_META.sra.searchUrl} to complete the goal. This is the SRA Solicitors Register. Use its search, and no other site. A cookie banner is not a block: accept only the necessary cookies and go on.`,
    `You have at most ${AGENT_MAX_STEPS} steps, so do not explore other pages.`,
    "",
    ...search,
    "",
    "Return these fields, and use null for anything that is not shown on the page (never guess a value):",
    "  - blocked: true if a CAPTCHA or a block page stopped you, with the message shown in block_message; otherwise false.",
    "  - variants_tried: the variants you searched, in order, as entered (empty when you searched by SRA ID).",
    "  - results_found: the register's own total count of result rows for the search that returned results (the full count it shows, which can be more than the rows you list; 0 if none).",
    number !== null
      ? "  - rows: up to 10 of the result rows, in the order shown, each with name (as printed), number (the SRA ID if the row shows it), status (the status text if shown) and detail (the admission date and the firm, as shown)."
      : "  - rows: first EVERY result row whose name matches the searched name (all of them, even if that is more than 10), then, in the order shown, as many of the other result rows as fit, up to 10 rows in total. Each row has name (as printed), number (the SRA ID if the row shows it), status (the status text if shown) and detail (the admission date and the firm, as shown).",
    "  - for an entry you opened: full_name, sra_number (the SRA ID), status (the status text as printed, e.g. SRA-regulated solicitor), admission_date (as printed), firm (the firm the person works at, as printed) and sanctions_text (any conditions, restrictions, interim measure, prohibition, rebuke, fine or other regulatory decision shown on the entry, as printed). If you opened no entry, all six are null.",
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
    full_name: nullableString,
    sra_number: nullableString,
    status: nullableString,
    admission_date: nullableString,
    firm: nullableString,
    sanctions_text: nullableString,
  },
};

/**
 * Read an Agent result of the schema above. An SRA ID is digits only and is kept as printed (leading
 * zeros included). A row without a name is kept (with an empty name) when it shows a number, a status
 * or a detail. The opened entry exists when it shows a name or an SRA ID; its admission date and firm go
 * to `raw_fields`. The SRA has no per-record URL, so no URL is taken from the run. Never throws.
 */
function parseAgentResult(result: unknown): AgentOutcome {
  const r = isRecord(result) ? result : {};
  const rows: RegistryRow[] = [];
  for (const item of Array.isArray(r.rows) ? r.rows.filter(isRecord) : []) {
    const name = asText(item.name);
    const number = asDigits(item.number);
    const status_raw = asText(item.status);
    const detail = asText(item.detail);
    if (name === null && number === null && status_raw === null && detail === null) continue;
    rows.push({ name: name ?? "", number, status_raw, detail, url: null });
  }

  const full_name = asText(r.full_name);
  const licence_number = asDigits(r.sra_number);
  let opened: AgentEntry | null = null;
  if (full_name !== null || licence_number !== null) {
    const raw_fields: Record<string, unknown> = {};
    const admission_date = asText(r.admission_date);
    const firm = asText(r.firm);
    if (admission_date !== null) raw_fields.admission_date = admission_date;
    if (firm !== null) raw_fields.firm = firm;
    opened = { full_name, licence_number, status_raw: asText(r.status), url: null, sanctions_text: asText(r.sanctions_text), raw_fields };
  }
  return { ...readAgentBasics(r), rows, opened };
}

// ---------------------------------------------------------------------------
// Decision page: recent decisions
// ---------------------------------------------------------------------------

/** One entry of the SRA's recent decisions page. */
export interface SraDecision extends DecisionEntry {
  /** The person or firm, as printed. */
  name: string;
  /** The SRA number, as printed (leading zeros kept). */
  number: string;
  /** The decision date as ISO `YYYY-MM-DD`, or null when it is not a real date. */
  date: string | null;
  /** The decision type printed under the entry, or null when there is none. */
  decision: string | null;
}

// "Anthony Saldermere - 9465127, 03 November 2026". The name is greedy, so a name holding " - " keeps it.
const ENTRY = /^(.+) - (\d{1,12}), (\d{1,2} [A-Za-z]{3,9} \d{4})$/;

/** An entry line, tidied, with any bullet and link markup removed; null when the line is not one. */
function entryLine(line: string): RegExpExecArray | null {
  const text = tidy(line.replace(/^\s*[*-]\s+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*+/g, ""));
  return ENTRY.exec(text);
}

/**
 * Read the recent decisions page (markdown): each "Name - SRA number, date" line is one entry, and the
 * next non-blank line is its decision type unless it is another entry or a heading. Never throws.
 */
function parseDecisionPage(markdown: string): SraDecision[] {
  const lines = toLines(markdown);
  const out: SraDecision[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = entryLine(lines[i]!);
    if (!m) continue;
    const j = nextNonBlank(lines, i);
    const next = j === -1 ? "" : tidy(lines[j]!);
    const decision = next === "" || next.startsWith("#") || entryLine(next) !== null ? null : next;
    out.push({ name: tidy(m[1]!), number: m[2]!, date: parseHumanDate(m[3]!), decision });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const sra = {
  id: "sra",
  name: REGISTRY_META.sra.name,
  country: REGISTRY_META.sra.country,
  recordTypes: ["solicitor"],
  searchUrl: REGISTRY_META.sra.searchUrl,
  allowSurnameOnly: false,
  // Standard browser only: Standing does not get past robot checks or CAPTCHAs; a register that refuses
  // automated visitors is reported as blocked.
  browserProfile: "lite",
  decisionPages: [{ label: "SRA recent decisions", url: "https://www.sra.org.uk/consumers/solicitor-check/recent-decisions/" }],
  outputSchema,
  goal,
  normalizeStatus,
  statusFromRecord,
  statusFromAgentEntry,
  parseAgentResult,
  agentRowsListed: 10,
  // No record page is read: the register's person pages are reached through its search.
  recordUrl: undefined,
  topicQuery: (fullName: string) => `"${tidy(fullName).replace(/"/g, "")}" solicitor SRA OR "Solicitors Disciplinary Tribunal" OR "struck off"`,
  parseDecisionPage,
  coverage: {
    lookup: "agent",
    watch: "topic+decisions",
    notes: "no per-record URL, so a record is watched with a Topic monitor and the shared recent decisions page",
  },
  noMatchSuggestions: ["Try the SRA ID (SRA number).", "Check the spelling of the first name and surname as the SRA register shows them."],
} satisfies RegistryAdapter;
