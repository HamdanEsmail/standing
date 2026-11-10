import { AGENT_MAX_STEPS } from "../core/limits";
import { applyStatusMap, type Flag, type Status, type StatusMap } from "../core/status";
import { REGISTRY_META } from "./meta";
import { asText, isRecord, liveClauses, personMatchRuleLines, quoteGoalValue, readAgentBasics, splitCells, tidy, toLines } from "./parse-util";
import type { AgentEntry, AgentOutcome, DecisionEntry, ParsedRecord, RegistryAdapter, RegistryRow } from "./types";

/**
 * The NMC register's own registration-status terms (its glossary, `nmc-status-glossary.md`) to the
 * fixed status set. Matched on tidied text, case-insensitive, every pattern anchored, first match wins.
 * Interim orders are a status plus the `interim_order` flag; "Sanction pending" is still allowed to
 * practise until the appeal period ends, so it is `active` with `under_review`; a caution order and a
 * warning leave the person free to practise (`status_raw` keeps the word). Anything else is `unknown`.
 */
export const NMC_MAP: StatusMap = [
  { pattern: /^registered$/i, status: "active" },
  { pattern: /^not currently practi[cs]ing$/i, status: "not_licensed" },
  { pattern: /^removed by an? (?:fitness to practi[cs]e(?: \(ftp\))?|ftp) panel$/i, status: "removed" },
  { pattern: /^(?:struck off|voluntarily removed)$/i, status: "removed" },
  // The live register's wording of the glossary's "Voluntarily removed" (seen 9 Nov 2026).
  { pattern: /^removed by agreement\b/i, status: "removed" },
  { pattern: /^suspended by an? (?:fitness to practi[cs]e(?: \(ftp\))?|ftp) panel$/i, status: "suspended" },
  { pattern: /^interim suspension order$/i, status: "suspended", flags: ["interim_order"] },
  { pattern: /^conditions of practice order$/i, status: "conditions" },
  { pattern: /^interim conditions(?: of practice order)?$/i, status: "conditions", flags: ["interim_order"] },
  { pattern: /^undertakings$/i, status: "conditions" },
  { pattern: /^sanction pending$/i, status: "active", flags: ["under_review"] },
  { pattern: /^(?:caution order|warnings?)$/i, status: "active" },
  { pattern: /^lapsed$/i, status: "expired" },
  // The live register's headline for someone who is no longer registered (seen 9 Nov 2026); the reason
  // it prints with it is read by statusFromAgentEntry.
  { pattern: /^not on the register$/i, status: "not_licensed" },
];

// An NMC PIN: two digits, a letter, four digits, a letter ("22L4964O"). Read loosely: case and
// spaces do not matter.
const PIN = /^\d{2}[A-Z]\d{4}[A-Z]$/;

