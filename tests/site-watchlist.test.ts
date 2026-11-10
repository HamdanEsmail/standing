// The watchlist: one row per watched record, curated first, and the public slots line.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertCheck } from "../src/db/checks";
import { insertEvent } from "../src/db/events";
import { upsertRecord } from "../src/db/records";
import { insertWatch } from "../src/db/watches";
import { formatUtc } from "../src/site/format";
import { callWorker } from "./helpers/app";
import { freshState, restoreState } from "./helpers/checks";
import { seedCompany, textOf } from "./helpers/site";

beforeEach(freshState);
afterEach(restoreState);

async function watchlist(): Promise<string> {
  const res = await callWorker("/watchlist");
  expect(res.status).toBe(200);
  return res.text();
}

describe("site watchlist", () => {
  it("lists watched records, curated first, with status, registry, last check, last event and expiry, and the slots line", async () => {
    const pub = await seedCompany({ number: "99000200", name: "BO IMAGINARY LIMITED", watched: false });
    await insertWatch(env.DB, { record_id: pub.recordId, kind: "page", monitor_id: "m-pub", added_by: "public", ip_hash: "ip1", expires_at: "2026-11-16T10:00:00.000Z" });
    await env.DB.prepare("UPDATE records SET watched = 1 WHERE id = ?").bind(pub.recordId).run();
    const cur = await seedCompany({ number: "99000100", name: "ADA FICTITIOUS TRADING LIMITED" });
    await insertEvent(env.DB, { record_id: cur.recordId, kind: "recheck", at: "2026-11-10T09:00:00.000Z" });

    const html = await watchlist();
    const rows = [...html.matchAll(/<li class="watched">([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]!));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("ADA FICTITIOUS TRADING LIMITED");
    expect(rows[0]).toContain("Curated");
    expect(rows[0]).toContain("Companies House");
    expect(rows[0]).toContain(formatUtc("2026-11-10T09:00:00.000Z"));
    expect(rows[1]).toContain("BO IMAGINARY LIMITED");
    expect(rows[1]).toContain(formatUtc("2026-11-16T10:00:00.000Z"));
    // The status is the slab's large word, on its colour.
    expect(html).toMatch(/class="record tone-go listed"[^>]*>[\s\S]*?class="status-word active"[^>]*>Active</);
    // A company watched because of a strike-off proposal shows it beside the status.
    expect(rows[0]).toContain("Proposal to strike off");
    expect(textOf(html)).toContain("1 of 4 public watch slots are in use");
    expect(html).toContain(`href="/records/${cur.recordId}"`);
  });

  it("a person is never named on the watchlist or the home: record type and number instead; the name stays on the record's own page", async () => {
    const recordId = await upsertRecord(env.DB, {
      registry: "nmc",
      record_type: "nurse",
      record: { full_name: "Ada Fictitious", licence_number: "99A9999O", status_raw: "Registered", status: "active", flags: [], disciplinary: [] },
      source_url: null,
      evidence_key: "evidence/0b0c0d0e-1111-4222-8333-444455556677.jpg",
    });
    await insertCheck(env.DB, { state: "done", registry: "nmc", record_type: "nurse", jurisdiction: "GB", number: "99A9999O", outcome: "match", status: "active", record_id: recordId, method: "agent", added_by: "curated", checked_at: "2026-11-09T07:40:16.000Z" });
    await insertWatch(env.DB, { record_id: recordId, kind: "topic", monitor_id: "m-topic", added_by: "curated" });
    await env.DB.prepare("UPDATE records SET watched = 1 WHERE id = ?").bind(recordId).run();

    for (const path of ["/watchlist", "/"]) {
      const res = await callWorker(path);
      const html = await res.text();
      expect(html, path).not.toMatch(/Ada|Fictitious/i);
      expect(textOf(html), path).toContain("Nurse · NMC 99A9999O");
    }
    const own = await callWorker(`/records/${recordId}`);
    const ownHtml = await own.text();
    expect(textOf(ownHtml)).toContain("Ada Fictitious");
    expect(ownHtml).toContain('<meta name="robots" content="noindex"/>');
    expect(ownHtml).not.toMatch(/<title>[^<]*Ada/);
  });

  it("with nothing watched it says so", async () => {
    const text = textOf(await watchlist());
    expect(text).toContain("0 of 4 public watch slots are in use");
    expect(text).toContain("No record is watched yet.");
  });
});
