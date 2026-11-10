// Pure text for the site: dates, money, counts, status words and the fixed copy. Every date in the UI
// is UTC and absolute ("5 Nov 2026, 09:22 UTC"); ISO 8601 stays in data and URLs. Nothing here touches
// the database or the clock.
import { PUBLIC_CHECKS_PER_IP_PER_DAY, PUBLIC_WATCH_SLOTS, PUBLIC_WATCHES_PER_IP, SPEND_PAUSE_USD } from "../core/limits";
import type { Flag, Outcome, Status } from "../core/status";
import type { RecordType } from "../registries/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const pad = (n: number): string => String(n).padStart(2, "0");

/** "5 Nov 2026, 09:22 UTC". A string that is not a time comes back as it was. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatDate(iso)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "5 Nov 2026": the date alone, in UTC. A string that is not a time comes back as it was. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A register's own date (YYYY-MM-DD) in full: "29 December 1951". Anything else comes back as it was. */
export function formatDay(isoDay: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!m) return isoDay;
  const month = LONG_MONTHS[Number(m[2]) - 1];
  return month === undefined ? isoDay : `${Number(m[3])} ${month} ${m[1]}`;
}

/** Dollars to two places: "$0.21", "$0.00". */
export function money(usd: number): string {
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`;
}

/** The count and the word that goes with it: "1 register", "6 registers". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The status words a match can show, as the result prints them. */
export const STATUS_WORD: Record<Status, string> = {
  active: "Active",
  conditions: "Conditions",
  suspended: "Suspended",
  removed: "Removed",
  not_licensed: "Not licensed",
  expired: "Expired",
  dissolved: "Dissolved",
  insolvency: "Insolvency",
  unknown: "Unknown",
};

/** The word for every outcome that is not a match. None of them is a status, so none takes a status colour. */
export const OUTCOME_WORD: Record<Exclude<Outcome, "match">, string> = {
  ambiguous: "Ambiguous",
  no_match: "No match",
  unsupported: "Not supported",
  error: "Check failed",
};

export const FLAG_TEXT: Record<Flag, string> = {
  proposal_to_strike_off: "Proposal to strike off",
  interim_order: "Interim order",
  under_review: "Under review",
  name_changed: "Name changed",
};

export const RECORD_TYPE_TEXT: Record<RecordType, string> = {
  doctor: "Doctor",
  nurse: "Nurse or midwife",
  solicitor: "Solicitor",
  company: "Company",
  contractor: "Contractor",
  professional: "Licensed professional",
};

/** A record type that names a person (a business is shown by name; a person is not, on any listing). */
export const isPersonType = (t: RecordType | string | null): boolean => t !== null && t !== "company" && t !== "contractor";

const TYPE_SHORT: Record<string, string> = { doctor: "Doctor", nurse: "Nurse", solicitor: "Solicitor", professional: "Licensed professional" };
const REGISTRY_SHORT: Record<string, string> = { gmc: "GMC", nmc: "NMC", sra: "SRA", "ca-dca": "CA DCA", cslb: "CSLB" };

/**
 * How a record is named on a page that lists records (the home, the watchlist) and in page titles: a
 * business by its name; a person by record type and number ("Nurse · NMC 22H1252O"), never by name.
 * A person's name appears only on that record's own page and on a check's result and receipt.
 */
export function listingName(r: { record_type: string | null; registry: string | null; licence_number: string | null; full_name: string | null }): string {
  if (!isPersonType(r.record_type)) return r.full_name ?? "Name not shown";
  const type = (r.record_type !== null && TYPE_SHORT[r.record_type]) || "Registrant";
  const reg = (r.registry !== null && REGISTRY_SHORT[r.registry]) || "";
  return `${type} · ${[reg, r.licence_number ?? "number not shown"].filter(Boolean).join(" ")}`;
}

/** The places a check can name, in the form's order. */
export const PLACE_TEXT: Record<string, string> = {
  GB: "United Kingdom",
  "US-CA": "California, US",
  "US-FL": "Florida, US",
};

/** The country a jurisdiction belongs to: "US-CA" and "US-FL" are both the United States. */
export const countryOf = (jurisdiction: string): string => jurisdiction.split("-")[0]!;

// --- Fixed copy (site plan, "Honest states" and the home) ---------------------------------------

export const HOME_H1 = "The register's own answer, read a minute ago.";
export const FORM_NOTE = "Some registers answer in seconds. Those that need a real browser can take a minute or two.";
export const SCREENSHOT_MISSING = "Screenshot unavailable.";

// Honest states (site plan): the exact copy. <Registry> is the registry's full name, <q> the query as typed.
export const WAITING_FOR_SLOT =
  "Waiting for a free browser. One register search runs at a time, and each takes a minute or two. This page refreshes by itself.";

/**
 * What a running check says: what is happening and how long it takes. A visitor who is not told how
 * long a real browser takes reads a working check as a stuck one.
 */
export function runningLine(method: string | null): string {
  const takes = method === "agent" ? "In a real browser that takes a minute or two" : "That takes a few seconds";
  return `Reading the register now. ${takes}. This page refreshes by itself.`;
}

/**
 * The waiting page's clock: minutes and seconds since the check was started, as "0:47". Never negative;
 * null when the check has no start time. The page's script counts it on between reloads.
 */
export function waitClock(startedAt: string | null, now: Date): string | null {
  const at = startedAt === null ? NaN : Date.parse(startedAt);
  if (Number.isNaN(at)) return null;
  const seconds = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export const STILL_WAITING = "Still waiting. The register has not answered yet.";
export const SPEND_PAUSED_LINE = `Live checks are paused: Standing has reached its spending line of $${SPEND_PAUSE_USD}. Stored results and watched records are still shown.`;
export const AGENT_CAP_LINE = "Today's live browser checks are used. Stored results still open, and they return at 00:00 UTC.";
export const DAILY_LIMIT_LINE = `You have used today's ${PUBLIC_CHECKS_PER_IP_PER_DAY} live checks. Stored results still open.`;

/** Said beside a stored answer given because the register could not be read just now. */
export const readFailedLine = (registry: string, attemptedAt: string): string =>
  `${registry} could not be read at ${formatUtc(attemptedAt)}. This is the last result Standing read.`;

export const failedLine = (registry: string): string =>
  `The ${registry} search did not finish. Nothing was guessed. Try again, or check by registration number.`;
/** A register that showed a robot check: Standing never gets past one, so it says so. */
export const blockedLine = (registry: string): string =>
  `The ${registry} search page showed a robot check, and Standing does not get past those. Nothing was guessed. Try again later, or check by registration number.`;
export const ambiguousLine = (n: number, q: string): string =>
  `${n} ${n === 1 ? "record matches" : "records match"} “${q}”. Standing gives no status until one is chosen.`;
export const noMatchLine = (registry: string, q: string, tried: string[]): string =>
  `The ${registry} search returned no result for “${q}”.${tried.length > 0 ? ` Tried: ${tried.join(", ")}.` : ""}`;
export const slotsFullLine = (nextFreesAt: string | null): string =>
  `All ${PUBLIC_WATCH_SLOTS} public watch slots are in use.${nextFreesAt ? ` The next one frees on ${formatUtc(nextFreesAt)}.` : ""}`;
export const slotsLine = (used: number): string => `${used} of ${PUBLIC_WATCH_SLOTS} public watch slots are in use`;
export const publicWatchLine = (until: string): string => `Watched until ${formatUtc(until)}. Its history is kept after that.`;
export const noChangeLine = (watched: number): string => `No status change yet. ${watched === 1 ? "1 record is" : `${watched} records are`} watched.`;
export const WATCH_DAILY_LIMIT_LINE = `You have started today's ${PUBLIC_WATCHES_PER_IP} watches. Watched records still show their history.`;
export const MONITOR_FAILED_LINE = "TinyFish did not create the monitor, so nothing was stored. Try again later.";
export const NOT_WATCHABLE_LINE = "This record cannot be watched: the register gives it no page of its own and no name to search for.";
export const receiptLine = (registry: string, readAt: string): string =>
  `Read from ${registry} on ${formatUtc(readAt)}. This receipt shows what the register said at that moment; check again for today's status.`;