function asPin(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;
  const pin = text.replace(/[\s-]+/g, "").toUpperCase();
  return PIN.test(pin) ? pin : null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const CONDITIONS_TERMS = /\b(?:conditions of practice|interim conditions|undertakings?)\b/i;
const INTERIM = /\binterim\b/i;

function normalizeStatus(raw: string | null, hints: { hasConditions?: boolean; hasInterimOrder?: boolean }) {
  return applyStatusMap(NMC_MAP, raw, hints);
}

/** NMC has no record page, so this only maps the status term. */
function statusFromRecord(parsed: ParsedRecord, _todayIso: string): { status: Status; flags: Flag[] } {
  return applyStatusMap(NMC_MAP, parsed.status_raw);
}

/**
 * The opened entry's registration status through the NMC map. The sanctions text adds only what the
 * NMC's own words say is in force: a conditions of practice order, interim conditions or undertakings
 * (`active` becomes `conditions`), an interim order (`interim_order`). A clause that says it expired,
 * ended or was revoked, or runs "until" a date already past, counts for nothing. No status line: `unknown`.
 */
function statusFromAgentEntry(entry: AgentEntry, todayIso: string): { status: Status; flags: Flag[] } {
  if (entry.status_raw === null) return { status: "unknown", flags: [] };
  // "Not on the register" comes with the register's own reason ("Removed by Agreement - Outstanding
  // Fitness to Practice Question"), in the entry's text or on the same line after a dash (both seen live
  // on 9 Nov 2026): when that reason is one of the register's terms, it is the status.
  const headline = /^not on the register(?:\s+-\s+(.+))?$/i.exec(tidy(entry.status_raw));
  if (headline) {
    for (const reasonText of [headline[1], entry.sanctions_text]) {
      if (!reasonText) continue;
      const reason = applyStatusMap(NMC_MAP, reasonText);
      if (reason.status !== "unknown" && reason.status !== "not_licensed") return reason;
    }
    return { status: "not_licensed", flags: [] };
  }
  const live = entry.sanctions_text === null ? [] : liveClauses(entry.sanctions_text, todayIso);
  return applyStatusMap(NMC_MAP, entry.status_raw, {
    hasConditions: live.some((c) => CONDITIONS_TERMS.test(c)),
    hasInterimOrder: live.some((c) => INTERIM.test(c)),
  });
}

// ---------------------------------------------------------------------------
// Agent: goal, schema, result
// ---------------------------------------------------------------------------

/**
 * The one-run goal of spec 4.2 on the NMC register (nurses, midwives and nursing associates). Same
 * shape as the GMC goal: the variants in order, stop at the first that returns rows, open an entry
 * only on exactly one matching row, report EVERY matching row first, `results_found` the register's own
 * total. A PIN skips the name search. Every value from the caller is quoted on one line.
 */
function goal(q: { variants: string[]; number?: string; profession?: string }): string {
  const variants = q.variants.map(quoteGoalValue);
  const number = q.number !== undefined && q.number.trim() !== "" ? quoteGoalValue(q.number) : null;
  if (variants.length === 0 && number === null) throw new Error("NMC goal needs at least one name variant or a PIN");

  const search =
    number !== null
      ? [
          `Search by NMC PIN ${number}: enter that PIN in the PIN field and nothing else.`,
          `The entry to open is the one row whose PIN is exactly ${number}. If there is no such row, open nothing.`,
        ]
      : [
          "Search for the person with these name variants, one at a time, in this order. Enter a variant as the form takes it: the first name and the last name.",
          "Read a variant of two or more words as first name(s) then surname, except that a last word of one letter is a first-name initial after the surname (\"smith j\" is surname Smith, first name J).",
          ...variants.map((v, i) => `  ${i + 1}. ${v}`),
          "After each search read the results. Stop at the first variant that returns any result rows and do not try the later ones. If a variant returns no rows, try the next one.",
          "",
          ...personMatchRuleLines(),
        ];

  return [
    `Navigate to ${REGISTRY_META.nmc.searchUrl} to complete the goal. This is the NMC register of nurses, midwives and nursing associates. Use its 'Search the register' function, and no other site. A cookie banner is not a block: accept only the necessary cookies and go on.`,
    `You have at most ${AGENT_MAX_STEPS} steps, so do not explore other pages.`,
    "",
    ...search,
    "",
    "Return these fields, and use null for anything that is not shown on the page (never guess a value):",
    "  - blocked: true if a CAPTCHA or a block page stopped you, with the message shown in block_message; otherwise false.",
    "  - variants_tried: the variants you searched, in order, as entered (empty when you searched by PIN).",
    "  - results_found: the register's own total count of result rows for the search that returned results (the full count it shows, which can be more than the rows you list; 0 if none).",
    number !== null
      ? "  - rows: up to 10 of the result rows, in the order shown, each with name (as printed), number (the PIN if the row shows it), status (the registration status if shown) and detail (the register part and the geographical location, as shown)."
      : "  - rows: first EVERY result row whose name matches the searched name (all of them, even if that is more than 10), then, in the order shown, as many of the other result rows as fit, up to 10 rows in total. Each row has name (as printed), number (the PIN if the row shows it), status (the registration status if shown) and detail (the register part and the geographical location, as shown).",
    "  - for an entry you opened: full_name, pin, status (the registration status, as printed), register_part (the part of the register, e.g. Registered Nurse - Adult), location (the geographical location) and sanctions_text (any conditions of practice, undertakings, interim order, suspension, caution or warning text shown on the entry, as printed). If you opened no entry, all six are null.",
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
    pin: nullableString,
    status: nullableString,
    register_part: nullableString,
    location: nullableString,
    sanctions_text: nullableString,
  },
};

/**
 * Read an Agent result of the schema above. A row without a name is kept (with an empty name) when it
 * shows a PIN, a status or a detail: it is a registrant the run saw, so a sibling must not look like the
 * only candidate. The opened entry exists when it shows a name or a PIN; its register part and location
 * go to `raw_fields`. NMC has no per-record URL, so no URL is taken from the run. Never throws.
 */
function parseAgentResult(result: unknown): AgentOutcome {
  const r = isRecord(result) ? result : {};
  const rows: RegistryRow[] = [];
  for (const item of Array.isArray(r.rows) ? r.rows.filter(isRecord) : []) {
    const name = asText(item.name);
    const number = asPin(item.number);
    const status_raw = asText(item.status);
    const detail = asText(item.detail);
    if (name === null && number === null && status_raw === null && detail === null) continue;
    rows.push({ name: name ?? "", number, status_raw, detail, url: null });
  }

  const full_name = asText(r.full_name);
  const licence_number = asPin(r.pin);
  let opened: AgentEntry | null = null;
  if (full_name !== null || licence_number !== null) {
    const raw_fields: Record<string, unknown> = {};
    const register_part = asText(r.register_part);
    const location = asText(r.location);
    if (register_part !== null) raw_fields.register_part = register_part;
    if (location !== null) raw_fields.location = location;
    opened = { full_name, licence_number, status_raw: asText(r.status), url: null, sanctions_text: asText(r.sanctions_text), raw_fields };
  }
  return { ...readAgentBasics(r), rows, opened };
}

// ---------------------------------------------------------------------------
// Decision page: the monthly hearings and outcomes table
// ---------------------------------------------------------------------------

const HEARINGS_BASE = "https://www.nmc.org.uk/concerns-nurses-midwives/hearings/hearings-sanctions/";
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** The NMC hearings page for the month of `date` (`YYYY-MM-DD` or a Date, read in UTC). The page rolls
 *  monthly, so the shared monitor is moved to the new month's page by the hourly job. */
export function nmcHearingsPageUrl(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) throw new RangeError("nmcHearingsPageUrl needs a valid date");
  return `${HEARINGS_BASE}hearings-${MONTH_NAMES[d.getUTCMonth()]}-${d.getUTCFullYear()}/`;
}

