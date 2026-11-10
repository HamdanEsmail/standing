import { AGENT_MAX_STEPS } from "../core/limits";
import { applyStatusMap, type Flag, type Status, type StatusMap } from "../core/status";
import { REGISTRY_META } from "./meta";
import {
  asDigits,
  asText,
  asTextList,
  DATE_PATTERN,
  isRecord,
  nextNonBlank,
  parseHumanDate,
  quoteForGoal,
  readAgentBasics,
  splitCells,
  tidy,
  toLines,
  untilPipe,
} from "./parse-util";
import type { AgentEntry, AgentOutcome, ParsedRecord, RegistryAdapter, RegistryRow } from "./types";

/**
 * The GMC register's own status text to the fixed status set. Matched on tidied text (trimmed,
 * whitespace collapsed), case-insensitive, first match wins. Every pattern is anchored, so
 * "Registered without a licence to practise" can never fall into the "with a licence" row and
 * the bare "Registered" row (the history table's wording, which carries no licence) cannot
 * swallow a longer phrase. Anything else is `unknown`; the caller keeps `status_raw`.
 */
export const GMC_MAP: StatusMap = [
  { pattern: /^(?:provisionally )?registered without a licen[cs]e to practi[cs]e$/i, status: "not_licensed" },
  { pattern: /^(?:provisionally )?registered with a licen[cs]e to practi[cs]e$/i, status: "active" },
  { pattern: /^registered$/i, status: "not_licensed" },
  { pattern: /^suspended$/i, status: "suspended" },
  { pattern: /^(?:erased|administrative erasure|voluntary erasure)$/i, status: "removed" },
  { pattern: /^(?:not registered|registration lapsed|relinquished)$/i, status: "not_licensed" },
];

// ---------------------------------------------------------------------------
// Record page
// ---------------------------------------------------------------------------

export interface GmcCondition {
  from: string;
  to: string | null;
  text: string;
}

export type GmcRawFields = {
  /** Whether the doctor is on the GP Register; null when the page does not say. */
  gp_register: boolean | null;
  gp_register_from: string | null;
  /** The page shows the "This registrant has conditions" notice. */
  conditions_notice: boolean;
  /** The page shows the "This registrant has undertakings" notice (spec 4.3 files undertakings
   *  under `conditions`, so the status hint treats it like the conditions notice). */
  undertakings_notice: boolean;
  /** The fitness-to-practise table, newest first, as printed. */
  ftp_history: { from: string; to: string | null; status: string }[];
  hearings: { date: string; hearing: string }[];
  registration_history: { from: string; to: string | null; status: string }[];
};

/** What `parseRecordPage` reads off a GMC record page. The array fields are never missing. */
export interface GmcRecord extends ParsedRecord {
  registered_since: string | null;
  specialties: string[];
  conditions: GmcCondition[];
  raw_fields: GmcRawFields;
}

// The apostrophe in "registrant's": straight, curly, modifier letter, backtick.
const APOS = "['\\u2018\\u2019\\u02bc`]";
// A conditions block, and by analogy an undertakings block (GMC's undertakings wording has not
// been recorded from a live page; spec 4.3 files both under `conditions`).
const CONDITIONS_MARKER = new RegExp(`(?:Conditions|Undertakings) on the registrant${APOS}s registration`, "i");
const CONDITIONS_BLOCK = new RegExp(`^\\s*From\\s+(${DATE_PATTERN})(?:\\s+to\\s+(${DATE_PATTERN}))?\\s*([\\s\\S]*)$`, "i");
const SPECIALTY_TAIL = new RegExp(`\\s+from\\s+${DATE_PATTERN}\\s*$`, "i");
// The words a registration status line is made of. A line that is none of these (a bullet, a
// heading, "View information about ...") is not a status line.
const STATUS_WORDS = /\b(?:regist(?:ered|ration)|suspend(?:ed|sion)|eras(?:ed|ure)|lapsed|relinquished|removed|struck off|licen[cs]e)\b/i;

/** The value printed on the line after the line that is exactly `label`, as a date. */
function dateAfterLabel(lines: string[], label: string): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== label) continue;
    const j = nextNonBlank(lines, i);
    const iso = j === -1 ? null : parseHumanDate(lines[j]!);
    if (iso !== null) return iso;
  }
  return null;
}

type Section = "ftp" | "hearings" | "registration" | null;
const SECTION_LABELS: Record<string, Section> = {
  "Fitness to practise history": "ftp",
  Hearings: "hearings",
  "Registration and licensing history": "registration",
};

