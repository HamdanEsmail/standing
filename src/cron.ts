// The hourly job (`15 * * * *`). It never checks again, on its own, a record someone looked up or
// watches: a watched record is checked again only when its Monitor reports a change. It expires, purges,
// finishes work a caller or a Monitor already started, and checks the health of Standing's own
// monitors. Each step runs even when an earlier one fails; a failed step is named in `failed_steps`.
// After this job the same hourly run makes the daily reader check (src/readerCheck.ts): one known
// business record on one register, which tests Standing's own reader and changes no record, event
// or watch.
// Nothing here pauses, edits or resumes a Monitor (a paused and resumed Monitor cannot be relied on to
// run again), and it never looks at a Monitor that is not in Standing's own tables. One step makes and
// deletes a Monitor of its own: the shared NMC page has a new address each month, and the Monitor
// follows it (one free read of the new page first).
import { AGENT_ESTIMATE_USD, PUBLIC_RECORD_TTL_HOURS } from "./core/limits";
import { recordSpend } from "./core/spend";
import { pumpQueue } from "./checks/queue";
import { finishedRunFrom, settleAgentRun } from "./checks/resolve";
import { releaseSlot } from "./checks/slot";
import { expirePublicChecks, finishPendingCheck } from "./db/checks";
import type { CheckRow, SharedMonitorRow, WatchRow } from "./db/types";
import { expireWatches, listSharedMonitors, listWatches, setWatchStatus } from "./db/watches";
import type { Env } from "./env";
import { rollSharedMonitors } from "./monitoring/watch";
import { dropAllScreens } from "./site/htmlCache";
import { getRun } from "./tinyfish/agent";
import { deleteMonitor, listMonitors } from "./tinyfish/monitor";

const MINUTE = 60_000;
/** A pending check with a run is looked up after this long (its callback may never come)... */
const FOLLOW_UP_AFTER_MIN = 10;
/** ...and given up on after this long. */
const TIMEOUT_AFTER_MIN = 30;
/** A watch whose Monitor has not delivered a run for this long is reported (runs are every 12 h). */
const NO_RUN_HOURS = 26;
/** At most this many R2 evidence objects are looked at by one orphan sweep. */
const SWEEP_MAX = 300;

export interface CronResult {
  expired_watches: number;
  purged_checks: number;
  pending_followups: number;
  /** Plain sentences about Standing's own monitors that need a look. */
  unhealthy: string[];
  failed_steps: string[];
}

/** Public watches past `expires_at`: their Monitor is deleted (already gone counts), the watch row is
 *  kept as expired, and the record keeps `watched = 1` (its history is real Monitor history). */
async function expireStep(env: Env, now: Date): Promise<number> {
  const expired = await expireWatches(env.DB, now.toISOString());
  for (const w of expired) {
    if (w.monitor_id === null) continue;
    try {
      await deleteMonitor(env, w.monitor_id);
    } catch {
      console.error("expired watch: monitor could not be deleted");
    }
  }
  return expired.length;
}

/** Unwatched public checks older than the TTL go, with their evidence; then evidence objects older
 *  than the TTL that no check or record names any more (a record's key replaced by a later read). */
async function purgeStep(env: Env, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PUBLIC_RECORD_TTL_HOURS * 3_600_000);
  const { ids, evidenceKeys } = await expirePublicChecks(env.DB, cutoff.toISOString());
  if (evidenceKeys.length > 0) await env.STORE.delete(evidenceKeys);

  const { results } = await env.DB.prepare(
    "SELECT evidence_key AS key FROM checks WHERE evidence_key IS NOT NULL UNION SELECT evidence_key AS key FROM records WHERE evidence_key IS NOT NULL",
  ).all<{ key: string }>();
  const named = new Set(results.map((r) => r.key.replace(/\.(jpg|md)$/, "")));
  const listed = await env.STORE.list({ prefix: "evidence/", limit: SWEEP_MAX });
  const orphans = listed.objects
    .filter((o) => o.uploaded.getTime() < cutoff.getTime() && !named.has(o.key.replace(/\.(jpg|md)$/, "")))
    .map((o) => o.key);
  if (orphans.length > 0) await env.STORE.delete(orphans);
  return ids.length;
}

/**
 * Work already started that never finished. A check with a run, pending for over 10 minutes: its run is
 * read; an ended run is settled exactly as the callback would (finish-once, so a late callback is a
 * no-op); a run still going 30 minutes after it started (its own start on TinyFish, not when the check
 * was asked for: a check can wait in the queue) ends the check as `error: "timeout"` and frees the
 * slot. The run is live and may still bill, and its callback will find the check finished, so its cost
 * is booked now at the most a run can cost. A
 * Fetch-path check pending for over 10 minutes with no run (the Worker died mid-read) ends as
 * `error: "timeout"`; it is never queued. Finishing a pending Agent match may read that record's page
 * with Fetch: that completes a lookup someone asked for, it is not a scheduled registry read. Then the
 * queue is pumped.
 */
