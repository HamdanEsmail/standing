// Name normalization and the match rule (spec 4.2 and 4.5).
//
// The match rule is a public contract: when more than one registry row could be the
// person, the result is `ambiguous` and never a guess. So everything here errs towards
// "not equal". Tokens are compared exactly: no initial expansion, no accent folding,
// no fuzzy distance.

export interface NormalizedPerson {
  given: string;
  middle: string[];
  surname: string;
  /** "given middle... surname", lower case. */
  display: string;
}

/** Honorifics that stand in front of a name. */
const PREFIX_TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "mx", "prof", "sir", "dame"]);
/** Postnominals that stand behind a name. Kept apart from the prefixes so that a
 *  surname such as "Dame" or a given name such as "Md" is not stripped by mistake. */
const SUFFIX_TITLES = new Set(["esq", "md", "mbbs", "phd", "qc", "kc"]);

/** Everything a keyboard, a word processor or a registry may print for an apostrophe.
 *  All become a straight ', so "D`Souza", "D´Souza" and "D’Souza" are one surname and
 *  none of them is split into a middle name "d" and the surname "souza". */
const APOSTROPHE_LOOKALIKES = [
  0x0060, // ` grave accent
  0x00b4, // ´ acute accent
  0x02b9, // ʹ modifier letter prime
  0x02bb, // ʻ modifier letter turned comma
  0x02bc, // ʼ modifier letter apostrophe
  0x02bd, // ʽ modifier letter reversed comma
  0x02c8, // ˈ modifier letter vertical line
  0x2018, // ‘ left single quotation mark
  0x2019, // ’ right single quotation mark
  0x201b, // ‛ single high-reversed-9 quotation mark
  0x2032, // ′ prime
  0x2035, // ‵ reversed prime
  0xa78c, // ꞌ latin small letter saltillo
  0xff07, // ＇ fullwidth apostrophe
];
const APOSTROPHES = new RegExp(`[${String.fromCodePoint(...APOSTROPHE_LOOKALIKES)}]`, "g");
/** Hyphen, figure dash, en dash, em dash, horizontal bar (U+2010 to U+2015) and minus sign (U+2212). */
const DASHES = new RegExp(`[${String.fromCodePoint(0x2010)}-${String.fromCodePoint(0x2015)}${String.fromCodePoint(0x2212)}]`, "g");

/** A backslash in front of punctuation is a markdown escape ("D\`Souza"), not part of the name. */
const MARKDOWN_ESCAPES = /\\(?=[^\p{L}\p{M}\p{N}\s])/gu;

/** NFC, markdown escapes removed, lower case, apostrophe look-alikes and typographic dashes
 *  folded to ' and -. */
function fold(input: string): string {
  return input
    .normalize("NFC")
    .replace(MARKDOWN_ESCAPES, "")
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(DASHES, "-");
}

/** Characters of a word, for deciding whether a stray character sits inside one. */
const WORD = String.raw`\p{L}\p{M}\p{N}'\-`;
/** Punctuation that really separates words even with no space around it: "Doe(MD)", "Silva/Souza". */
const SEPARATORS = String.raw`/|;:()\[\]{}<>"&+=`;
/** Any other character between two word characters. It belongs to the word, not between words. */
const STRAY_IN_WORD = new RegExp(`(?<=[${WORD}])[^${WORD}\\s${SEPARATORS}]+(?=[${WORD}])`, "gu");

/** One comma-separated part of a person's name as clean tokens. Periods vanish
 *  ("J." is "j", "M.D." is "md"); hyphens and apostrophes inside a word stay. Any other
 *  punctuation inside a word is deleted rather than turned into a space, so a stray
 *  character can never split a name and invent a middle name. */
