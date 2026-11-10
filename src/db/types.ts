// Row types for the D1 tables, column for column as in migrations/0001_init.sql: the raw shapes
// a SELECT returns. JSON columns are the stored text (`string`), nullable columns are `| null`,
// INTEGER and REAL are `number`. Columns that a CHECK constraint fixes carry that union.
// The Worker is the only writer, so `registry`-style text columns it fills from its own enums
// (`record_type`, `jurisdiction`) carry the union too. tests/db-types.test.ts fails if a type and
// its table drift apart. Types only: the queries live in the files that use them.
import type { SpendKind } from "../core/spend";
import type { Flag, Outcome, Status } from "../core/status";
import type { Jurisdiction, ParsedRecord, RecordType } from "../registries/types";

/** One lookup. `state` is the lifecycle; `status` is the normalized record status the check
 *  found and is null unless `outcome` is 'match'. */
export interface CheckRow {
  id: string;
  state: "pending" | "done";
  registry: string | null;
  record_type: RecordType | null;
  jurisdiction: Jurisdiction | null;
  profession: string | null;
  query_raw: string | null;
  query_normalized: string | null;
  number: string | null;
  cache_key: string | null;
  /** JSON `string[]`. */
  variants_tried: string;
  outcome: Outcome | null;
  status: Status | null;
  /** JSON `Flag[]`. */
  flags: string;
  record_id: string | null;
  run_id: string | null;
  method: "agent" | "fetch" | null;
  cached_from_check_id: string | null;
  evidence_key: string | null;
  spend_usd: number | null;
  callback_url: string | null;
  candidates_total: number | null;
  /** JSON `string[]`. */
  suggestions: string;
  trigger: "request" | "monitor";
  monitor_run_id: string | null;
  ip_hash: string | null;
  added_by: "public" | "admin" | "curated" | null;
  expires_at: string | null;
  started_at: string | null;
  checked_at: string | null;
  error: string | null;
}

export interface RecordRow {
  id: string;
  registry: string | null;
  record_type: RecordType | null;
  licence_number: string | null;
  full_name: string | null;
  status: Status | null;
  status_raw: string | null;
  /** JSON `Flag[]`. */
  flags: string;
  /** JSON `DisciplinaryAction[]`. */
  disciplinary: string;
  /** JSON `RecordFields`; no SQL default, so null on a bare row. */
  fields: string | null;
  source_url: string | null;
  evidence_key: string | null;
  /** 0 or 1. */
  watched: number;
  first_seen_at: string | null;
  last_checked_at: string | null;
  normalized_hash: string | null;
}

/** A row the registry search returned for an ambiguous check. */
export interface CandidateRow {
  check_id: string;
  position: number;
  licence_number: string | null;
  full_name: string | null;
  status_raw: string | null;
  detail: string | null;
  source_url: string | null;
}

export interface WatchRow {
  id: string;
  record_id: string | null;
  kind: "page" | "topic" | null;
  monitor_id: string | null;
  added_by: "curated" | "public" | "admin" | null;
  callback_url: string | null;
  expires_at: string | null;
  created_at: string | null;
  status: string | null;
  ip_hash: string | null;
}

export interface EventRow {
  id: string;
  record_id: string | null;
  kind: "status_change" | "notice" | "recheck" | null;
  /** JSON `string[]`: the names of the fields that changed. */
  fields: string;
  before: string | null;
  after: string | null;
  source_url: string | null;
  monitor_run_id: string | null;
  notified_at: string | null;
  at: string | null;
}

/** A regulator decision-page monitor shared by every watch (NMC, SRA). */
export interface SharedMonitorRow {
  registry: string;
  monitor_id: string | null;
  url: string | null;
  created_at: string | null;
}

export interface SpendRow {
  id: string;
  kind: SpendKind | null;
  amount_usd: number | null;
  ref: string | null;
  at: string | null;
}

/** Per-visitor daily counters for the public rate limits. */
export interface PublicUseRow {
  ip_hash: string;
  day: string;
  checks: number;
  watches: number;
  discovers: number;
}

/** The single in-flight Agent run slot (always one row, id 1). Read and written only by
 *  src/checks/slot.ts. */
export interface AgentSlotRow {
  id: 1;
  holder_check_id: string | null;
  since: string | null;
}

// The JSON the code stores in the text columns above.

/** What `records.fields` holds. */
export interface RecordFields {
  registered_since: string | null;
  expiry_date: string | null;
  specialties: string[];
  restrictions: string[];
  raw: Record<string, unknown>;
}

/** A record after an adapter's `statusFromRecord` has run: what the page showed (`ParsedRecord`) plus
 *  the status and flags it maps to and the disciplinary entries derived from its conditions blocks.
 *  What `upsertRecord` stores and `recordDiff` compares. */
export type NormalizedRecord = ParsedRecord & {
  status: Status;
  flags: Flag[];
  disciplinary: DisciplinaryAction[];
};

/** One entry of `records.disciplinary`. */
export interface DisciplinaryAction {
  date: string | null;
  summary: string;
  source_url: string | null;
}
