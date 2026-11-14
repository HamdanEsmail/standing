// GET /api/registries (spec section 6): the coverage table as data. Public, no token, no TinyFish call.
import { Hono } from "hono";
import type { Env } from "../env";
import { readerChecksNow } from "../readerCheck";
import { listAdapters, UNSUPPORTED } from "../registries/index";

export const registriesRouter = new Hono<{ Bindings: Env }>();

/**
 * Each supported registry with how it is looked up and watched (the adapter's `coverage`), and
 * `last_success_at`: the latest `checked_at` of a finished check that read the register and got an
 * answer (match, ambiguous or no_match; errors and unsupported do not count), or null; and
 * `reader_check`: the daily reader check's known record on that register with its latest try (null
 * fields until it is tried), or null for a register that is not in the check. Then the registries
 * checked and found unreadable, with the reason.
 */
export async function readCoverage(db: D1Database) {
  const readers = await readerChecksNow(db);
  const { results } = await db.prepare(
    `SELECT registry, MAX(checked_at) AS last_success_at FROM checks
     WHERE state = 'done' AND outcome IN ('match', 'ambiguous', 'no_match') AND checked_at IS NOT NULL
     GROUP BY registry`,
  ).all<{ registry: string; last_success_at: string }>();
  const last = new Map(results.map((r) => [r.registry, r.last_success_at]));
  return {
    registries: listAdapters().map((a) => ({
      id: a.id,
      name: a.name,
      country: a.country,
      record_types: a.recordTypes,
      lookup: a.coverage.lookup,
      watch: a.coverage.watch,
      supported: true,
      last_success_at: last.get(a.id) ?? null,
      reader_check: readers.find((r) => r.registry === a.id) ?? null,
      notes: a.coverage.notes,
    })),
    unsupported: UNSUPPORTED,
  };
}

export type Coverage = Awaited<ReturnType<typeof readCoverage>>;

registriesRouter.get("/api/registries", async (c) => c.json(await readCoverage(c.env.DB)));
