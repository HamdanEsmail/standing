import { Hono } from "hono";
import { adminOnly } from "./auth";
import { runCron } from "./cron";
import type { Env } from "./env";
import { checksRouter } from "./handlers/checks";
import { objectsRouter } from "./handlers/objects";
import { recordsRouter } from "./handlers/records";
import { registriesRouter } from "./handlers/registries";
import { statsRouter } from "./handlers/stats";
import { watchesRouter } from "./handlers/watches";
import { webhooksRouter } from "./handlers/webhooks";
import { runReaderCheck } from "./readerCheck";
import { notFound, siteRouter } from "./site/router";

const app = new Hono<{ Bindings: Env }>();

app.route("/", checksRouter);
app.route("/", webhooksRouter);
app.route("/", objectsRouter);
app.route("/", registriesRouter);
app.route("/", watchesRouter);
app.route("/", recordsRouter);
app.route("/", statsRouter);

app.post("/api/admin/ping", adminOnly, (c) => c.json({ ok: true }));

// The site's screens, last, so every route above keeps its answer. Static files (public/, the
// wrangler.jsonc `assets` block) are served before the Worker runs at all.
app.route("/", siteRouter);

// No route matched: Hono's own plain 404 for the API, the hooks and the evidence files, and for
// every path while the site is off; the site's 404 page otherwise.
app.notFound(notFound);

/**
 * The hourly job (wrangler.jsonc `15 * * * *`): expiry, purge, follow-ups, monitor health; then the
 * daily reader check's one register, last, so nothing of the job's own work waits on a register.
 */
async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(hourly(env));
}

async function hourly(env: Env): Promise<void> {
  await runCron(env);
  await runReaderCheck(env);
}

export { app };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