/** The three history tables. GMC prints them without a `| --- |` separator row, so each table
 *  belongs to the section label that stands above it; rows that do not start with a date (the
 *  header row, the conditions rows) are skipped. A row whose end date is not a date is skipped
 *  too: reading it as open-ended would make a lapsed entry look current. */
function readTables(lines: string[]): Pick<GmcRawFields, "ftp_history" | "hearings" | "registration_history"> {
  const ftp_history: GmcRawFields["ftp_history"] = [];
  const hearings: GmcRawFields["hearings"] = [];
  const registration_history: GmcRawFields["registration_history"] = [];
  let section: Section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      if (Object.hasOwn(SECTION_LABELS, line)) section = SECTION_LABELS[line]!;
      continue;
    }
    const cells = splitCells(line);
    const from = cells[0] === undefined ? null : parseHumanDate(cells[0]);
    if (from === null || section === null) continue;
    if (section === "hearings") {
      const hearing = cells[1];
      if (hearing) hearings.push({ date: from, hearing: tidy(hearing) });
      continue;
    }
    const toText = cells[1] ?? "";
    const to = toText === "" ? null : parseHumanDate(toText);
    const status = tidy(cells[2] ?? "");
    if ((toText !== "" && to === null) || status === "") continue;
    (section === "ftp" ? ftp_history : registration_history).push({ from, to, status });
  }
  return { ftp_history, hearings, registration_history };
}

/** Every "Conditions on the registrant's registration From <date> [to <date>] <text>" block.
 *  A block is one table cell, so its text runs to the next unescaped pipe or the end of the line.
 *  A block whose From date cannot be read is skipped (the notice and the history rows still
 *  show that conditions exist). */
function readConditions(lines: string[]): GmcCondition[] {
  const out: GmcCondition[] = [];
  const marker = new RegExp(CONDITIONS_MARKER.source, "gi");
  for (const line of lines) {
    const pieces = line.split(marker);
    for (const piece of pieces.slice(1)) {
      const m = CONDITIONS_BLOCK.exec(untilPipe(piece));
      if (!m) continue;
      const from = parseHumanDate(m[1]!);
      if (from === null) continue;
      const to = m[2] === undefined ? null : parseHumanDate(m[2]);
      out.push({ from, to, text: tidy(m[3] ?? "") });
    }
  }
  return out;
}

/** The present-tense notice "This registrant has <what>" outside any table (the table row and
 *  the past-tense "had" do not count). */
function hasNotice(lines: string[], what: "conditions" | "undertakings"): boolean {
  const notice = new RegExp(`^[*-]?\\s*This registrant has ${what}\\b`, "i");
  return lines.some((l) => !l.trim().startsWith("|") && notice.test(l.trim()));
}

/** The Specialist Register bullets, without their "from <date>" tail. */
function readSpecialties(lines: string[]): string[] {
  const i = lines.findIndex((l) => /^This doctor is on the Specialist Register\b/i.test(l.trim()));
  if (i === -1) return [];
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]!.trim();
    if (line === "") continue;
    const bullet = /^[*-]\s+(.+)$/.exec(line);
    if (!bullet) break;
    const name = tidy(bullet[1]!.replace(SPECIALTY_TAIL, ""));
    if (name !== "") out.push(name);
  }
  return out;
}

function readGpRegister(lines: string[]): { on: boolean | null; from: string | null } {
  const i = lines.findIndex((l) => /^This doctor is (?:not )?on the GP Register\b/i.test(l.trim()));
  if (i === -1) return { on: null, from: null };
  if (/is not on/i.test(lines[i]!)) return { on: false, from: null };
  const j = nextNonBlank(lines, i);
  const m = j === -1 ? null : new RegExp(`^From\\s+(${DATE_PATTERN})$`, "i").exec(lines[j]!.trim());
  return { on: true, from: m ? parseHumanDate(m[1]!) : null };
}

/**
 * Read a GMC record page fetched with the `[role='main']` selector (see `recordFetchOptions`).
 * Returns null only when the page is clearly not a GMC record: none of the reference-number
 * label, a conditions block, or the history sections is there.
 *
 * The same page read without the selector holds only the conditions table. That parses too:
 * `full_name` and `status_raw` are null and the number comes from `url`. The status is never
 * inferred from the conditions.
 */
