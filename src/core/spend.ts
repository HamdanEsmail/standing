// The spend ledger. Every TinyFish call appends one row; the totals feed the
// spend pause (SPEND_PAUSE_USD) and the public /api/stats.

export type SpendKind = "agent_step" | "monitor_check" | "screenshot" | "fetch" | "search";

/** US dollars per unit of each kind. */
export const PRICES: Record<SpendKind, number> = {
  agent_step: 0.016,
  monitor_check: 0.005,
  screenshot: 0.002,
  fetch: 0,
  search: 0,
};

/** Appends one row to the ledger. `ref` says what the money was spent on (a check id, a run id, a watch id). */
export async function recordSpend(
  db: D1Database,
  kind: SpendKind,
  amountUsd: number,
  ref: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), kind, amountUsd, ref, new Date().toISOString())
    .run();
}

/** Total US dollars spent so far, across every kind. */
export async function totalSpend(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend").first<{ total: number }>();
  return row?.total ?? 0;
}

/** US dollars spent per kind. Every kind is present, zero when nothing was spent on it. */
export async function spendByKind(db: D1Database): Promise<Record<SpendKind, number>> {
  const totals = Object.fromEntries(Object.keys(PRICES).map((kind) => [kind, 0])) as Record<SpendKind, number>;
  const { results } = await db
    .prepare("SELECT kind, COALESCE(SUM(amount_usd), 0) AS total FROM spend GROUP BY kind")
    .all<{ kind: string; total: number }>();
  for (const row of results) {
    if (row.kind in totals) totals[row.kind as SpendKind] = row.total;
  }
  return totals;
}
