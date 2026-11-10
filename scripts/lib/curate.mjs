// The pure part of scripts/curate-watches.mjs: the four curated targets, the naming rule, which
// search results become candidates, and the docs/curated-watches.md writer. No Node APIs here, so
// tests/scripts.test.ts can import it inside the Workers test pool.

/** The four curated watches of spec 4.6, each with the TinySearch query that finds candidates. */
export const TARGETS = [
  {
    id: "gmc",
    label: "a GMC doctor with a tribunal hearing inside the window",
    query: "MPTS hearing November 2026 doctor",
    check: { record_type: "doctor", jurisdiction: "GB" },
    kind: "person",
  },
  {
    id: "companies-house",
    label: 'a company shown as "Active - Proposal to strike off" with a Gazette notice older than two months',
    query: "Companies House proposal to strike off Gazette notice",
    check: { record_type: "company", jurisdiction: "GB" },
    kind: "company",
  },
  {
    id: "nmc",
    label: "an NMC registrant with a hearing inside the window",
    query: "NMC fitness to practise hearing November 2026",
    check: { record_type: "nurse", jurisdiction: "GB" },
    kind: "person",
  },
  {
    id: "sra",
    label: "an SRA solicitor with a Solicitors Disciplinary Tribunal date inside the window",
    query: "SDT hearing November 2026 solicitor",
    check: { record_type: "solicitor", jurisdiction: "GB" },
    kind: "person",
  },
];

/** Spec section 7, printed at the top of the script's output. */
export const NAMING_RULE = [
  "Who may be named (spec section 7): public office holders and public figures, people already named in a",
  "public regulatory notice or listed hearing, and any registered business. No private individuals. Names are",
  "chosen by hand, and every name is approved before a watch is made. The script lists candidates and stops: a person",
  "picks them, and only then does --pick run a check and a watch.",
].join("\n");

export const WINDOW_END = "2026-11-17";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

/** Every date the text prints ("12 November 2026", "Nov 12, 2026", "2026-11-12", "12/11/2026" read as
 *  day/month, the UK form), as ISO dates. */
export function datesIn(text) {
  const out = [];
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    if (mo > 0) out.push(iso(Number(m[3]), mo, Number(m[1])));
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})\b/g)) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    if (mo > 0) out.push(iso(Number(m[3]), mo, Number(m[2])));
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(iso(Number(m[1]), Number(m[2]), Number(m[3])));
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.push(iso(Number(m[3]), Number(m[2]), Number(m[1])));
  return out.filter((d) => d !== null);
}

// Words that make a capitalised phrase an institution or a heading, not a person.
const NOT_A_PERSON = new Set(
  (
    "tribunal tribunals service medical practitioners council general nursing midwifery solicitors disciplinary " +
    "regulation authority companies house gazette hearing hearings notice notices fitness practise practice " +
    "panel register registrar england wales scotland london high court the and of for news update latest " +
    "january february march april may june july august september october november december monday tuesday " +
    "wednesday thursday friday saturday sunday jan feb mar apr jun jul aug sep sept oct nov dec " +
    "mon tue wed thu fri sat sun nmc gmc sra sdt mpts uk"
  ).split(" "),
);

/** A company named in the text (a name ending LTD, LIMITED, PLC or LLP), or null. */
function companyIn(text) {
  const m = /\b((?:[A-Z0-9][A-Za-z0-9&'.-]*\s+){1,6}(?:LTD|LIMITED|PLC|LLP|Ltd|Limited|Plc))\b/.exec(text);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

/** A person named in the text ("Dr Ada Fictitious", "Ada Fictitious", "FICTITIOUS, Ada"), or null. */
function personIn(text) {
  const comma = /\b([A-Z][A-Z'-]{1,}),\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)\b/.exec(text);
  if (comma && !NOT_A_PERSON.has(comma[1].toLowerCase())) return `${comma[2]} ${comma[1][0]}${comma[1].slice(1).toLowerCase()}`;
  for (const m of text.matchAll(/\b(?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){1,2})\b/g)) {
    const words = m[1].split(/\s+/);
    if (words.every((w) => !NOT_A_PERSON.has(w.toLowerCase()))) return m[1];
  }
  return null;
}

const DAY = 86_400_000;
const shift = (isoDate, days) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * The search results worth showing a person: each must name a person and print a date from `now` to
 * `windowEnd` (inclusive), the hearing inside the window. For the Companies House target it must name a
 * company and print a Gazette date 61 to 92 days before `now` (a notice "older than two months", so the
 * company dissolves on a predictable schedule soon). At most 5, ordered by that date, then by URL, so
 * two runs over the same results list the same numbers.
 * @param {{ url: string; title: string; snippet: string }[]} results
 * @param {{ now: string; windowEnd?: string; kind?: "person" | "company" }} opts
 */
export function selectCandidates(results, { now, windowEnd = WINDOW_END, kind = "person" }) {
  const today = now.slice(0, 10);
  const [from, to] = kind === "company" ? [shift(today, -92), shift(today, -61)] : [today, windowEnd];
  const out = [];
  for (const r of results) {
    if (!r || typeof r.url !== "string" || !/^https?:\/\//.test(r.url)) continue;
    // The title and the snippet are read apart, so a name cannot run on into the other.
    const text = `${r.title ?? ""} | ${r.snippet ?? ""}`;
    const name = kind === "company" ? companyIn(text) : personIn(text);
    const date = datesIn(text).filter((d) => d >= from && d <= to).sort()[0];
    if (name === null || date === undefined) continue;
    if (out.some((c) => c.name === name)) continue;
    out.push({ name, date, url: r.url, title: r.title ?? "" });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.url.localeCompare(b.url));
  return out.slice(0, 5);
}

/**
 * docs/curated-watches.md: one row per watched name, with its registry, number and public source.
 * @param {{ target: string; name: string; registry: string; licence_number: string | null; source: string; watch_id: string; date: string }[]} rows
 */
export function curatedWatchesMarkdown(rows, generatedAt) {
  const lines = [
    "# Curated watches",
    "",
    `Chosen by hand from public notices (spec section 7) and watched from deploy day. Written ${generatedAt.slice(0, 10)} by \`scripts/curate-watches.mjs\`.`,
    "",
    "| Target | Name | Registry | Number | Date in the notice | Public source | Watch |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.target} | ${r.name} | ${r.registry} | ${r.licence_number ?? ""} | ${r.date} | ${r.source} | ${r.watch_id} |`),
    "",
  ];
  return lines.join("\n");
}