function parseRecordPage(markdown: string, url?: string): GmcRecord | null {
  const lines = toLines(markdown);
  const text = lines.join("\n");
  const hasNumberLabel = /GMC reference number/i.test(text);
  const looksLikeRecord =
    hasNumberLabel ||
    CONDITIONS_MARKER.test(text) ||
    lines.some((l) => Object.hasOwn(SECTION_LABELS, l.trim()) && l.trim() !== "Hearings");
  if (!looksLikeRecord) return null;

  // Name: the page's first "# " heading.
  let full_name: string | null = null;
  for (const line of lines) {
    const m = /^#\s+(\S.*?)\s*$/.exec(line);
    if (m) {
      full_name = tidy(m[1]!);
      break;
    }
  }

  // Number and status line: "GMC reference number:", the number, then the status line.
  let licence_number: string | null = null;
  let status_raw: string | null = null;
  const labelAt = lines.findIndex((l) => /GMC reference number/i.test(l));
  if (labelAt !== -1) {
    const sameLine = /GMC reference number:?\s*(\d+)\s*$/i.exec(lines[labelAt]!);
    let numberAt = labelAt;
    if (sameLine) {
      licence_number = sameLine[1]!;
    } else {
      const j = nextNonBlank(lines, labelAt);
      if (j !== -1 && /^\d+$/.test(lines[j]!.trim())) {
        licence_number = lines[j]!.trim();
        numberAt = j;
      }
    }
    if (licence_number !== null) {
      const k = nextNonBlank(lines, numberAt);
      const candidate = k === -1 ? "" : lines[k]!.trim();
      // A standalone line only: the same words also sit inside the history table.
      if (candidate !== "" && !/^[|*#]/.test(candidate) && STATUS_WORDS.test(candidate)) status_raw = tidy(candidate);
    }
  }
  if (licence_number === null && url !== undefined) {
    const m = /\/registrants\/(\d+)(?:[/?#]|$)/.exec(url);
    if (m) licence_number = m[1]!;
  }

  const registered_since = dateAfterLabel(lines, "Full registration date") ?? dateAfterLabel(lines, "Provisional registration date");
  const gp = readGpRegister(lines);

  return {
    full_name,
    licence_number,
    status_raw,
    registered_since,
    specialties: readSpecialties(lines),
    conditions: readConditions(lines),
    raw_fields: {
      gp_register: gp.on,
      gp_register_from: gp.from,
      conditions_notice: hasNotice(lines, "conditions"),
      undertakings_notice: hasNotice(lines, "undertakings"),
      ...readTables(lines),
    },
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** A period with no end date, or an end date after today, is current. Ending today is not:
 *  GMC starts a successor block on the day the old one ends (the fixture's 16 Oct 2026). */
function isCurrent(to: unknown, todayIso: string): boolean {
  return typeof to === "string" && to !== "" ? to > todayIso : true;
}

/**
 * The one place GMC hints are derived. `hasConditions`: any conditions (or undertakings) block
 * is current, or the page shows the "This registrant has conditions" or "...undertakings"
 * notice, or a current fitness-to-practise row is an undertakings row. `hasInterimOrder`: a
 * current fitness-to-practise row mentions an interim order. A null `status_raw` gives
 * `unknown` whatever else the page shows.
 */
function statusFromRecord(parsed: ParsedRecord, todayIso: string): { status: Status; flags: Flag[] } {
  const raw = parsed.raw_fields ?? {};
  const conditions = parsed.conditions ?? [];
  const ftp = Array.isArray(raw.ftp_history) ? (raw.ftp_history as unknown[]) : [];
  const currentRow = (word: RegExp) =>
    ftp.some((row) => isRecord(row) && typeof row.status === "string" && word.test(row.status) && isCurrent(row.to, todayIso));
  const hasConditions =
    conditions.some((c) => isCurrent(c.to, todayIso)) ||
    raw.conditions_notice === true ||
    raw.undertakings_notice === true ||
    currentRow(/\bundertakings?\b/i);
  const hasInterimOrder = currentRow(/\binterim\b/i);
  return applyStatusMap(GMC_MAP, parsed.status_raw, { hasConditions, hasInterimOrder });
}

function normalizeStatus(raw: string | null, hints: { hasConditions?: boolean; hasInterimOrder?: boolean }) {
  return applyStatusMap(GMC_MAP, raw, hints);
}

// The present-tense notice an entry prints while restrictions are in force ("This registrant has
// conditions"); "had conditions" or a lapsed mention does not count.
const ENTRY_HAS_CONDITIONS = /\bhas (?:conditions|undertakings)\b/i;
const ENTRY_INTERIM_ORDER = /\binterim order\b/i;

/** An entry an Agent run opened, when the record page could not be read: the status line through
 *  GMC_MAP; the entry's present-tense conditions or undertakings notice, and an interim order, are
 *  the only hints. A null status line is `unknown`. */
function statusFromAgentEntry(entry: AgentEntry, _todayIso: string): { status: Status; flags: Flag[] } {
  if (entry.status_raw === null) return { status: "unknown", flags: [] };
  const sanctions = entry.sanctions_text ?? "";
  return applyStatusMap(GMC_MAP, entry.status_raw, {
    hasConditions: ENTRY_HAS_CONDITIONS.test(sanctions),
    hasInterimOrder: ENTRY_INTERIM_ORDER.test(sanctions),
  });
}

// ---------------------------------------------------------------------------
// Agent: goal, schema, result
// ---------------------------------------------------------------------------

function recordUrl(number: string): string | null {
  const n = number.trim();
  return /^\d+$/.test(n) ? `https://www.gmc-uk.org/registrants/${n}` : null;
}

/**
 * The one-run goal of spec 4.2. The searched name is the first variant (the fullest form); the
 * match rule is spelled out so the run opens an entry only on exactly one matching row and
 * reports the rows otherwise. The run decides "exactly one" over every row it sees, so it must
 * report every matching row (even beyond 10) before filling the 10-row list with the others;
 * otherwise the classifier would see a single match among the 10 and call it a match.
 * `results_found` is the register's own total. Every value from the caller is quoted on one line.
 */
function goal(q: { variants: string[]; number?: string; profession?: string }): string {
  const variants = q.variants.map(quoteForGoal);
  const number = q.number !== undefined && q.number.trim() !== "" ? quoteForGoal(q.number) : null;
  if (variants.length === 0 && number === null) throw new Error("GMC goal needs at least one name variant or a number");

  const search =
    number !== null
      ? [
          `Search by GMC reference number ${number}: type that number into the register's one search box ("Enter name or GMC reference number") and nothing else, then search.`,
          `The entry to open is the one row whose GMC reference number is exactly ${number}. If there is no such row, open nothing.`,
        ]
      : [
          "Search for the doctor with these name variants, one at a time, in this order. The register has one search box (\"Enter name or GMC reference number\"); type the variant into it as written and search. There are no separate name fields.",
          "Read a variant of two or more words as first name(s) then surname, except that a last word of one letter is a first-name initial after the surname (\"smith j\" is surname Smith, first name J); a variant of one word is a surname.",
          ...variants.map((v, i) => `  ${i + 1}. ${v}`),
          "After each search read the results. Stop at the first variant that returns any result rows and do not try the later ones. If a variant returns no rows, try the next one.",
          "",
          `The searched name is variant 1 (the full name). Read a name like this: the first word is the first name, any words between the first name and the surname are middle names, and on a GMC result row the surname is the word or words printed in capitals (\"Ada Vera Mae FICTITIOUS JONES\" is first name Ada, middle names Vera and Mae, surname FICTITIOUS JONES, so a surname of several words is one surname); in the searched name the surname is the last word.`,
          `Open an entry only when exactly one result row's name matches the searched name; otherwise open nothing and just report the rows. A row matches when:`,
          "  - it has the same first name and the same surname as the searched name;",
          "  - every middle name in the searched name is in the row's name, in the same order (a searched name without middle names may match a row that has middle names);",
          "  - initials do not match full names (\"A\" is not \"Ada\"); ignore capital letters.",
          "A searched name that is a surname alone matches no row. If no row matches, or two or more rows match, do not open anything.",
        ];

  return [
    `Navigate to ${REGISTRY_META.gmc.searchUrl} to complete the goal. This is the GMC online medical register. Use its 'Search the register' function, and no other site.`,
    `You have at most ${AGENT_MAX_STEPS} steps, so do not explore other pages.`,
    "",
    ...search,
    "",
    "Return these fields, and use null for anything that is not shown on the page (never guess a value):",
    "  - blocked: true if a CAPTCHA or a block page stopped you, with the message shown in block_message; otherwise false.",
    "  - variants_tried: the variants you searched, in order, as entered (empty when you searched by number).",
    "  - results_found: the register's own total count of result rows for the search that returned results (the full count it shows, which can be more than the rows you list; 0 if none).",
    number !== null
      ? "  - rows: up to 10 of the result rows, in the order shown, each with name (as printed), number (the GMC reference number if the row shows it), status (the registration status text if shown) and specialty (if shown)."
      : "  - rows: first EVERY result row whose name matches the searched name (all of them, even if that is more than 10), then, in the order shown, as many of the other result rows as fit, up to 10 rows in total. Each row has name (as printed), number (the GMC reference number if the row shows it), status (the registration status text if shown) and specialty (if shown).",
    "  - for an entry you opened: full_name, gmc_number (the GMC reference number), status (the registration status line, as printed), entry_url (the address of the entry page) and sanctions_text (any conditions, undertakings, suspension or warning text shown on the entry, as printed). If you opened no entry, all five are null.",
  ].join("\n");
}

const nullableString = { type: "string", nullable: true };

/** JSON Schema for the Agent run's `output_schema`, in the style the spike runs used. */
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
        properties: { name: { type: "string" }, number: nullableString, status: nullableString, specialty: nullableString },
      },
    },
    full_name: nullableString,
    gmc_number: nullableString,
    status: nullableString,
    entry_url: nullableString,
    sanctions_text: nullableString,
  },
};

function gmcRow(name: string, number: string | null, status: string | null, specialty: string | null): RegistryRow {
  return { name, number, status_raw: status, detail: specialty, url: number === null ? null : recordUrl(number) };
}

/** An entry URL is trusted only when it is an https address on the GMC site. */
function gmcEntryUrl(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;
  try {
    const u = new URL(text);
    return u.protocol === "https:" && (u.hostname === "www.gmc-uk.org" || u.hostname === "gmc-uk.org") ? text : null;
  } catch {
    return null;
  }
}

/**
 * Read an Agent result of the schema above, or of the older spike shapes (no `rows[]`; the
 * conditions run has `names_shown[]`). Rows come from the named entries of `rows[]`; when there
 * are none (the array is absent or empty), from the opened entry when exactly one result was
 * found and `names_shown` has at most one name (the entry carries the number and status); then
 * from `names_shown[]` with null numbers; then, when a single row without a name is the only
 * evidence of a result, that row with an empty name (the classifier can only make it ambiguous).
 * Never throws.
 */
function parseAgentResult(result: unknown): AgentOutcome {
  const r = isRecord(result) ? result : {};
  const basics = readAgentBasics(r);

  const full_name = asText(r.full_name);
  const licence_number = asDigits(r.gmc_number);
  const url = gmcEntryUrl(r.entry_url);
  const opened =
    full_name !== null || licence_number !== null || url !== null
      ? { full_name, licence_number, status_raw: asText(r.status), url, sanctions_text: asText(r.sanctions_text) }
      : null;

  const names = asTextList(r.names_shown);
  const items = Array.isArray(r.rows) ? r.rows.filter(isRecord) : [];
  const named: RegistryRow[] = [];
  for (const item of items) {
    const name = asText(item.name);
    if (name !== null) named.push(gmcRow(name, asDigits(item.number), asText(item.status), asText(item.specialty)));
  }

  let rows: RegistryRow[];
  if (named.length > 0) {
    rows = named;
  } else if (opened !== null && basics.resultsFound === 1 && names.length <= 1) {
    rows = [gmcRow(opened.full_name ?? names[0] ?? "", opened.licence_number, opened.status_raw, null)];
  } else if (names.length > 0) {
    rows = names.map((name) => gmcRow(name, null, null, null));
  } else if (items.length === 1 && (asDigits(items[0]!.number) ?? asText(items[0]!.status) ?? asText(items[0]!.specialty)) !== null) {
    const lone = items[0]!;
    rows = [gmcRow("", asDigits(lone.number), asText(lone.status), asText(lone.specialty))];
  } else {
    rows = [];
  }

  return { ...basics, rows, opened };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const gmc = {
  id: "gmc",
  name: REGISTRY_META.gmc.name,
  country: REGISTRY_META.gmc.country,
  recordTypes: ["doctor"],
  searchUrl: REGISTRY_META.gmc.searchUrl,
  allowSurnameOnly: true,
  // Standard browser only: Standing does not get past robot checks or CAPTCHAs; a register that refuses
  // automated visitors is reported as blocked.
  browserProfile: "lite",
  decisionPages: [],
  outputSchema,
  goal,
  normalizeStatus,
  statusFromRecord,
  statusFromAgentEntry,
  recordUrl,
  parseRecordPage,
  // The test fixtures `gmc-record-*.md` were recorded with exactly this option (see
  // tests/fixtures/registries/README.md), so they show what production reads. It is needed
  // because without it a doctor with conditions comes back as the conditions table only: no
  // name, number or status line.
  recordFetchOptions: { include_selectors: ["[role='main']"] },
  parseAgentResult,
  topicQuery: (fullName: string) => `"${fullName}" GMC tribunal OR MPTS OR suspended OR conditions`,
  agentRowsListed: 10,
  coverage: {
    lookup: "agent+fetch",
    watch: "page",
    notes: "name searches run on the Agent; record pages are read with Fetch and the [role='main'] selector (without it a doctor with conditions reads as the conditions table only) and watched with a Page monitor",
  },
  noMatchSuggestions: ["Try the GMC reference number.", "Check the spelling of the surname."],
} satisfies RegistryAdapter;