function personTokens(part: string): string[] {
  return part
    .replace(/\./g, "")
    .replace(STRAY_IN_WORD, "")
    .replace(/[^\p{L}\p{M}\p{N}'\s-]/gu, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter((t) => t !== "");
}

function stripTitles(tokens: string[]): string[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && PREFIX_TITLES.has(tokens[start]!)) start++;
  while (end > start && SUFFIX_TITLES.has(tokens[end - 1]!)) end--;
  return tokens.slice(start, end);
}

function build(given: string, middle: string[], surname: string): NormalizedPerson {
  return { given, middle, surname, display: [given, ...middle, surname].filter((p) => p !== "").join(" ") };
}

/**
 * "Dr. WICKFOLD, Christopher J." and "Christopher J Wickfold" both give given "christopher",
 * middle ["j"], surname "wickfold". A single token is a surname with an empty given name.
 * Text before a comma is the whole surname, so "VAN DER BERG, Jan" has surname "van der berg".
 */
export function normalizePerson(input: string): NormalizedPerson {
  const parts = fold(input)
    .split(",")
    .map((part) => stripTitles(personTokens(part)))
    .filter((tokens) => tokens.length > 0);

  if (parts.length >= 2) {
    const [surnameTokens, ...rest] = parts;
    const [given = "", ...middle] = rest.flat();
    return build(given, middle, surnameTokens!.join(" "));
  }
  const tokens = parts[0] ?? [];
  if (tokens.length === 0) return build("", [], "");
  if (tokens.length === 1) return build("", [], tokens[0]!);
  return build(tokens[0]!, tokens.slice(1, -1), tokens[tokens.length - 1]!);
}

/** The names to try at a registry, in the order of spec 4.2: full name, given + surname,
 *  surname + initial, then surname alone where the registry supports it. Deduped.
 *  A single-token input has no given name, so only the surname variant can exist; when the
 *  registry does not take a surname alone there is nothing to try and the list is empty. */
export function variantsFor(p: NormalizedPerson, allowSurnameOnly: boolean): string[] {
  if (p.surname === "") return [];
  const out: string[] = [];
  const add = (variant: string) => {
    if (!out.includes(variant)) out.push(variant);
  };
  if (p.given !== "") {
    add(p.display);
    add(`${p.given} ${p.surname}`);
    add(`${p.surname} ${Array.from(p.given)[0]}`);
  }
  if (allowSurnameOnly) add(p.surname);
  return out;
}

/** True when every wanted name appears among the names we have, in the same order. */
function isSubsequence(wanted: string[], have: string[]): boolean {
  let i = 0;
  for (const name of have) {
    if (i < wanted.length && name === wanted[i]) i++;
  }
  return i === wanted.length;
}

/**
 * Does the registry's name stand for the person asked about? Given name and surname must be
 * equal. A query without middle names matches a candidate with any; a query with middle names
 * matches only when each appears among the candidate's, in the same order. "j" is not "john".
 * Blank names equal nothing.
 */
export function personNamesEqual(query: string | NormalizedPerson, candidate: string | NormalizedPerson): boolean {
  const q = typeof query === "string" ? normalizePerson(query) : query;
  const c = typeof candidate === "string" ? normalizePerson(candidate) : candidate;
  if (q.surname === "" || c.surname === "") return false;
  if (q.given !== c.given || q.surname !== c.surname) return false;
  return isSubsequence(q.middle, c.middle);
}

const BUSINESS_WORDS = new Map([
  ["limited", "ltd"],
  ["incorporated", "inc"],
  ["company", "co"],
]);

/**
 * Case-fold, strip punctuation, collapse whitespace and map the suffix words
 * (limited to ltd, public limited company to plc, incorporated to inc, company to co).
 * The suffix is kept: "Acme Ltd" is not "Acme". The mapping applies to the word wherever it
 * stands, so both sides of a comparison are always treated alike. "&" reads as "and".
 * Periods and apostrophes vanish ("P.L.C." is "plc"); other punctuation becomes a space.
 */
export function normalizeBusiness(input: string): string {
  const tokens = fold(input)
    .replace(/&/g, " and ")
    .replace(/['.]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "public" && tokens[i + 1] === "limited" && tokens[i + 2] === "company") {
      out.push("plc");
      i += 2;
    } else {
      out.push(BUSINESS_WORDS.get(tokens[i]!) ?? tokens[i]!);
    }
  }
  return out.join(" ");
}

export function businessNamesEqual(a: string, b: string): boolean {
  const na = normalizeBusiness(a);
  return na !== "" && na === normalizeBusiness(b);
}

// The legal-form words that end a business name ("Acme Roofing Inc", "Fictional Patrol Limited").
const BUSINESS_SUFFIXES = new Set(["ltd", "inc", "co", "plc", "llc", "llp", "lp", "corp", "corporation"]);

/**
 * Whether `name` holds every significant word of `query`, as whole words after normalizeBusiness. The
 * legal-form words (ltd, plc, inc, llc, corp...) are not significant. A query with no significant word
 * holds for every name. Used on registers whose search lists the nearest names for anything.
 */
export function nameHasEveryWord(query: string, name: string): boolean {
  const words = new Set(normalizeBusiness(name).split(" "));
  return normalizeBusiness(query)
    .split(" ")
    .filter((w) => w !== "" && !BUSINESS_SUFFIXES.has(w))
    .every((w) => words.has(w));
}

/** Whether a name ends with a business's legal form (after the suffix mapping of normalizeBusiness).
 *  Used where one register holds both people and businesses (California DCA) to read the name with
 *  the business rule. */
export function hasBusinessSuffix(input: string): boolean {
  const tokens = normalizeBusiness(input).split(" ");
  return tokens.length >= 2 && BUSINESS_SUFFIXES.has(tokens[tokens.length - 1]!);
}
