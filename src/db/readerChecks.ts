// The daily reader check's own table (migrations/0002_reader_checks.sql). Nothing else reads it.

export type ReaderOutcome = "started" | "understood" | "no_answer" | "not_understood";

export interface ReaderCheckRow {
  registry: string;
  /** The UTC day, YYYY-MM-DD. */
  day: string;
  started_at: string;
  finished_at: string | null;
  outcome: ReaderOutcome;
  detail: string | null;
  source_url: string | null;
}

/** The registers already tried on this UTC day, finished or not. */
export async function triedOn(db: D1Database, day: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT registry FROM reader_checks WHERE day = ?").bind(day).all<{ registry: string }>();
  return new Set(results.map((r) => r.registry));
}

/** Takes the day's one try for a register, before its page is read. False when a run took it first. */
export async function claimReaderCheck(db: D1Database, registry: string, day: string, at: string): Promise<boolean> {
  const done = await db
    .prepare("INSERT INTO reader_checks (registry, day, started_at) VALUES (?, ?, ?) ON CONFLICT (registry, day) DO NOTHING")
    .bind(registry, day, at)
    .run();
  return done.meta.changes === 1;
}

/** Writes how the day's try ended. Only a try still marked started is changed. */
export async function finishReaderCheck(
  db: D1Database,
  registry: string,
  day: string,
  end: { outcome: Exclude<ReaderOutcome, "started">; detail: string | null; source_url: string | null; finished_at: string },
): Promise<ReaderCheckRow | null> {
  return db
    .prepare(
      "UPDATE reader_checks SET finished_at = ?3, outcome = ?4, detail = ?5, source_url = ?6 WHERE registry = ?1 AND day = ?2 AND outcome = 'started' RETURNING *",
    )
    .bind(registry, day, end.finished_at, end.outcome, end.detail, end.source_url)
    .first<ReaderCheckRow>();
}

/** The latest try of each register, the earliest started first. */
export async function latestReaderChecks(db: D1Database): Promise<ReaderCheckRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.* FROM reader_checks r
       JOIN (SELECT registry, MAX(day) AS day FROM reader_checks GROUP BY registry) latest ON latest.registry = r.registry AND latest.day = r.day
       ORDER BY r.started_at`,
    )
    .all<ReaderCheckRow>();
  return results;
}
