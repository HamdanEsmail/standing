// TinyFish Monitor: Page monitors (one per watched record page) and Topic monitors (one search
// query per watched person). Creating either runs a baseline check at once and returns it in
// the 201 body (the webhook is not called for it). PATCH edits must include `schedule_cron`;
// `GET /v1/monitors/{id}` answers with the monitor itself, not wrapped.
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { readJson, TinyFishError, tinyfishFetch } from "./client";

const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";

const monitorUrl = (id: string) => `${MONITORS_API}/${encodeURIComponent(id)}`;

export type CreateMonitorParams = {
  url: string;
  name: string;
  scheduleCron: string;
  purpose: string;
  webhookUrl: string;
};

type CreateBody = {
  monitor?: { id?: unknown };
  run?: { id?: unknown; results?: { text?: unknown }[]; errors?: unknown[] };
};

/**
 * Creates a Page (fetch) Monitor and returns its baseline. If TinyFish answers 201 but the
 * baseline has no text (no result, or errors), the Monitor is deleted again and a
 * `baseline_failed` error is thrown, so no orphan Monitor keeps a slot and bills us.
 */
export async function createMonitor(
  env: Env,
  p: CreateMonitorParams,
): Promise<{ monitorId: string; baselineText: string; baselineRunId: string }> {
  const res = await tinyfishFetch(env, MONITORS_API, {
    method: "POST",
    body: JSON.stringify({
      type: "fetch",
      name: p.name,
      config: { url: p.url, format: "markdown" },
      schedule_cron: p.scheduleCron,
      purpose: p.purpose,
      webhook_url: p.webhookUrl,
    }),
    // The baseline is a completed check.
    spend: { kind: "monitor_check", amountUsd: PRICES.monitor_check, ref: p.url },
  });
  const body = await readJson<CreateBody>(res);

  const monitorId = typeof body.monitor?.id === "string" ? body.monitor.id : null;
  const baselineRunId = typeof body.run?.id === "string" ? body.run.id : null;
  const text = body.run?.results?.[0]?.text;
  const failedChecks = body.run?.errors?.length ?? 0;

  if (monitorId !== null && baselineRunId !== null && typeof text === "string" && text !== "" && failedChecks === 0) {
    return { monitorId, baselineText: text, baselineRunId };
  }

  if (monitorId !== null) {
    try {
      await deleteMonitor(env, monitorId);
    } catch {
      // Best effort. The caller still gets baseline_failed.
    }
  }
  throw new TinyFishError(
    502,
    "baseline_failed",
    `TinyFish created the monitor but the baseline check returned no page text${failedChecks > 0 ? ` (${failedChecks} fetch error${failedChecks === 1 ? "" : "s"})` : ""}`,
  );
}

export type CreateTopicMonitorParams = {
  /** The search query the Monitor re-runs on its schedule. */
  query: string;
  name: string;
  scheduleCron: string;
  purpose: string;
  webhookUrl: string;
  /** Only results newer than this count as new. Default 1440 (one day). */
  recencyMinutes?: number;
  /** Results kept per run. Default 5. */
  resultLimit?: number;
};

type CreateTopicBody = { monitor?: { id?: unknown } };

/**
 * Creates a Topic (search) Monitor. Unlike a Page monitor, an empty baseline is normal (the
 * verified 201 has `result_count: 0`: nothing has been published about the person yet), so only
 * the monitor id is required. The baseline run is billed, so it records one `monitor_check`;
 * its ref is the monitor's name, never the query, which names a person.
 */
export async function createTopicMonitor(env: Env, p: CreateTopicMonitorParams): Promise<{ monitorId: string }> {
  const res = await tinyfishFetch(env, MONITORS_API, {
    method: "POST",
    body: JSON.stringify({
      type: "search",
      name: p.name,
      config: { query: p.query, recency_minutes: p.recencyMinutes ?? 1440, result_limit: p.resultLimit ?? 5 },
      schedule_cron: p.scheduleCron,
      purpose: p.purpose,
      webhook_url: p.webhookUrl,
    }),
    spend: { kind: "monitor_check", amountUsd: PRICES.monitor_check, ref: p.name },
  });
  const body = await readJson<CreateTopicBody>(res);
  const monitorId = typeof body.monitor?.id === "string" ? body.monitor.id : "";
  if (monitorId === "") {
    throw new TinyFishError(502, "no_monitor_id", "TinyFish answered 201 for the topic monitor but returned no monitor id");
  }
  return { monitorId };
}

export async function updateMonitor(
  env: Env,
  id: string,
  p: { scheduleCron: string; name?: string; purpose?: string; webhookUrl?: string | null },
): Promise<void> {
  // TinyFish PATCH is a union: an edit must carry schedule_cron. The other fields are
  // sent only when the caller names them, and `webhookUrl: null` clears the webhook.
  const body: Record<string, unknown> = { schedule_cron: p.scheduleCron };
  if ("name" in p) body.name = p.name;
  if ("purpose" in p) body.purpose = p.purpose;
  if ("webhookUrl" in p) body.webhook_url = p.webhookUrl;
  await tinyfishFetch(env, monitorUrl(id), { method: "PATCH", body: JSON.stringify(body) });
}

export async function setMonitorStatus(env: Env, id: string, status: "active" | "paused"): Promise<void> {
  // The status change must be sent alone; mixed with other fields it is not a valid PATCH.
  await tinyfishFetch(env, monitorUrl(id), { method: "PATCH", body: JSON.stringify({ status }) });
}

/** A Monitor that is already gone (404) counts as deleted; the expiry step relies on that. */
export async function deleteMonitor(env: Env, id: string): Promise<void> {
  try {
    await tinyfishFetch(env, monitorUrl(id), { method: "DELETE" });
  } catch (err) {
    if (err instanceof TinyFishError && err.status === 404) return;
    throw err;
  }
}

export type MonitorSummary = {
  id: string;
  status: string;
  name: string | null;
  /** `fetch` (Page) or `search` (Topic); null when TinyFish names no type or a new one. */
  type: "fetch" | "search" | null;
};

export async function listMonitors(env: Env): Promise<MonitorSummary[]> {
  const res = await tinyfishFetch(env, MONITORS_API, { method: "GET" });
  const body = await readJson<{ monitors?: unknown } | unknown[]>(res);
  const list = Array.isArray(body) ? body : (body as { monitors?: unknown }).monitors;
  if (!Array.isArray(list)) return [];
  const out: MonitorSummary[] = [];
  for (const m of list as Record<string, unknown>[]) {
    if (m === null || typeof m !== "object" || typeof m.id !== "string") continue;
    out.push({
      id: m.id,
      status: typeof m.status === "string" ? m.status : "unknown",
      name: typeof m.name === "string" ? m.name : null,
      type: m.type === "fetch" || m.type === "search" ? m.type : null,
    });
  }
  return out;
}
