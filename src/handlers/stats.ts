// GET /api/stats: counts a reviewer can check the build against. From the database only: no TinyFish
// call on a public endpoint (monitor health is kept current by the hourly cron).
import { Hono } from "hono";
import { spendByKind, totalSpend } from "../core/spend";
import { eventCounts } from "../db/events";
import { listSharedMonitors, watchCounts } from "../db/watches";
import type { Env } from "../env";
import { readerChecksNow } from "../readerCheck";

export const statsRouter = new Hono<{ Bindings: Env }>();

const money = (usd: number) => Math.round(usd * 1e4) / 1e4;

/** The counts GET /api/stats answers with; the site's screens read the same function. */
export async function readStats(db: D1Database) {
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM checks) AS checks,
         (SELECT COUNT(*) FROM records) AS records,
         (SELECT COUNT(*) FROM watches) AS watches,
         (SELECT COUNT(*) FROM events) AS events,
         (SELECT COUNT(*) FROM checks WHERE state = 'done' AND cached_from_check_id IS NULL) AS fresh_checks`,
    )
    .first<{ checks: number; records: number; watches: number; events: number; fresh_checks: number }>();
  const { results: calls } = await db.prepare("SELECT kind, COUNT(*) AS n FROM spend GROUP BY kind").all<{ kind: string; n: number }>();
  const callsBy = new Map(calls.map((r) => [r.kind, r.n]));
  const spend = await totalSpend(db);
  const byKind = await spendByKind(db);
  const watches = await watchCounts(db);
  const shared = (await listSharedMonitors(db)).filter((m) => m.monitor_id !== null).length;
  const fresh = counts?.fresh_checks ?? 0;
  return {
    checks: counts?.checks ?? 0,
    records: counts?.records ?? 0,
    watches: counts?.watches ?? 0,
    events: counts?.events ?? 0,
    spend_usd: money(spend),
    watches_by_kind: watches.byKind,
    events_by_kind: await eventCounts(db),
    spend_by_kind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, money(v)])),
    cost_per_check: fresh === 0 ? 0 : money(spend / fresh),
    monitors: { ...watches.byStatus, shared },
    // One spend-ledger row per TinyFish call (free calls at $0): Agent runs billed, Fetch reads, Search
    // calls, Monitor creations plus delivered Monitor runs, Browser sessions.
    tinyfish_calls: {
      agent: callsBy.get("agent_step") ?? 0,
      fetch: callsBy.get("fetch") ?? 0,
      search: callsBy.get("search") ?? 0,
      monitor: callsBy.get("monitor_check") ?? 0,
      browser: callsBy.get("screenshot") ?? 0,
    },
    // The daily reader check (src/readerCheck.ts): each known business record and its latest try.
    // Its Fetch reads are in tinyfish_calls.fetch like every other.
    reader_checks: await readerChecksNow(db),
  };
}

export type Stats = Awaited<ReturnType<typeof readStats>>;

statsRouter.get("/api/stats", async (c) => c.json(await readStats(c.env.DB)));
