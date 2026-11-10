import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  AgentSlotRow,
  CandidateRow,
  CheckRow,
  EventRow,
  PublicUseRow,
  RecordRow,
  SharedMonitorRow,
  SpendRow,
  WatchRow,
} from "../src/db/types";

// Each literal below must satisfy its row type (tsc fails on a missing or extra key), and its
// keys must equal the table's columns in migrations/0001_init.sql (this test fails otherwise),
// so the types cannot drift from the schema in either direction.
const ROWS = {
  checks: {
    id: "", state: "pending", registry: null, record_type: null, jurisdiction: null, profession: null, query_raw: null,
    query_normalized: null, number: null, cache_key: null, variants_tried: "[]", outcome: null, status: null,
    flags: "[]", record_id: null, run_id: null, method: null, cached_from_check_id: null, evidence_key: null,
    spend_usd: null, callback_url: null, candidates_total: null, suggestions: "[]", trigger: "request",
    monitor_run_id: null, ip_hash: null, added_by: null, expires_at: null, started_at: null, checked_at: null,
    error: null,
  } satisfies CheckRow,
  records: {
    id: "", registry: null, record_type: null, licence_number: null, full_name: null, status: null, status_raw: null,
    flags: "[]", disciplinary: "[]", fields: null, source_url: null, evidence_key: null, watched: 0,
    first_seen_at: null, last_checked_at: null, normalized_hash: null,
  } satisfies RecordRow,
  candidates: {
    check_id: "", position: 0, licence_number: null, full_name: null, status_raw: null, detail: null, source_url: null,
  } satisfies CandidateRow,
  watches: {
    id: "", record_id: null, kind: null, monitor_id: null, added_by: null, callback_url: null, expires_at: null,
    created_at: null, status: null, ip_hash: null,
  } satisfies WatchRow,
  events: {
    id: "", record_id: null, kind: null, fields: "[]", before: null, after: null, source_url: null,
    monitor_run_id: null, notified_at: null, at: null,
  } satisfies EventRow,
  monitors_shared: { registry: "", monitor_id: null, url: null, created_at: null } satisfies SharedMonitorRow,
  spend: { id: "", kind: null, amount_usd: null, ref: null, at: null } satisfies SpendRow,
  public_use: { ip_hash: "", day: "", checks: 0, watches: 0, discovers: 0 } satisfies PublicUseRow,
  agent_slot: { id: 1, holder_check_id: null, since: null } satisfies AgentSlotRow,
};

describe("row types", () => {
  it.each(Object.entries(ROWS))("%s mirrors the table column for column", async (table, row) => {
    const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
    expect(Object.keys(row).sort()).toEqual(results.map((c) => c.name).sort());
  });
});
