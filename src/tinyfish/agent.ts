// TinyAgent: one capped run per registry lookup. A run is started asynchronously with a
// webhook, read back by id, and its steps carry the screenshots from which the evidence image
// is picked. Agent steps are billed when the run finishes, by the caller (from `num_of_steps`),
// so nothing here records spend.
import { AGENT_MAX_DURATION_SECONDS, AGENT_MAX_STEPS } from "../core/limits";
import type { Env } from "../env";
import { readJson, TinyFishError, tinyfishFetch } from "./client";

const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const RUNS_API = "https://agent.tinyfish.ai/v1/runs";

const MAX_ERROR_CHARS = 300;

export type StartRunParams = {
  /** The page the run starts on. */
  url: string;
  goal: string;
  /** JSON Schema for the run's `result`. */
  outputSchema: object;
  browserProfile: "lite";
  /** TinyFish calls this when the run ends. It holds the webhook secret, so it is never logged. */
  callbackUrl: string;
};

/**
 * Starts a run capped at AGENT_MAX_STEPS steps and AGENT_MAX_DURATION_SECONDS seconds.
 * Any 429 waits 60 s and retries up to 3 times (the account allows few
 * concurrent runs); after that it throws a TinyFishError with code `busy`.
 */
export async function startRun(
  env: Env,
  p: StartRunParams,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ runId: string }> {
  const res = await tinyfishFetch(env, RUN_ASYNC_API, {
    method: "POST",
    body: JSON.stringify({
      url: p.url,
      goal: p.goal,
      browser_profile: p.browserProfile,
      agent_config: { max_steps: AGENT_MAX_STEPS, max_duration_seconds: AGENT_MAX_DURATION_SECONDS },
      output_schema: p.outputSchema,
      webhook_url: p.callbackUrl,
    }),
    retryRateLimit: true,
    sleep: opts.sleep,
  });
  const json = await readJson<{ run_id?: unknown }>(res);
  if (typeof json.run_id !== "string" || json.run_id === "") {
    throw new TinyFishError(502, "no_run_id", "TinyFish accepted the Agent run but returned no run_id");
  }
  return { runId: json.run_id };
}

export type AgentStep = {
  id: string;
  /** What the step did, in TinyFish's words ("Open first matching entry for ..."). */
  action: string | null;
  /** A screenshot URL; only present when the run was read with `screenshots: "url"`. */
  screenshot: string | null;
};

/** What a run looks like to the rest of the Worker. Missing fields are null, never absent. */
export type AgentRun = {
  status: string;
  result: unknown;
  num_of_steps: number | null;
  /** When the run began on TinyFish (`started_at`, else `created_at`). */
  started_at: string | null;
  finished_at: string | null;
  /** The failure, as text (a string, or the message or code of an error object); null when none. */
  error: string | null;
  steps: AgentStep[];
};

function optionalString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function runErrorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return error === "" ? null : error.slice(0, MAX_ERROR_CHARS);
  if (typeof error === "object") {
    const o = error as { message?: unknown; code?: unknown };
    for (const v of [o.message, o.code]) if (typeof v === "string" && v !== "") return v.slice(0, MAX_ERROR_CHARS);
  }
  return "agent_error";
}

function readSteps(steps: unknown): AgentStep[] {
  if (!Array.isArray(steps)) return [];
  const out: AgentStep[] = [];
  for (const s of steps as unknown[]) {
    if (s === null || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id === "") continue;
    out.push({ id: o.id, action: optionalString(o.action), screenshot: optionalString(o.screenshot) });
  }
  return out;
}

/**
 * Reads a run. `screenshots: "url"` adds a screenshot URL to each step that has one (those URLs
 * are not the API-key endpoint; use downloadStepScreenshot for the bytes); "none" is cheaper
 * and enough to poll the status and read the result.
 */
export async function getRun(env: Env, runId: string, screenshots: "url" | "none"): Promise<AgentRun> {
  const res = await tinyfishFetch(env, `${RUNS_API}/${encodeURIComponent(runId)}?screenshots=${screenshots}&html=none`, {
    method: "GET",
  });
  const json = await readJson<Record<string, unknown>>(res);
  return {
    status: typeof json.status === "string" ? json.status : "UNKNOWN",
    result: json.result ?? null,
    num_of_steps: typeof json.num_of_steps === "number" ? json.num_of_steps : null,
    started_at: optionalString(json.started_at) ?? optionalString(json.created_at),
    finished_at: optionalString(json.finished_at),
    error: runErrorText(json.error),
    steps: readSteps(json.steps),
  };
}

/**
 * The bytes of one step's screenshot (a JPEG). This is the API-key endpoint, which has the
 * `/v1` prefix; the `screenshot` URLs inside `steps[]` do not and are not fetchable with the key.
 * The image is part of the step already billed, so there is no spend row. Throws a TinyFishError
 * on an HTTP error, on an answer that is not an image, and on an empty one.
 */
export async function downloadStepScreenshot(env: Env, runId: string, stepId: string): Promise<ArrayBuffer> {
  const res = await tinyfishFetch(
    env,
    `${RUNS_API}/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/screenshot`,
    { method: "GET" },
  );
  if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
    throw new TinyFishError(502, "not_an_image", "TinyFish step screenshot was not an image");
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) throw new TinyFishError(502, "empty_image", "TinyFish step screenshot was empty");
  return bytes;
}

// A step whose action says it is on the person's or company's own page...
const ON_RECORD_PAGE = /\b(?:details?|entry|entries|records?|registrants?)\b/i;
// ...unless it is about leaving that page or reading the list: going back, returning the answer,
// the search results, counting results. Those screens show the results list, not the record.
const LEAVES_RECORD_PAGE = /\b(?:back|return(?:s|ed|ing)?|search results?|results? (?:list|page)|count(?:s|ed|ing)?)\b/i;

/**
 * The step whose screenshot is the evidence: the LAST step that has a screenshot and whose
 * action mentions a details, entry, record or registrant page without going back, returning or
 * counting the search results; when there is none, the last step with a screenshot; null when no
 * step has one. (The last step *mentioning the entry* is wrong: the real GMC run ends with
 * "Return search results and entry details", whose screen is the results list.)
 */
export function pickEvidenceStep(run: { steps: readonly AgentStep[] }): string | null {
  let lastWithScreenshot: string | null = null;
  let lastOnRecordPage: string | null = null;
  for (const step of run.steps) {
    if (step.screenshot === null || step.screenshot === "") continue;
    lastWithScreenshot = step.id;
    const action = step.action ?? "";
    if (ON_RECORD_PAGE.test(action) && !LEAVES_RECORD_PAGE.test(action)) lastOnRecordPage = step.id;
  }
  return lastOnRecordPage ?? lastWithScreenshot;
}
