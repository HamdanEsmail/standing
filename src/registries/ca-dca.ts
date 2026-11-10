import { AGENT_MAX_STEPS } from "../core/limits";
import { hasBusinessSuffix } from "../core/names";
import { applyStatusMap, type Flag, type Status, type StatusMap } from "../core/status";
import { REGISTRY_META } from "./meta";
import {
  asText,
  isRecord,
  liveClauses,
  nextNonBlank,
  personMatchRuleLines,
  quoteGoalValue,
  readAgentBasics,
  tidy,
  toLines,
  notRegisterName,
} from "./parse-util";

// The register's own name, never a licensee's.
const REGISTER_NAME = /^(?:california )?department of consumer affairs$/i;
import type { AgentEntry, AgentOutcome, ParsedRecord, RegistryAdapter, RegistryRow } from "./types";

/**
 * California DCA licence statuses (the boards share one search, search.dca.ca.gov) to the fixed set.
 * Matched on tidied text, case-insensitive, anchored, first match wins. Anything else is `unknown`.
 */
export const DCA_MAP: StatusMap = [
  { pattern: /^(?:clear|current|active|valid)$/i, status: "active" },
  { pattern: /^probation$/i, status: "conditions" },
  { pattern: /^suspended$/i, status: "suspended" },
  { pattern: /^(?:revoked|surrendered|(?:license )?cancell?ed)$/i, status: "removed" },
  { pattern: /^(?:expired|delinquent)$/i, status: "expired" },
  { pattern: /^inactive$/i, status: "not_licensed" },
];

// ---------------------------------------------------------------------------
// Licence codes and the record URL (the register's real form is /profile/<board>/<type>/<n>/)
// ---------------------------------------------------------------------------

interface LicenceCode {
  board: string;
  type: string;
  /** A fixed last segment some boards add ("PPO"). */
  suffix?: string;
  /** The licence number carries a letter that goes in the last segment (physicians: "A 189044"). */
  letterSuffix?: boolean;
  /** A business licence: a name searched with this profession is matched with the business rule. */
  business: boolean;
}

/**
 * The professions whose board and licence-type codes were confirmed from real DCA licence URLs on
 * 3 Nov 2026. Nothing is guessed: "automotive repair" (1310/RC or ARD) is a real BAR licence, but the
 * meaning of its code was not confirmed, so it is not here. A DCA number lookup needs one of these
 * (the record address carries the board and the licence type); a name search without a profession spans every board.
 */
export const DCA_LICENCE_CODES: Readonly<Record<string, LicenceCode>> = Object.freeze({
  pharmacy: { board: "7200", type: "PHY", business: true },
  "pharmacy technician": { board: "7200", type: "TCH", business: false },
  "smog station": { board: "1310", type: "TC", business: true },
  "private patrol operator": { board: "120", type: "1204", suffix: "PPO", business: true },
  physician: { board: "800", type: "8002", letterSuffix: true, business: false },
});

/** The profession as a key of DCA_LICENCE_CODES: case and spacing do not matter. Own keys only, so
 *  "constructor" or "__proto__" is not a profession. */
function codeFor(profession: string | undefined | null): LicenceCode | null {
  if (profession === undefined || profession === null) return null;
  const key = tidy(profession).toLowerCase();
  return key !== "" && Object.hasOwn(DCA_LICENCE_CODES, key) ? DCA_LICENCE_CODES[key]! : null;
}

/**
 * A DCA licence number as the pages print it: digits, optionally after a type prefix. A one-letter
 * prefix is part of the number (a physician's "A 189044") and is kept, upper-cased, with one space; a
 * longer prefix is the licence type ("PHY 59020") and is dropped. Anything else is null.
 */
function dcaNumber(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;
  const m = /^([A-Za-z]{1,4})?\s*(\d{1,12})$/.exec(tidy(text));
  if (!m) return null;
  return m[1] !== undefined && m[1].length === 1 ? `${m[1].toUpperCase()} ${m[2]}` : m[2]!;
}

/**
 * The licence page for a number and a profession, or null: without a profession that has a confirmed
 * code, for a number that is not a number, and for a physician number without its letter.
 */
function recordUrl(number: string, profession?: string): string | null {
  const code = codeFor(profession);
  const n = dcaNumber(number);
  if (code === null || n === null) return null;
  const [letter, digits] = n.includes(" ") ? n.split(" ") : [null, n];
  const base = `https://search.dca.ca.gov/profile/${code.board}/${code.type}/${digits}/`;
  if (code.letterSuffix) return letter === null ? null : `${base}${letter}/`;
  return code.suffix === undefined ? base : `${base}${code.suffix}/`;
}

