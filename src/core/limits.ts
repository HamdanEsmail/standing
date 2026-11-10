// Hard caps. Every limit in the product comes from here.
import { PRICES } from "./spend";

/** One registry lookup may take at most this many Agent steps... */
export const AGENT_MAX_STEPS = 12;
/** ...and this long. */
export const AGENT_MAX_DURATION_SECONDS = 160;
/** At most one Agent run is in flight (one run at a time keeps spend and the load on the registers predictable). A slot holder older than this
 *  many minutes no longer blocks the next queued check. */
export const AGENT_SLOT_STALE_MINUTES = 5;

/** Monitors we will ever hold on TinyFish at once. */
export const MAX_MONITORS = 10;
/** Of those, the regulator decision pages shared by every watch (NMC, SRA). */
export const SHARED_MONITORS = 2;
/** Watch slots for the curated demo records that stay for the live run. */
export const CURATED_WATCH_SLOTS = 4;
/** Watch slots open to public visitors. */
export const PUBLIC_WATCH_SLOTS = 4;
/** A public watch is kept this long, then its Monitor is deleted and its history kept. */
export const PUBLIC_WATCH_TTL_DAYS = 7;

export const PUBLIC_CHECKS_PER_IP_PER_DAY = 25;
export const PUBLIC_WATCHES_PER_IP = 2;

/** A check result is reused for this long unless the caller asks for a fresh one. */
export const CACHE_HOURS = 24;
/** A public record nobody watches is deleted after this long. */
export const PUBLIC_RECORD_TTL_HOURS = 24;
/** An ambiguous result lists at most this many candidates (the total is kept). */
export const CANDIDATES_MAX = 10;

/** Full-page screenshots (TinyBrowser) are cut off at this height in pixels. */
export const SCREENSHOT_MAX_HEIGHT = 8000;

/** When total spend reaches this many US dollars, the Worker pauses everything that costs money
 *  ($4 bounds what the public product can spend on TinyFish). */
export const SPEND_PAUSE_USD = 4;

/** Across every public caller, at most this many public checks a UTC day may start an Agent run
 *  (cached answers, Fetch-method checks and admin calls do not count). */
export const PUBLIC_AGENT_CHECKS_PER_DAY = 8;

/** The most one Agent run can cost: TinyFish has run one step past `max_steps` (13 on a 12-step cap,
 *  seen live on 9 Nov 2026), so the estimate counts 13 steps at $0.016 and is never under the real cost. */
export const AGENT_ESTIMATE_USD = Math.round((AGENT_MAX_STEPS + 1) * PRICES.agent_step * 1e6) / 1e6;
/** A Fetch read is free; its evidence screenshot is not. */
export const FETCH_ESTIMATE_USD = PRICES.screenshot;

/** What a fresh check by this method costs at most (the API's `estimated_cost_usd`, the site's price). */
export function estimateUsd(method: "agent" | "fetch"): number {
  return method === "agent" ? AGENT_ESTIMATE_USD : FETCH_ESTIMATE_USD;
}
