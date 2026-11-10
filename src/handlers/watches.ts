// POST and DELETE /api/records/:id/watch (spec 4.4, 4.6) and POST /api/admin/init-shared.
import { Hono } from "hono";
import { adminOnly, isAdmin, visitorHash } from "../auth";
import { callbackUrlAllowed } from "../checks/view";
import type { Env } from "../env";
import { createWatch, initSharedMonitors, removeWatch, WatchRefused } from "../monitoring/watch";

export const watchesRouter = new Hono<{ Bindings: Env }>();

async function caller(c: { env: Env; req: { header(name: string): string | undefined } }, admin: boolean) {
  return { admin, ipHash: await visitorHash(c.env, c.req.header("CF-Connecting-IP")) };
}

watchesRouter.post("/api/records/:id/watch", async (c) => {
  let body: unknown = {};
  const text = await c.req.text();
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid_body", detail: "the body must be JSON" }, 400);
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "invalid_body", detail: "the body must be a JSON object" }, 400);
  const b = body as Record<string, unknown>;
  const callbackUrl = b.callback_url === undefined || b.callback_url === null ? null : b.callback_url;
  if (callbackUrl !== null && (typeof callbackUrl !== "string" || callbackUrl.length > 2048 || !callbackUrlAllowed(c.env, callbackUrl))) {
    return c.json({ error: "invalid_body", detail: "callback_url must be an https URL on another host" }, 400);
  }
  const addedBy = b.added_by === undefined || b.added_by === null ? undefined : String(b.added_by);
  try {
    const started = await createWatch(c.env, c.req.param("id"), { callbackUrl, addedBy }, await caller(c, isAdmin(c)));
    return c.json(started, 201);
  } catch (err) {
    if (err instanceof WatchRefused) return c.json(err.body, err.status);
    throw err;
  }
});

watchesRouter.delete("/api/records/:id/watch", async (c) => {
  try {
    const watch = await removeWatch(c.env, c.req.param("id"), await caller(c, isAdmin(c)));
    return c.json({ ok: true, watch_id: watch.id, status: watch.status });
  } catch (err) {
    if (err instanceof WatchRefused) return c.json(err.body, err.status);
    throw err;
  }
});

watchesRouter.post("/api/admin/init-shared", adminOnly, async (c) => c.json({ shared: await initSharedMonitors(c.env) }));
