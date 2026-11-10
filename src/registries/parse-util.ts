// Small helpers the registry adapters share: dates as the registers print them, markdown
// lines and table rows, and defensive readers for Agent output (which is data from a browser
// run, so every field may be missing or the wrong type).

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** A date as a register prints it ("01 Aug 1992", "1 December 2010") as ISO `YYYY-MM-DD`,
 *  or null when it is not a real calendar date. */
export function parseHumanDate(text: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A date pattern as it appears inside running text, for building larger regular expressions. */
export const DATE_PATTERN = "\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4}";

/** Split markdown into lines; CRLF and lone CR (a Windows checkout of a fixture) are line ends. */
export function toLines(markdown: string): string[] {
  return markdown.split(/\r\n|\r|\n/);
}

/** Collapse every run of whitespace to one space and trim. */
export function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cut `text` at the first `|` that is not escaped as `\|`; unescape the kept part. */
export function untilPipe(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && text[i + 1] === "|") {
      out += "|";
      i++;
    } else if (ch === "|") {
      break;
    } else {
      out += ch;
    }
  }
  return out;
}

/** The cells of one markdown table row, trimmed and with `\|` unescaped. */
export function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.trim() !== "") cells.push(cell.trim()); // a row that does not end in a pipe
  return cells;
}

/** The index of the next line after `from` that is not blank, or -1. */
export function nextNonBlank(lines: string[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) if (lines[i]!.trim() !== "") return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Defensive readers for Agent output
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A non-empty string, trimmed; anything else is null. */
export function asText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" || PLACEHOLDER.test(t) ? null : t;
}

// What a run writes when it did not read a value ("Unknown" in every field of a live CSLB run, 9 Nov
// 2026): it counts as missing, never as a value.
const PLACEHOLDER = /^(?:unknown|n\/?a|none|null|nil|-+|not (?:shown|available|listed|provided|found))\.?$/i;

/** A name read off a page, unless it is the register's own name or page header (a run that could not
 *  read a licence page reported "DEPARTMENT OF CONSUMER AFFAIRS CONTRACTORS STATE LICENSE BOARD" as the
 *  business). `register` matches the register's names. */
export function notRegisterName(name: string | null, register: RegExp): string | null {
  return name !== null && register.test(name) ? null : name;
}

/** A string or number made only of digits, as a string; anything else is null. */
export function asDigits(v: unknown): string | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  const t = asText(v);
  return t !== null && /^\d+$/.test(t) ? t : null;
}

/** A non-negative whole number, from a number or a numeric string; anything else is null. */
export function asCount(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  const t = asText(v);
  return t !== null && /^\d{1,9}$/.test(t) ? Number(t) : null;
}

/** `true`, or the string "true". Nothing else counts. */
export function asBool(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

/** The non-empty strings of an array, trimmed, in order; a non-array is []. */
export function asTextList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const t = asText(item);
    if (t !== null) out.push(t);
  }
  return out;
}

/** The fields every adapter's Agent output shares. */
export function readAgentBasics(r: Record<string, unknown>): {
  blocked: boolean;
  blockMessage: string | null;
  variantsTried: string[];
  resultsFound: number | null;
} {
  return {
    blocked: asBool(r.blocked),
    blockMessage: asText(r.block_message),
    variantsTried: asTextList(r.variants_tried),
    resultsFound: asCount(r.results_found),
  };
}

/** One goal parameter as a quoted string on one line, so a name cannot add lines of
 *  instructions to an Agent goal. */
export function quoteForGoal(text: string): string {
  return JSON.stringify(tidy(text).slice(0, 120));
}

/** One goal parameter as a quoted string on one line, kept as typed (not tidied): JSON escapes a
 *  line break as `\n`, and the three line ends JSON leaves raw (U+0085, U+2028, U+2029) are escaped
 *  here, so a value cannot start a new line of instructions. */
export function quoteGoalValue(text: string): string {
  return JSON.stringify(text.trim().slice(0, 120)).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The person match rule as the NMC, SRA and DCA goals state it (spec 4.5), after the variants. */
export function personMatchRuleLines(): string[] {
  return [
    "The searched name is variant 1 (the full name). Read a name like this: the first word is the first name, the last word is the surname and any words between them are middle names; a result row printed as \"SURNAME, First names\" has its surname before the comma.",
    "Open an entry only when exactly one result row's name matches the searched name; otherwise open nothing and just report the rows. A row matches when:",
    "  - it has the same first name and the same surname as the searched name;",
    "  - every middle name in the searched name is in the row's name, in the same order (a searched name without middle names may match a row that has middle names);",
    "  - initials do not match full names (\"A\" is not \"Ada\"); ignore capital letters.",
    "If no row matches, or two or more rows match, do not open anything.",
  ];
}

// Words that say a measure is over ("expired on", "ended", "revoked on review", "had conditions").
const MEASURE_ENDED = /\b(?:expired|ended|lapsed|revoked|removed|withdrawn|discharged|completed|no longer|had)\b/i;
const MEASURE_UNTIL = /\buntil\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/i;

function isoOrHumanDate(text: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? null : text;
  return parseHumanDate(text);
}

/** The clauses of an entry's sanctions text that still describe something in force as of `todayIso`:
 *  none of the "it is over" words, and no "until <date>" on or before today. */
export function liveClauses(text: string, todayIso: string): string[] {
  return text
    .split(/[;\n]|\.\s/)
    .map(tidy)
    .filter((clause) => {
      if (clause === "" || MEASURE_ENDED.test(clause)) return false;
      const until = MEASURE_UNTIL.exec(clause);
      const end = until ? isoOrHumanDate(until[1]!) : null;
      return end === null || end > todayIso;
    });
}