/** Person or business, per check (spec 4.5 rule by subject): a business licence type, or a name that
 *  ends with a legal form (which wins over a person's profession), reads as a business. */
function subjectOf(query: string, profession?: string): "person" | "business" {
  return hasBusinessSuffix(query) || codeFor(profession)?.business === true ? "business" : "person";
}

// ---------------------------------------------------------------------------
// Record page
// ---------------------------------------------------------------------------

/** "07/31/2027" or "March 5, 2012" (US forms) as ISO, or null when it is not a real date. */
function usDate(text: string): string | null {
  const t = tidy(text);
  let y: number, mo: number, d: number;
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const long = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(t);
  if (numeric) {
    [mo, d, y] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
  } else if (long) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    mo = months.indexOf(long[1]!.slice(0, 3).toLowerCase()) + 1;
    [d, y] = [Number(long[2]), Number(long[3])];
    if (mo === 0) return null;
  } else {
    return null;
  }
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The value of a "Label: value" line in `lines`, tidied, or null. */
function labelled(lines: string[], label: RegExp): string | null {
  for (const line of lines) {
    const m = label.exec(line.trim());
    if (m) {
      const v = tidy(m[1] ?? "");
      if (v !== "") return v;
    }
  }
  return null;
}

/** The licence number from a profile URL (/profile/<board>/<type>/<n>/[letter]/). */
function numberFromUrl(url: string | undefined): string | null {
  if (url === undefined) return null;
  const m = /\/profile\/[^/]+\/[^/]+\/(\d{1,12})\/(?:([A-Za-z])\/)?/.exec(url);
  if (!m) return null;
  return m[2] === undefined ? m[1]! : `${m[2].toUpperCase()} ${m[1]}`;
}

export interface DcaRecord extends ParsedRecord {
  raw_fields: { board: string | null; licence_type: string | null; address: string | null };
}

/**
 * Read a DCA licence page (markdown). The licensee is described above the first section heading after
 * "Licensing details for:" ("License Relationships", "Owners, Qualified Managers and Principals", ...);
 * everything below it is about other people or licences and is never read as the licensee: the name is
 * the licensee section's "Name:" line, never a related party's. The status is the "License Status:"
 * line; only when the page has none, the "Primary Status:" of the relationship row that carries this
 * licence's own number. The note under a revoked licence that mentions "valid" is not a status. Returns
 * null for a page that is not a DCA licence page.
 */