/** One person listed on the hearings page. */
export interface NmcDecision extends DecisionEntry {
  name: string;
  number: string;
  /** The person's part(s) of the register, or null when the row does not say which part is theirs. */
  detail: string | null;
  /** The "Outcome and Reasons" text, or null when the page shows none (yet). */
  outcome: string | null;
}

const PIN_IN_TEXT = /\b(\d{2}[A-Za-z]\d{4}[A-Za-z])\b/g;

/** "Adult Nurse; CPNP;" as "Adult Nurse; CPNP" (null when nothing is left). */
function parts(text: string): string | null {
  const list = text.split(";").map(tidy).filter((p) => p !== "");
  return list.length === 0 ? null : list.join("; ");
}

/** A cell as one value: whitespace collapsed, null when empty. */
function text(cell: string): string | null {
  const t = tidy(cell);
  return t === "" ? null : t;
}

/** A cell shared by `people` people: one person gets the whole cell; several get one group each when
 *  the cell holds exactly one group per person (groups are separated by runs of three or more spaces,
 *  as the page prints them); otherwise nobody gets anything, because the page does not say whose it is. */
function perPerson(cell: string, people: number, read: (group: string) => string | null): (string | null)[] {
  if (people === 1) return [read(cell)];
  const groups = cell.split(/\s{3,}/).map(read).filter((g): g is string => g !== null);
  return groups.length === people ? groups : Array.from({ length: people }, () => null);
}

