// What the outside sees of a check: the public record once it is done (spec 4.3), the pending
// shape before, and the caller's callback_url told once it finishes.
import { toPublicRecord, type RecordResult } from "../core/schema";
import { listCandidates } from "../db/checks";
import { getRecord } from "../db/records";
import type { CheckRow } from "../db/types";
import type { Env } from "../env";

export type Defer = (work: Promise<unknown>) => void;

export interface PendingView {
  status: "pending";
  started_at: string | null;
  run_id: string | null;
  /** Waiting for the one Agent slot: no run has started yet. */
  queued: boolean;
}

/** A check waits in the Agent queue while it is pending, is meant for the Agent and has no run yet. */
export function isQueued(check: CheckRow): boolean {
  return check.state === "pending" && check.method === "agent" && check.run_id === null;
}

export function pendingView(check: CheckRow): PendingView {
  return { status: "pending", started_at: check.started_at, run_id: check.run_id, queued: isQueued(check) };
}

/** The public record of a finished check, with the record it read (if any) and its candidates. */
export async function publicRecord(env: Env, check: CheckRow): Promise<RecordResult> {
  const record = check.record_id === null ? null : await getRecord(env.DB, check.record_id);
  const candidates = check.outcome === "ambiguous" ? await listCandidates(env.DB, check.id) : [];
  return toPublicRecord(check, record, candidates, env.PUBLIC_BASE_URL);
}

/** A callback URL is used only when it is https and not on this Worker's own host. */
export function callbackUrlAllowed(env: Env, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  let ownHost: string | null = null;
  try {
    ownHost = new URL(env.PUBLIC_BASE_URL).hostname.toLowerCase();
  } catch {
    // no base URL: nothing to compare with
  }
  const host = url.hostname.toLowerCase();
  return host !== ownHost && host !== "localhost";
}

const CALLBACK_TIMEOUT_MS = 5_000;

async function postRecord(env: Env, check: CheckRow): Promise<void> {
  if (check.callback_url === null || !callbackUrlAllowed(env, check.callback_url)) return;
  try {
    const body = JSON.stringify(await publicRecord(env, check));
    const res = await fetch(check.callback_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    await res.body?.cancel();
  } catch {
    // Best effort: the caller can always poll GET /api/checks/:id.
    console.error("check callback failed");
  }
}

/**
 * Tells a finished check's `callback_url` (POST, the public record as JSON, 5 s timeout, best
 * effort). No money is spent, so it runs in `defer` (the request's waitUntil) when given; without
 * one (the cron) it is awaited.
 */
export async function notifyFinished(env: Env, check: CheckRow, defer?: Defer): Promise<void> {
  if (check.state !== "done" || check.callback_url === null) return;
  const work = postRecord(env, check);
  if (defer) defer(work);
  else await work;
}