function parseRecordPage(markdown: string, url?: string): DcaRecord | null {
  const lines = toLines(markdown);
  const isLicencePage = lines.some((l) => /^(?:#+\s*)?Licensing details for:|^License (?:Type|Status):/i.test(l.trim()));
  if (!isLicencePage) return null;

  // The licensee section ends at the first heading that names another part of the page.
  const end = lines.findIndex((l) => /^##\s+\S/.test(l.trim()) && !/^##\s+Licensing details for:/i.test(l.trim()));
  const own = end === -1 ? lines : lines.slice(0, end);
  const rest = end === -1 ? [] : lines.slice(end);

  const board = own.map((l) => /^#\s+(\S.*)$/.exec(l.trim())).find((m) => m)?.[1] ?? null;
  const detailsFor = labelled(own, /^(?:#+\s*)?Licensing details for:\s*(.*)$/i);
  const licence_number = (detailsFor === null ? null : dcaNumber(detailsFor)) ?? numberFromUrl(url);
  const full_name = labelled(own, /^Name:\s*(.*)$/i);
  const licence_type = labelled(own, /^License Type:\s*(.*)$/i);

  let status_raw = labelled(own, /^License Status:\s*(.*)$/i);
  if (status_raw === null && licence_number !== null) {
    const digits = licence_number.replace(/\D/g, "");
    for (const line of rest) {
      const m = /^License Number:\s*(\S+)\s+Primary Status:\s*(.+)$/i.exec(line.trim());
      if (m && m[1]!.replace(/\D/g, "") === digits) {
        status_raw = tidy(m[2]!);
        break;
      }
    }
  }

  let address: string | null = null;
  const at = own.findIndex((l) => /^Address:?$/i.test(l.trim()));
  if (at !== -1) {
    const parts: string[] = [];
    for (let i = nextNonBlank(own, at); i !== -1 && i < own.length && own[i]!.trim() !== ""; i++) parts.push(tidy(own[i]!));
    if (parts.length > 0) address = parts.join(", ");
  }

  const expiry = labelled(own, /^(?:Expiration|Expiry) Date:\s*(.*)$/i);
  const issued = labelled(own, /^(?:Issue|Issuance|Original Issue) Date:\s*(.*)$/i);

  return {
    full_name,
    licence_number,
    status_raw,
    registered_since: issued === null ? null : usDate(issued),
    expiry_date: expiry === null ? null : usDate(expiry),
    raw_fields: { board: board === null ? null : tidy(board), licence_type, address },
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const PROBATION = /\bprobation\b/i;
const INTERIM = /\binterim\b/i;

function normalizeStatus(raw: string | null, hints: { hasConditions?: boolean; hasInterimOrder?: boolean }) {
  return applyStatusMap(DCA_MAP, raw, hints);
}

/** The page's "License Status:" through the DCA map; a null status is `unknown`. */
function statusFromRecord(parsed: ParsedRecord, _todayIso: string): { status: Status; flags: Flag[] } {
  return applyStatusMap(DCA_MAP, parsed.status_raw);
}

/** The opened entry's status through the DCA map; probation still in force (`active` becomes
 *  `conditions`) or an interim order (`interim_order`) in the sanctions text are the only hints. */
function statusFromAgentEntry(entry: AgentEntry, todayIso: string): { status: Status; flags: Flag[] } {
  if (entry.status_raw === null) return { status: "unknown", flags: [] };
  const live = entry.sanctions_text === null ? [] : liveClauses(entry.sanctions_text, todayIso);
  return applyStatusMap(DCA_MAP, entry.status_raw, {
    hasConditions: live.some((c) => PROBATION.test(c)),
    hasInterimOrder: live.some((c) => INTERIM.test(c)),
  });
}

// ---------------------------------------------------------------------------
// Agent: goal, schema, result
// ---------------------------------------------------------------------------

/**
 * The one-run goal on the DCA licence search (spec 4.2), which spans every DCA board. A name is read
 * with the person rule, or with the business rule for a business licence type or a name ending with
 * a legal form (`subjectOf`, the same decision the classifier makes). A profession, when given, says
 * which board and licence type to look for. EVERY matching row is reported first; `results_found` is
 * the register's own total. Every value from the caller is quoted on one line.
 */
function goal(q: { variants: string[]; number?: string; profession?: string }): string {
  const variants = q.variants.map(quoteGoalValue);
  const number = q.number !== undefined && q.number.trim() !== "" ? quoteGoalValue(q.number) : null;
  if (variants.length === 0 && number === null) throw new Error("DCA goal needs a name variant or a licence number");
  const profession = q.profession !== undefined && q.profession.trim() !== "" ? quoteGoalValue(q.profession) : null;
  const business = number === null && subjectOf(q.variants[0] ?? "", q.profession) === "business";
  const lookFor = profession === null ? "" : ` Look only for licences of this profession (board and licence type): ${profession}.`;

  const search =
    number !== null
      ? [
          `Search by licence number ${number}.${lookFor}`,
          `The entry to open is the one row whose licence number is exactly ${number}. If there is no such row, open nothing.`,
        ]
      : business
        ? [
            `Search by business name: enter these names one at a time, in this order. Stop at the first that returns any result rows and do not try the later ones.${lookFor}`,
            ...variants.map((v, i) => `  ${i + 1}. ${v}`),
            "",
            "The searched name is name 1. Open an entry only when exactly one result row's name matches the searched name; otherwise open nothing and just report the rows.",
            "A row matches when its name is the same as the searched name, ignoring capital letters, punctuation and extra spaces, and reading these suffixes as the same: LTD and LIMITED, INC and INCORPORATED, CO and COMPANY (\"&\" reads as \"and\").",
            "A name with a different or missing suffix does not match. If no row matches, or two or more rows match, do not open anything.",
          ]
        : [
            `Search for the person with these name variants, one at a time, in this order.${lookFor}`,
            "Read a variant of two or more words as first name(s) then surname, except that a last word of one letter is a first-name initial after the surname (\"smith j\" is surname Smith, first name J).",
            ...variants.map((v, i) => `  ${i + 1}. ${v}`),
            "After each search read the results. Stop at the first variant that returns any result rows and do not try the later ones. If a variant returns no rows, try the next one.",
            "",
            ...personMatchRuleLines(),
          ];

  return [
    `Navigate to ${REGISTRY_META["ca-dca"].searchUrl} to complete the goal. This is the California Department of Consumer Affairs licence search, which covers every DCA board. Use it and no other site.`,
    `You have at most ${AGENT_MAX_STEPS} steps, so do not explore other pages.`,
    "",
    ...search,
    "",
    "Return these fields, and use null for anything that is not shown on the page (never guess a value):",
    "  - blocked: true if a CAPTCHA or a block page stopped you, with the message shown in block_message; otherwise false.",
    "  - variants_tried: the names you searched, in order, as entered (empty when you searched by licence number).",
    "  - results_found: the register's own total count of result rows for the search that returned results (the full count it shows, which can be more than the rows you list; 0 if none).",
    number !== null
      ? "  - rows: up to 10 of the result rows, in the order shown, each with name (as printed), number (the licence number), status (the licence status if shown) and detail (the board and the licence type, as shown)."
      : "  - rows: first EVERY result row whose name matches the searched name (all of them, even if that is more than 10), then, in the order shown, as many of the other result rows as fit, up to 10 rows in total. Each row has name (as printed), number (the licence number), status (the licence status if shown) and detail (the board and the licence type, as shown).",
    "  - for an entry you opened: licensee_name (the licensee, not a related person or business), license_number, status (the License Status, as printed), board, license_type, entry_url (the address of the licence page) and sanctions_text (any probation, suspension, accusation or disciplinary text shown, as printed). If you opened no entry, all seven are null.",
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
    licensee_name: nullableString,
    license_number: nullableString,
    status: nullableString,
    board: nullableString,
    license_type: nullableString,
    entry_url: nullableString,
    sanctions_text: nullableString,
  },
};

/** An entry URL is trusted only when it is an https address on search.dca.ca.gov. */
function dcaEntryUrl(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;
  try {
    const u = new URL(text);
    return u.protocol === "https:" && u.hostname === "search.dca.ca.gov" ? text : null;
  } catch {
    return null;
  }
}

/**
 * Read an Agent result of the schema above. A row without a name is kept (with an empty name) when it
 * shows a number, a status or a detail. The opened entry exists when it shows a name or a number; its
 * board and licence type go to `raw_fields`. Never throws.
 */
function parseAgentResult(result: unknown): AgentOutcome {
  const r = isRecord(result) ? result : {};
  const rows: RegistryRow[] = [];
  for (const item of Array.isArray(r.rows) ? r.rows.filter(isRecord) : []) {
    const name = notRegisterName(asText(item.name), REGISTER_NAME);
    const number = dcaNumber(item.number);
    const status_raw = asText(item.status);
    const detail = asText(item.detail);
    if (name === null && number === null && status_raw === null && detail === null) continue;
    rows.push({ name: name ?? "", number, status_raw, detail, url: null });
  }

  const full_name = notRegisterName(asText(r.licensee_name), REGISTER_NAME);
  const licence_number = dcaNumber(r.license_number);
  let opened: AgentEntry | null = null;
  if (full_name !== null || licence_number !== null) {
    const raw_fields: Record<string, unknown> = {};
    const board = asText(r.board);
    const licence_type = asText(r.license_type);
    if (board !== null) raw_fields.board = board;
    if (licence_type !== null) raw_fields.licence_type = licence_type;
    opened = {
      full_name,
      licence_number,
      status_raw: asText(r.status),
      url: dcaEntryUrl(r.entry_url),
      sanctions_text: asText(r.sanctions_text),
      raw_fields,
    };
  }
  return { ...readAgentBasics(r), rows, opened };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const PROFESSIONS = Object.keys(DCA_LICENCE_CODES).join(", ");

export const caDca = {
  id: "ca-dca",
  name: REGISTRY_META["ca-dca"].name,
  country: REGISTRY_META["ca-dca"].country,
  recordTypes: ["professional"],
  searchUrl: REGISTRY_META["ca-dca"].searchUrl,
  // People are searched by first name and surname; a surname alone spans too many boards.
  allowSurnameOnly: false,
  // The search and licence pages read with plain Fetch (3 Nov probes).
  browserProfile: "lite",
  decisionPages: [],
  outputSchema,
  goal,
  normalizeStatus,
  statusFromRecord,
  statusFromAgentEntry,
  parseAgentResult,
  agentRowsListed: 10,
  recordUrl,
  parseRecordPage,
  subjectOf,
  // No Topic monitor: a DCA licence is watched through its licence page.
  topicQuery: undefined,
  numberLookupHint: `a CA DCA number lookup needs the profession, one of: ${PROFESSIONS} (a name search needs none and spans every board)`,
  coverage: {
    lookup: "agent+fetch",
    watch: "page",
    notes: `name searches span every DCA board (the board and licence type are each candidate's detail); a number lookup needs a profession with a confirmed licence code (${PROFESSIONS}), and its licence page is read with Fetch and watched with a Page monitor`,
  },
  noMatchSuggestions: ["Try the licence number with the profession.", "Try the name exactly as licensed, including any business suffix."],
} satisfies RegistryAdapter;