/**
 * Read the hearings page (markdown): one entry per person in the table, in page order. A row's first
 * cell holds one or more "SURNAME, Given names PIN" (several people can share a row); the date rows
 * ("**02 Nov**"), the header and the separator have no PIN and are skipped. The register part and the
 * outcome are given to each person by `perPerson`. Never throws.
 */
function parseDecisionPage(markdown: string): NmcDecision[] {
  const out: NmcDecision[] = [];
  let partCol = 1;
  let outcomeCol = 6;
  for (const raw of toLines(markdown)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = splitCells(line);
    const header = cells.findIndex((c) => /name\s*&\s*pin/i.test(c));
    if (header !== -1) {
      const part = cells.findIndex((c) => /part of register/i.test(c));
      const outcome = cells.findIndex((c) => /^outcome/i.test(c));
      if (part !== -1) partCol = part;
      if (outcome !== -1) outcomeCol = outcome;
      continue;
    }
    const first = (cells[0] ?? "").replace(/\*+/g, "");
    const people: { name: string; number: string }[] = [];
    let from = 0;
    for (const m of first.matchAll(PIN_IN_TEXT)) {
      const name = tidy(first.slice(from, m.index));
      from = m.index + m[0].length;
      if (name !== "") people.push({ name, number: m[1]!.toUpperCase() });
    }
    if (people.length === 0) continue;
    const details = perPerson(cells[partCol] ?? "", people.length, parts);
    const outcomes = perPerson(cells[outcomeCol] ?? "", people.length, text);
    people.forEach((p, i) => out.push({ ...p, detail: details[i] ?? null, outcome: outcomes[i] ?? null }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const nmc = {
  id: "nmc",
  name: REGISTRY_META.nmc.name,
  country: REGISTRY_META.nmc.country,
  recordTypes: ["nurse"],
  searchUrl: REGISTRY_META.nmc.searchUrl,
  // The NMC search takes a first and last name, or a PIN (its glossary page).
  allowSurnameOnly: false,
  // Standard browser only: Standing does not get past robot checks or CAPTCHAs; a register that refuses
  // automated visitors is reported as blocked.
  browserProfile: "lite",
  decisionPages: [{ label: "NMC hearings and outcomes, November 2026", url: nmcHearingsPageUrl("2026-11-01") }],
  decisionPageFor: (now) => ({
    label: `NMC hearings and outcomes, ${now.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}`,
    url: nmcHearingsPageUrl(now),
  }),
  outputSchema,
  goal,
  normalizeStatus,
  statusFromRecord,
  statusFromAgentEntry,
  parseAgentResult,
  agentRowsListed: 10,
  // No per-record URL exists on the NMC register.
  recordUrl: undefined,
  topicQuery: (fullName: string) => `"${tidy(fullName).replace(/"/g, "")}" nurse NMC hearing OR sanction OR "struck off"`,
  parseDecisionPage,
  coverage: {
    lookup: "agent",
    watch: "topic+decisions",
    notes:
      "covers nurses, midwives and nursing associates (the register part is in raw_fields.register_part); no per-record URL, so a record is watched with a Topic monitor and the shared monthly hearings page; the NMC search sometimes shows a robot check, and Standing then answers \"blocked\" and does not go around it",
  },
  noMatchSuggestions: ["Try the NMC PIN.", "The NMC search needs the exact first name and surname."],
} satisfies RegistryAdapter;
