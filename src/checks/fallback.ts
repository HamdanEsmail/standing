// When a register cannot be read: a check whose live read failed on the register's side (an HTTP error,
// no answer, a timeout, an empty page, a page that cannot be read) answers with the last result Standing
// read for the same question, if it holds one, instead of an error. The answer is a stored copy:
// `cached_from_check_id` names the check that read it, `checked_at` is that real read time, and `error`
// keeps the failed read's code (the only rows where `error` sits beside an outcome that is not `error`).
// The attempt's time is the check's own `started_at`. It costs nothing; the visit was already counted.
// Only the Fetch paths use it: an Agent run's finishing step bills the run and reads its own time.
import type { Flag } from "../core/status";
import { copyCandidates, finishPendingCheck, getCheck, lastResult } from "../db/checks";
import type { CheckRow } from "../db/types";
import type { Env } from "../env";
import { sameNumber } from "./record";

/** Register-side codes. A page that loads but lacks what the parser needs (`selector_not_matched`) is
 *  not one: the number path then asks the Agent, as before. */
export function registerSideFailure(code: string): boolean {
  return /^(target_|no_result$|record_page_unreadable$)|timeout|timed_out|empty/.test(code);
}

function strings(text: string | null): string[] {
  try {
    const value: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The last result for this check's question: by its cache key, else (a number lookup) the newest match
 *  of a watched or curated record with that number on the same register. */
async function storedFor(env: Env, check: CheckRow): Promise<CheckRow | null> {
  if (check.cache_key !== null) {
    const hit = await lastResult(env.DB, { key: check.cache_key });
    if (hit !== null) return hit;
  }
  // A profession picks the board on a register that has several; a record found without it could be another board's.
  if (check.number === null || check.registry === null || check.profession !== null) return null;
  const { results } = await env.DB.prepare("SELECT id, licence_number FROM records WHERE registry = ? AND record_type = ? AND watched = 1")
    .bind(check.registry, check.record_type)
    .all<{ id: string; licence_number: string | null }>();
  const record = results.find((r) => sameNumber(r.licence_number, check.number));
  return record === undefined ? null : lastResult(env.DB, { recordId: record.id });
}

/**
 * Finishes pending check `id` with the last stored result for its question, keeping `failedCode`, and
 * returns true; returns false (and changes nothing) when the failure is not on the register's side, the
 * check was not asked by a caller (a Monitor re-check reports its failure), or nothing is stored.
 */
export async function answerFromStored(env: Env, id: string, failedCode: string): Promise<boolean> {
  if (!registerSideFailure(failedCode)) return false;
  const check = await getCheck(env.DB, id);
  if (check === null || check.state !== "pending" || check.trigger !== "request") return false;
  const stored = await storedFor(env, check);
  if (stored === null) return false;
  if (stored.outcome === "ambiguous") await copyCandidates(env.DB, stored.id, id);
  return finishPendingCheck(env.DB, id, {
    outcome: stored.outcome,
    status: stored.status,
    flags: strings(stored.flags) as Flag[],
    record_id: stored.record_id,
    evidence_key: stored.evidence_key,
    variants_tried: strings(stored.variants_tried),
    suggestions: strings(stored.suggestions),
    candidates_total: stored.candidates_total,
    method: stored.method,
    checked_at: stored.checked_at,
    cached_from_check_id: stored.cached_from_check_id ?? stored.id,
    error: failedCode,
    spend_usd: 0,
  });
}
