// Per-visitor daily counters behind the public rate limits (spec section 4.4). One row per
// (ip_hash, UTC day). The handlers decide the limits; this file only counts.

export type UseField = "checks" | "watches" | "discovers";

export interface UseCounts {
  checks: number;
  watches: number;
  discovers: number;
}

// One fixed statement per counter, so the field name never reaches the SQL text as a value.
const BUMP: Record<UseField, string> = {
  checks: `INSERT INTO public_use (ip_hash, day, checks) VALUES (?1, ?2, 1)
           ON CONFLICT (ip_hash, day) DO UPDATE SET checks = checks + 1
           RETURNING checks, watches, discovers`,
  watches: `INSERT INTO public_use (ip_hash, day, watches) VALUES (?1, ?2, 1)
            ON CONFLICT (ip_hash, day) DO UPDATE SET watches = watches + 1
            RETURNING checks, watches, discovers`,
  discovers: `INSERT INTO public_use (ip_hash, day, discovers) VALUES (?1, ?2, 1)
              ON CONFLICT (ip_hash, day) DO UPDATE SET discovers = discovers + 1
              RETURNING checks, watches, discovers`,
};

/** The current UTC day as YYYY-MM-DD. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Counts one use for this visitor today and returns today's counts including it. Throws on a field that is not a counter. */
export async function bump(db: D1Database, ipHash: string, field: UseField): Promise<UseCounts> {
  if (!Object.hasOwn(BUMP, field)) throw new Error(`public_use has no counter "${String(field)}"`);
  const row = await db.prepare(BUMP[field]).bind(ipHash, utcDay()).first<UseCounts>();
  if (!row) throw new Error("public_use bump returned no row");
  return row;
}

// The same, one back: for a use that was counted and then refused before it was served.
const UNBUMP: Record<UseField, string> = {
  checks: "UPDATE public_use SET checks = checks - 1 WHERE ip_hash = ?1 AND day = ?2 AND checks > 0",
  watches: "UPDATE public_use SET watches = watches - 1 WHERE ip_hash = ?1 AND day = ?2 AND watches > 0",
  discovers: "UPDATE public_use SET discovers = discovers - 1 WHERE ip_hash = ?1 AND day = ?2 AND discovers > 0",
};

/** Gives back one use counted for this visitor today (never below zero). */
export async function unbump(db: D1Database, ipHash: string, field: UseField): Promise<void> {
  if (!Object.hasOwn(UNBUMP, field)) throw new Error(`public_use has no counter "${String(field)}"`);
  await db.prepare(UNBUMP[field]).bind(ipHash, utcDay()).run();
}

/** What this visitor has used today; zeros when they have not used anything. */
export async function today(db: D1Database, ipHash: string): Promise<UseCounts> {
  const row = await db
    .prepare("SELECT checks, watches, discovers FROM public_use WHERE ip_hash = ? AND day = ?")
    .bind(ipHash, utcDay())
    .first<UseCounts>();
  return row ?? { checks: 0, watches: 0, discovers: 0 };
}
