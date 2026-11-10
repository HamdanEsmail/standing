// The Agent queue: Standing keeps at most one TinyAgent run in flight (one run at a time keeps spend and the load on the registers predictable).
// A check that needs the Agent is inserted `pending`, `method = 'agent'`, with no run (queued);
// `pumpQueue` starts the oldest queued check whenever the slot (src/checks/slot.ts) is free.
//
// pumpQueue is awaited inline, never inside waitUntil, so the 60 s waits after a 429 can run. It is
// called after a check is queued (POST /api/checks), after an Agent run settles (the callback, and
// the hourly cron), and when a queued check is polled (GET /api/checks/:id), which
// recovers a stale slot without waiting for the cron.
import { AGENT_ESTIMATE_USD, SPEND_PAUSE_USD } from "../core/limits";
import { recordSpend, totalSpend } from "../core/spend";
import { cacheKey, finishPendingCheck, getCheck, insertCheck, insertCheckUnderAgentCap, nextQueuedCheck, setRunId, type NewCheck } from "../db/checks";
import type { CheckRow, RecordRow } from "../db/types";
import type { Env } from "../env";
import { getAdapterById } from "../registries/index";
import { startRun } from "../tinyfish/agent";
import { TinyFishError } from "../tinyfish/client";
import { checkDeps } from "./deps";
import { goalFor, planSearch } from "./plan";
import { releaseSlot, takeSlot, touchSlot } from "./slot";
import { isQueued, notifyFinished, type Defer } from "./view";

