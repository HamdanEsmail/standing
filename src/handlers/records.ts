// The read API (spec 4.4): a record, its history, the events feed and the export. Public, no
// TinyFish call. The feed and the export show watched or curated records only: a
// one-off public lookup never appears in them.
import { Hono } from "hono";
import { listEvents, listEventsForRecord } from "../db/events";
import { getRecord, listWatchedAndCurated } from "../db/records";
import type { EventRow } from "../db/types";
import type { Env } from "../env";
import { eventJson, recordViewById } from "../monitoring/events";

export const recordsRouter = new Hono<{ Bindings: Env }>();

// Strict ISO-8601 UTC (isoTime alone is lenient).
const SINCE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
const KINDS = new Set(["status_change", "notice", "recheck"]);

recordsRouter.get("/api/records/:id", async (c) => {
  const view = await recordViewById(c.env, c.req.param("id"));
  return view === null ? c.json({ error: "not_found" }, 404) : c.json(view);
});

recordsRouter.get("/api/records/:id/history", async (c) => {
  const record = await getRecord(c.env.DB, c.req.param("id"));
  if (record === null) return c.json({ error: "not_found" }, 404);
  const events = await listEventsForRecord(c.env.DB, record.id);
  return c.json({ record_id: record.id, events: events.map(eventJson) });
});

recordsRouter.get("/api/events", async (c) => {
  const since = c.req.query("since") ?? null;
  if (since !== null && (!SINCE.test(since) || Number.isNaN(Date.parse(since)))) {
    return c.json({ error: "invalid_query", detail: "since must be an ISO-8601 UTC date or time, e.g. 2026-11-09T00:00:00Z" }, 400);
  }
  const limitText = c.req.query("limit");
  const limit = limitText === undefined ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return c.json({ error: "invalid_query", detail: "limit must be a whole number from 1 to 200" }, 400);
  const kind = c.req.query("kind") ?? null;
  if (kind !== null && !KINDS.has(kind)) return c.json({ error: "invalid_query", detail: "kind must be status_change, notice or recheck" }, 400);
  const rows = await listEvents(c.env.DB, since, limit, kind as EventRow["kind"]);
  return c.json({
    events: rows.map((e) => ({ ...eventJson(e), record_id: e.record_id, registry: e.registry, full_name: e.full_name })),
  });
});

recordsRouter.get("/api/export.json", async (c) => {
  const records = await listWatchedAndCurated(c.env.DB);
  const out = [];
  for (const r of records) {
    const view = await recordViewById(c.env, r.id);
    if (view === null) continue;
    out.push({ ...view, events: (await listEventsForRecord(c.env.DB, r.id)).map(eventJson) });
  }
  return c.json({ generated_at: new Date().toISOString(), records: out });
});
