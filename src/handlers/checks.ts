// POST /api/checks and GET /api/checks/:id (spec 4.4).
import { Hono } from "hono";
import { isAdmin, visitorHash } from "../auth";
import { pumpQueue } from "../checks/queue";
import { CheckRejected, parseCheckInput, startCheck } from "../checks/run";
import { isQueued, pendingView, publicRecord, type Defer, type PendingView } from "../checks/view";
import type { RecordResult } from "../core/schema";
import { getCheck } from "../db/checks";
import type { CheckRow } from "../db/types";
import type { Env } from "../env";

export const checksRouter = new Hono<{ Bindings: Env }>();

checksRouter.post("/api/checks", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", detail: "the body must be JSON" }, 400);
  }
  const defer: Defer = (work) => c.executionCtx.waitUntil(work);
  try {
    const input = parseCheckInput(body);
    const who = { admin: isAdmin(c), ipHash: await visitorHash(c.env, c.req.header("CF-Connecting-IP")) };
    const started = await startCheck(c.env, input, who, defer);
    return c.json(
      {
        check_id: started.checkId,
        status: started.status,
        cached: started.cached,
        estimated_cost_usd: started.estimatedCostUsd,
      },
      202,
    );
  } catch (err) {
    if (err instanceof CheckRejected) return c.json(err.body, err.status);
    throw err;
  }
});

/**
 * A check as GET /api/checks/:id and the site's result page see it: null for an unknown id, the
 * pending view before it is done, the public record once done. Reading a queued check pumps the queue,
 * which starts it once the slot is free or its holder is stale.
 */
export async function readCheck(
  env: Env,
  id: string,
  defer: Defer,
): Promise<{ check: CheckRow; pending: PendingView; record?: never } | { check: CheckRow; record: RecordResult; pending?: never } | null> {
  let check = await getCheck(env.DB, id);
  if (check === null) return null;
  if (isQueued(check)) {
    await pumpQueue(env, defer);
    check = (await getCheck(env.DB, id)) ?? check;
  }
  if (check.state === "pending") return { check, pending: pendingView(check) };
  return { check, record: await publicRecord(env, check) };
}

/** The public record once done; `{status: "pending", started_at, run_id, queued}` before. */
checksRouter.get("/api/checks/:id", async (c) => {
  const read = await readCheck(c.env, c.req.param("id"), (work) => c.executionCtx.waitUntil(work));
  if (read === null) return c.json({ error: "not_found" }, 404);
  return c.json(read.pending ?? read.record);
});