/** Where TinyFish reports a finished run. It holds the webhook secret, so it is never logged. */
export function agentCallbackUrl(env: Env): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/hooks/agent/${env.WEBHOOK_SECRET}`;
}

/** True once total spend has reached SPEND_PAUSE_USD: nothing that costs money starts. */
export async function spendPaused(db: D1Database): Promise<boolean> {
  return (await totalSpend(db)) >= SPEND_PAUSE_USD;
}

/** Ends a queued check that never got a run, and tells its callback_url. A requeued check keeps the
 *  cost its first run already carried. `liveRunUsd` is for the one case where a run did start but can
 *  no longer be matched to the check: its cost is booked here, since its callback never will be. */
async function failQueued(env: Env, check: CheckRow, error: string, defer?: Defer, liveRunUsd = 0): Promise<void> {
  const spend_usd = Math.round(((check.spend_usd ?? 0) + liveRunUsd) * 1e6) / 1e6;
  if (!(await finishPendingCheck(env.DB, check.id, { outcome: "error", error, method: "agent", spend_usd }))) return;
  if (liveRunUsd > 0) await recordSpend(env.DB, "agent_step", liveRunUsd, check.id);
  const done = await getCheck(env.DB, check.id);
  if (done) await notifyFinished(env, done, defer);
}

/** What one turn of the pump did with the slot it took. */
type Turn = "next" | "stop" | "started";

/** One queued check, with the slot already taken for it. "started" means a run is live and the slot
 *  must stay held; for anything else the caller releases it. */
async function startQueued(env: Env, checkId: string, defer?: Defer): Promise<Turn> {
  // Another pump may have started this check between the read and the take.
  const check = await getCheck(env.DB, checkId);
  if (check === null || !isQueued(check)) return "next";

  const adapter = check.registry === null ? null : getAdapterById(check.registry);
  const plan = adapter === null || check.record_type === null ? null : planSearch(adapter, check.record_type, check.query_raw, check.number, check.profession);
  let goal: string | null = null;
  if (adapter !== null && plan !== null && !("invalid" in plan)) {
    try {
      goal = goalFor(adapter, plan, check.profession);
    } catch {
      goal = null;
    }
  }
  if (adapter === null || goal === null) {
    await failQueued(env, check, "invalid_query", defer);
    return "next";
  }
  if (await spendPaused(env.DB)) {
    await failQueued(env, check, "spend_paused", defer);
    return "next";
  }

  let runId: string;
  try {
    ({ runId } = await startRun(
      env,
      {
        url: adapter.searchUrl,
        goal,
        outputSchema: adapter.outputSchema,
        browserProfile: adapter.browserProfile,
        callbackUrl: agentCallbackUrl(env),
      },
      { sleep: checkDeps.sleep },
    ));
  } catch (err) {
    await failQueued(env, check, err instanceof TinyFishError ? err.code : "agent_start_failed", defer);
    return "stop";
  }

  // From here a run is live on TinyFish, so the slot stays with this check whatever happens: freeing it
  // would let a second run start beside this one. It is re-stamped so it counts from the run's start
  // (the 429 waits before it can take minutes) and goes stale only once the run is surely over.
  await touchSlot(env.DB, check.id).catch(() => console.error("agent slot could not be re-stamped"));
  let recorded = false;
  try {
    recorded = await setRunId(env.DB, check.id, runId);
  } catch {
    recorded = false;
  }
  if (!recorded) {
    // Left queued, the check would start a duplicate of the live run; its callback can no longer be
    // matched to it, so the check ends here.
    console.error("agent run id could not be recorded");
    // The run is live and will bill; nothing will ever settle it, so the most it can cost is booked now.
    await failQueued(env, check, "run_not_recorded", defer, AGENT_ESTIMATE_USD).catch(() => console.error("check could not be finished"));
  }
  return "started";
}

/**
 * Starts the oldest queued check's run if the slot is free (or its holder stale). The goal is rebuilt
 * from the check row (registry, record type, query or number, profession). When the start finally
 * fails (`busy` after the 429 retries, or any other error) the check ends as `error` with that code,
 * the slot is freed and pumping stops. A queued check that can no longer start (its query no longer
 * plans, or spending is paused) ends as an error and the next one is tried. Whatever throws, a slot
 * with no live run is released (`finally`, holder-guarded).
 */
export async function pumpQueue(env: Env, defer?: Defer): Promise<void> {
  for (;;) {
    const next = await nextQueuedCheck(env.DB);
    if (next === null) return;
    if (!(await takeSlot(env.DB, next.id))) return;

    let turn: Turn | null = null;
    try {
      turn = await startQueued(env, next.id, defer);
    } finally {
      if (turn !== "started") await releaseSlot(env.DB, next.id).catch(() => console.error("agent slot could not be released"));
    }
    if (turn !== "next") return;
  }
}

/** Inserts a check that needs the Agent as queued and pumps the queue. Returns the check id. With
 *  `publicAgentCap` (a public check) it is stored only while the day has Agent checks left, and the
 *  answer is null when it has none. */
export async function enqueueAgentCheck(env: Env, fields: NewCheck, defer?: Defer, publicAgentCap: number | null = null): Promise<string | null> {
  const row: NewCheck = { ...fields, state: "pending", method: "agent", run_id: null };
  const id = publicAgentCap === null ? await insertCheck(env.DB, row) : await insertCheckUnderAgentCap(env.DB, row, publicAgentCap);
  if (id === null) return null;
  await pumpQueue(env, defer);
  return id;
}

/**
 * The hook for Monitor-triggered re-checks: one Agent check of a stored record, by its
 * number (else its exact name), queued behind any run in flight, `trigger: "monitor"` with the
 * record and the Monitor run it answers. Its callback resolves like any other check and refreshes
 * that record (`record_id` is passed to upsertRecord). `extra` can set other columns (`added_by`,
 * `callback_url`). Null when the record has neither a number nor a name, or its registry is unknown.
 */
export async function enqueueMonitorRecheck(
  env: Env,
  record: RecordRow,
  monitorRunId: string | null,
  extra: Pick<NewCheck, "added_by" | "callback_url" | "profession"> = {},
  defer?: Defer,
): Promise<string | null> {
  const adapter = record.registry === null ? null : getAdapterById(record.registry);
  const recordType = record.record_type ?? adapter?.recordTypes[0] ?? null;
  if (adapter === null || recordType === null) return null;
  const plan = planSearch(adapter, recordType, record.full_name, record.licence_number, extra.profession);
  if ("invalid" in plan) return null;
  return enqueueAgentCheck(
    env,
    {
      registry: adapter.id,
      record_type: recordType,
      jurisdiction: adapter.country,
      query_raw: plan.by === "name" ? plan.query : record.full_name,
      query_normalized: plan.by === "name" ? plan.display : null,
      number: plan.by === "number" ? plan.number : null,
      cache_key: cacheKey(adapter.id, recordType, plan.by === "number" ? plan.number : plan.display, extra.profession),
      trigger: "monitor",
      record_id: record.id,
      monitor_run_id: monitorRunId,
      ...extra,
    },
    defer,
  );
}
