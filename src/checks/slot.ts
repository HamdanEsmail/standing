// The single in-flight Agent run slot: Standing keeps at most one TinyAgent run in flight, because
// one run at a time keeps spend and the load on the registers predictable.
// One D1 row holds the check that has the run and since when; a holder older than
// AGENT_SLOT_STALE_MINUTES no longer blocks, so a lost callback cannot hold the slot for good.
// This is the one module outside src/db that writes SQL.
import { AGENT_SLOT_STALE_MINUTES } from "../core/limits";
import type { AgentSlotRow } from "../db/types";

/** Takes the slot for `checkId` when it is free or its holder is stale. One conditional UPDATE, so of
 *  two racing takers exactly one wins. */
export async function takeSlot(db: D1Database, checkId: string, now: Date = new Date()): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - AGENT_SLOT_STALE_MINUTES * 60_000).toISOString();
  const result = await db
    .prepare(
      "UPDATE agent_slot SET holder_check_id = ?, since = ? WHERE id = 1 AND (holder_check_id IS NULL OR since < ?)",
    )
    .bind(checkId, now.toISOString(), staleBefore)
    .run();
  return result.meta.changes === 1;
}

/** Re-stamps the holder's `since` with now, once its run has started: the slot was taken before
 *  `startRun`'s 429 waits (up to 3 minutes), and the run itself can take AGENT_MAX_DURATION_SECONDS,
 *  so counting from the take could let another check take over while the run is live. Holder-guarded. */
export async function touchSlot(db: D1Database, checkId: string, now: Date = new Date()): Promise<boolean> {
  const result = await db
    .prepare("UPDATE agent_slot SET since = ? WHERE id = 1 AND holder_check_id = ?")
    .bind(now.toISOString(), checkId)
    .run();
  return result.meta.changes === 1;
}

/** Frees the slot, but only when `checkId` holds it: a check whose slot was taken over after it went
 *  stale must not free its successor's. */
export async function releaseSlot(db: D1Database, checkId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE agent_slot SET holder_check_id = NULL, since = NULL WHERE id = 1 AND holder_check_id = ?")
    .bind(checkId)
    .run();
  return result.meta.changes === 1;
}

/** The slot as stored. */
export function readSlot(db: D1Database): Promise<AgentSlotRow | null> {
  return db.prepare("SELECT id, holder_check_id, since FROM agent_slot WHERE id = 1").first<AgentSlotRow>();
}
