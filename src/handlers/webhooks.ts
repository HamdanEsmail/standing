// Webhook receivers. The path carries WEBHOOK_SECRET; anything else is 404: the Agent callback and the
// Monitor route.
//
// POST /hooks/agent/:secret is TinyAgent's run-completion callback. Its payload has not been seen
// live yet, so it is read tolerantly (`run_id` or `id`, at the top level or under `data` / `run`) and
// nothing from it is stored raw. A run Standing did not start, or a check that is already done, is a
// 200 no-op; a finished run is settled exactly once (finishPendingCheck).
import { Hono } from "hono";
import { constantTimeEqual } from "../auth";
import { finishedRunFrom, isTerminal, settleAgentRun, type FinishedRun } from "../checks/resolve";
import type { Defer } from "../checks/view";
import { getCheckByRunId } from "../db/checks";
import { handleMonitorPayload } from "../monitoring/hook";
import type { Env } from "../env";
import { getRun, type AgentRun } from "../tinyfish/agent";
import { errorCodeOrNull } from "../tinyfish/client";

export const webhooksRouter = new Hono<{ Bindings: Env }>();

const MAX_RUN_ID_CHARS = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface CallbackPayload {
  runId: string | null;
  status: string | null;
  result: unknown;
  numSteps: number | null;
  finishedAt: string | null;
  errorCode: string | null;
}

/** The fields the route uses, from wherever the payload puts them. */
function readPayload(data: unknown): CallbackPayload {
  const layers = [data, isRecord(data) ? data.data : undefined, isRecord(data) ? data.run : undefined].filter(isRecord);
  const pick = (...keys: string[]): unknown => {
    for (const layer of layers) for (const key of keys) if (layer[key] !== undefined && layer[key] !== null) return layer[key];
    return undefined;
  };
  const id = pick("run_id", "id");
  const status = pick("status");
  const steps = pick("num_of_steps");
  const finished = pick("finished_at");
  const error = pick("error");
  return {
    runId: typeof id === "string" && id !== "" && id.length <= MAX_RUN_ID_CHARS ? id : null,
    status: typeof status === "string" ? status.toUpperCase() : null,
    result: pick("result") ?? null,
    numSteps: typeof steps === "number" && Number.isSafeInteger(steps) && steps >= 0 ? steps : null,
    finishedAt: typeof finished === "string" ? finished : null,
    // Only a short token: a run's own error text can echo page content.
    errorCode: errorCodeOrNull(isRecord(error) ? error.code : error),
  };
}

webhooksRouter.post("/hooks/agent/:secret", async (c) => {
  const secret = c.env.WEBHOOK_SECRET;
  if (!secret || !constantTimeEqual(c.req.param("secret"), secret)) return c.json({ error: "not_found" }, 404);

  const ignored = () => c.json({ ok: true, ignored: true });
  let data: unknown;
  try {
    data = JSON.parse(await c.req.text());
  } catch {
    return ignored();
  }
  const payload = readPayload(data);
  if (payload.runId === null) return ignored();
  const runId = payload.runId;
  const check = await getCheckByRunId(c.env.DB, runId);
  if (check === null || check.state !== "pending") return ignored();
  if (payload.status !== null && !isTerminal(payload.status)) return c.json({ ok: true });

  let run: FinishedRun | null;
  if (payload.status === "FAILED" || payload.status === "CANCELLED") {
    run = {
      runId,
      status: payload.status,
      result: null,
      num_of_steps: payload.numSteps,
      finished_at: payload.finishedAt,
      steps: [],
      errorCode: payload.errorCode,
    };
    if (run.num_of_steps === null) {
      // The steps are billed even for a failed run; read the count when the callback leaves it out.
      try {
        const read = await getRun(c.env, runId, "none");
        run.num_of_steps = read.num_of_steps;
        run.finished_at ??= read.finished_at;
      } catch {
        console.error("agent run could not be read for its step count");
      }
    }
  } else {
    // COMPLETED (or no status): the run itself carries the steps, finished_at, num_of_steps and the
    // result. When it cannot be read the check stays pending for the cron's follow-up.
    let read: AgentRun;
    try {
      read = await getRun(c.env, runId, "url");
    } catch {
      console.error("agent run could not be read");
      return c.json({ ok: true, deferred: true });
    }
    run = finishedRunFrom(runId, read);
    if (run === null) return c.json({ ok: true });
    if (run.result === null || run.result === undefined) run.result = payload.result;
    run.num_of_steps ??= payload.numSteps;
    run.finished_at ??= payload.finishedAt;
  }

  const defer: Defer = (work) => c.executionCtx.waitUntil(work);
  await settleAgentRun(c.env, check, run, defer);
  return c.json({ ok: true });
});

// POST /hooks/monitor/:secret: one TinyFish Monitor run (src/monitoring/hook.ts). A wrong secret is
// 404 with no body; an unknown monitor is 404 `unknown_monitor`; a run already received is a 200
// duplicate that changes nothing.
webhooksRouter.post("/hooks/monitor/:secret", async (c) => {
  const secret = c.env.WEBHOOK_SECRET;
  if (!secret || !constantTimeEqual(c.req.param("secret"), secret)) return c.body(null, 404);
  let data: unknown;
  try {
    data = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }
  const defer: Defer = (work) => c.executionCtx.waitUntil(work);
  const result = await handleMonitorPayload(c.env, data, defer);
  return result.body === null ? c.body(null, 404) : c.json(result.body, result.status);
});
