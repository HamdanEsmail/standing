import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const run = (sql: string) => env.DB.prepare(sql).run();

async function names(type: "table" | "index"): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
  )
    .bind(type)
    .all<{ name: string }>();
  return results.map((r) => r.name).sort();
}

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("schema", () => {
  it("creates the ten tables and the five indexes", async () => {
    expect(await names("table")).toEqual(
      ["agent_slot", "candidates", "checks", "events", "monitors_shared", "public_use", "reader_checks", "records", "spend", "watches"],
    );
    expect(await names("index")).toEqual([
      "idx_checks_cache_key_checked",
      "idx_checks_record",
      "idx_events_record_at",
      "idx_records_registry_licence",
      "idx_watches_monitor",
    ]);
  });

  it("checks has the spec columns plus the lifecycle, cache and monitor columns", async () => {
    expect(await columns("checks")).toEqual(
      expect.arrayContaining([
        "id", "registry", "record_type", "jurisdiction", "query_raw", "query_normalized", "number", "variants_tried",
        "outcome", "status", "record_id", "run_id", "method", "cached_from_check_id", "evidence_key", "spend_usd",
        "started_at", "checked_at", "error", "ip_hash", "added_by", "expires_at", "state", "cache_key", "profession",
        "flags", "callback_url", "candidates_total", "suggestions", "trigger", "monitor_run_id",
      ]),
    );
    expect(await columns("records")).toEqual(
      expect.arrayContaining(["record_type", "flags", "disciplinary", "watched", "fields", "normalized_hash"]),
    );
    expect(await columns("events")).toEqual(expect.arrayContaining(["fields", "notified_at", "before", "after"]));
    expect(await columns("watches")).toEqual(expect.arrayContaining(["callback_url", "monitor_id", "expires_at"]));
  });

  it("applies the defaults later tasks rely on", async () => {
    await run("INSERT INTO checks (id) VALUES ('defaults-c')");
    await run("INSERT INTO records (id) VALUES ('defaults-r')");
    await run("INSERT INTO events (id) VALUES ('defaults-e')");
    await run("INSERT INTO public_use (ip_hash, day) VALUES ('defaults-h', '2026-11-03')");

    expect(
      await env.DB.prepare("SELECT variants_tried, flags, suggestions, trigger FROM checks WHERE id = 'defaults-c'").first(),
    ).toEqual({ variants_tried: "[]", flags: "[]", suggestions: "[]", trigger: "request" });
    // A bare insert is pending: a NULL state would fall out of every lifecycle query.
    expect(await env.DB.prepare("SELECT state FROM checks WHERE id = 'defaults-c'").first()).toEqual({ state: "pending" });
    expect(await env.DB.prepare("SELECT flags, disciplinary, watched FROM records WHERE id = 'defaults-r'").first()).toEqual({
      flags: "[]",
      disciplinary: "[]",
      watched: 0,
    });
    expect(await env.DB.prepare("SELECT fields FROM events WHERE id = 'defaults-e'").first()).toEqual({ fields: "[]" });
    expect(
      await env.DB.prepare("SELECT checks, watches, discovers FROM public_use WHERE ip_hash = 'defaults-h'").first(),
    ).toEqual({ checks: 0, watches: 0, discovers: 0 });
  });

  it("accepts the fixed enum values, and null outcome and status while a check is pending", async () => {
    await run("INSERT INTO checks (id, state, outcome, status, method, added_by) VALUES ('ok1', 'pending', NULL, NULL, NULL, 'public')");
    await run("INSERT INTO checks (id, state, outcome, status, method, trigger) VALUES ('ok2', 'done', 'match', 'insolvency', 'fetch', 'monitor')");
    await run("INSERT INTO checks (id, outcome, added_by) VALUES ('ok2b', 'unsupported', 'curated')");
    await run("INSERT INTO records (id, status) VALUES ('ok3', 'not_licensed')");
    await run("INSERT INTO watches (id, kind, added_by) VALUES ('ok4', 'topic', 'curated')");
    await run("INSERT INTO events (id, kind) VALUES ('ok5', 'recheck')");
  });

  it("rejects values outside the fixed enums", async () => {
    await expect(run("INSERT INTO checks (id, outcome) VALUES ('bad1', 'maybe')")).rejects.toThrow();
    await expect(run("INSERT INTO checks (id, status) VALUES ('bad2', 'revoked')")).rejects.toThrow();
    await expect(run("INSERT INTO checks (id, state) VALUES ('bad3', 'running')")).rejects.toThrow();
    await expect(run("INSERT INTO checks (id, state) VALUES ('bad3b', NULL)")).rejects.toThrow();
    await expect(run("INSERT INTO checks (id, method) VALUES ('bad4', 'browser')")).rejects.toThrow();
    await expect(run("INSERT INTO checks (id, added_by) VALUES ('bad5', 'anyone')")).rejects.toThrow();
    await expect(run("INSERT INTO checks (id, trigger) VALUES ('bad6', 'cron')")).rejects.toThrow();
    await expect(run("INSERT INTO records (id, status) VALUES ('bad7', 'paused')")).rejects.toThrow();
    await expect(run("INSERT INTO watches (id, kind) VALUES ('bad8', 'feed')")).rejects.toThrow();
    await expect(run("INSERT INTO watches (id, added_by) VALUES ('bad9', 'robot')")).rejects.toThrow();
    await expect(run("INSERT INTO events (id, kind) VALUES ('bad10', 'alert')")).rejects.toThrow();
  });

  it("keeps (registry, licence_number) unique on records, while records with no number never collide", async () => {
    await run("INSERT INTO records (id, registry, licence_number) VALUES ('u1', 'gmc', '9360749')");
    await run("INSERT INTO records (id, registry, licence_number) VALUES ('u2', 'gmc', '1111111')");
    await run("INSERT INTO records (id, registry, licence_number) VALUES ('u3', 'companies-house', '9360749')");
    await expect(run("INSERT INTO records (id, registry, licence_number) VALUES ('u4', 'gmc', '9360749')")).rejects.toThrow();
    await run("INSERT INTO records (id, registry, licence_number) VALUES ('n1', 'nmc', NULL)");
    await run("INSERT INTO records (id, registry, licence_number) VALUES ('n2', 'nmc', NULL)");
  });

  it("keys candidates by (check_id, position) and monitors_shared by registry", async () => {
    await run("INSERT INTO candidates (check_id, position) VALUES ('c', 0)");
    await run("INSERT INTO candidates (check_id, position) VALUES ('c', 1)");
    await run("INSERT INTO candidates (check_id, position) VALUES ('other', 1)");
    await expect(run("INSERT INTO candidates (check_id, position) VALUES ('c', 1)")).rejects.toThrow();
    await run("INSERT INTO monitors_shared (registry) VALUES ('nmc')");
    await expect(run("INSERT INTO monitors_shared (registry) VALUES ('nmc')")).rejects.toThrow();
  });
});