async function followUpStep(env: Env, now: Date): Promise<number> {
  const before = new Date(now.getTime() - FOLLOW_UP_AFTER_MIN * MINUTE).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT * FROM checks WHERE state = 'pending' AND started_at < ? AND (run_id IS NOT NULL OR method = 'fetch') ORDER BY started_at",
  )
    .bind(before)
    .all<CheckRow>();
  const timedOut = now.getTime() - TIMEOUT_AFTER_MIN * MINUTE;
  let handled = 0;
  for (const check of results) {
    try {
      if (check.run_id === null) {
        if (await finishPendingCheck(env.DB, check.id, { outcome: "error", error: "timeout", spend_usd: check.spend_usd ?? 0 })) handled++;
        continue;
      }
      const read = await getRun(env, check.run_id, "url");
      const run = finishedRunFrom(check.run_id, read);
      const runStart = Date.parse(read.started_at ?? check.started_at ?? "");
      if (run !== null) {
        if ((await settleAgentRun(env, check, run)).applied) handled++;
      } else if (runStart < timedOut) {
        const spend_usd = Math.round(((check.spend_usd ?? 0) + AGENT_ESTIMATE_USD) * 1e6) / 1e6;
        if (await finishPendingCheck(env.DB, check.id, { outcome: "error", error: "timeout", spend_usd })) {
          await recordSpend(env.DB, "agent_step", AGENT_ESTIMATE_USD, check.id);
          handled++;
        }
        await releaseSlot(env.DB, check.id);
      }
    } catch {
      console.error("pending check follow-up failed");
    }
  }
  await pumpQueue(env);
  return handled;
}

/** When a monitor last delivered a run: the newest `monitor_check` spend row the webhook wrote for it. */
async function lastRunAt(env: Env, monitorId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT MAX(at) AS at FROM spend WHERE kind = 'monitor_check' AND ref = ?").bind(monitorId).first<{ at: string | null }>();
  return row?.at ? Date.parse(row.at) : null;
}

/**
 * Health of Standing's own monitors only. One `listMonitors`; each active watch whose Monitor is missing
 * or not `active` is marked `failed`; a shared decision page's is reported. Any watch or shared monitor
 * with no delivered run for over 26 hours (Monitor runs can arrive late or not at all) is reported too.
 * A failed listMonitors is reported, never thrown.
 */
async function healthStep(env: Env, now: Date, unhealthy: string[]): Promise<void> {
  const watches: WatchRow[] = await listWatches(env.DB, { status: "active" });
  const shared: SharedMonitorRow[] = (await listSharedMonitors(env.DB)).filter((m) => m.monitor_id !== null);
  let onAccount: Map<string, string>;
  try {
    onAccount = new Map((await listMonitors(env)).map((m) => [m.id, m.status]));
  } catch {
    unhealthy.push("monitor list could not be read from TinyFish");
    return;
  }
  const stale = now.getTime() - NO_RUN_HOURS * 3_600_000;
  for (const w of watches) {
    if (w.monitor_id === null) continue;
    const status = onAccount.get(w.monitor_id);
    if (status !== "active") {
      await setWatchStatus(env.DB, w.id, "failed");
      unhealthy.push(`watch ${w.id}: its Monitor is ${status === undefined ? "missing" : status}; marked failed`);
      continue;
    }
    const last = (await lastRunAt(env, w.monitor_id)) ?? Date.parse(w.created_at ?? "");
    if (Number.isFinite(last) && last < stale) unhealthy.push(`watch ${w.id}: no Monitor run for more than ${NO_RUN_HOURS} hours`);
  }
  for (const m of shared) {
    const status = onAccount.get(m.monitor_id!);
    if (status !== "active") {
      unhealthy.push(`shared ${m.registry} decision page: its Monitor is ${status === undefined ? "missing" : status}`);
      continue;
    }
    const last = (await lastRunAt(env, m.monitor_id!)) ?? Date.parse(m.created_at ?? "");
    if (Number.isFinite(last) && last < stale) unhealthy.push(`shared ${m.registry} decision page: no Monitor run for more than ${NO_RUN_HOURS} hours`);
  }
}

export async function runCron(env: Env, now: Date = new Date()): Promise<CronResult> {
  const out: CronResult = { expired_watches: 0, purged_checks: 0, pending_followups: 0, unhealthy: [], failed_steps: [] };
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch {
      console.error(`cron step failed: ${name}`);
      out.failed_steps.push(name);
    }
  };
  await step("expire_watches", async () => {
    out.expired_watches = await expireStep(env, now);
  });
  await step("purge_checks", async () => {
    out.purged_checks = await purgeStep(env, now);
  });
  await step("follow_up", async () => {
    out.pending_followups = await followUpStep(env, now);
  });
  await step("shared_pages", async () => {
    out.unhealthy.push(...(await rollSharedMonitors(env, now)));
  });
  await step("health", () => healthStep(env, now, out.unhealthy));
  // The site's stored screens: all dropped each hour, so the next visit shows this hour's figures.
  await step("stored_screens", async () => {
    await dropAllScreens(env);
  });
  if (out.unhealthy.length > 0 || out.failed_steps.length > 0) console.warn("cron", JSON.stringify(out));
  return out;
}
