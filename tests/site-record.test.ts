// The record page: the current record, how it is watched, its history newest first with both read
// times, and the watch form with its honest refusals.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertEvent } from "../src/db/events";
import { insertWatch } from "../src/db/watches";
import { nextRun, staggeredCron } from "../src/monitoring/watch";
import { formatUtc } from "../src/site/format";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import { callWorker } from "./helpers/app";
import { callsTo, freshState, restoreState } from "./helpers/checks";
import { fetchMock } from "./helpers/fetch-mock";
import { seedCompany, textOf } from "./helpers/site";

beforeEach(freshState);
afterEach(restoreState);

const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";

async function page(path: string, status = 200): Promise<string> {
  const res = await callWorker(path);
  expect(res.status, path).toBe(status);
  return res.text();
}

function postWatch(recordId: string, ip = "203.0.113.20"): Promise<Response> {
  return callWorker(`/records/${recordId}/watch`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
    body: "",
    redirect: "manual",
  });
}

/** Four public watches on other records, the first expiring soonest. */
async function fillPublicSlots(): Promise<string> {
  const soonest = "2026-11-12T10:00:00.000Z";
  for (let i = 0; i < 4; i++) {
    const { recordId } = await seedCompany({ number: `9900010${i}`, watched: false });
    await insertWatch(env.DB, {
      record_id: recordId,
      kind: "page",
      monitor_id: `m-pub-${i}`,
      added_by: "public",
      ip_hash: `ip${i}`,
      expires_at: i === 0 ? soonest : "2026-11-14T10:00:00.000Z",
    });
  }
  return soonest;
}

describe("site record page", () => {
  it("shows the record card and how it is watched, with the next check time", async () => {
    const { recordId } = await seedCompany();
    const html = await page(`/records/${recordId}`);
    expect(html).toMatch(/class="status-word active"[^>]*>Active</);
    const { minute, hour } = staggeredCron(recordId);
    const next = nextRun(minute, hour).slice(11, 16);
    expect(textOf(html)).toContain(`Watching · Page monitor · next check ${next} UTC`);
    expect(textOf(html)).not.toContain("Watch this record");
  });

  it("lists the history newest first, a status change with both status words in their colours and both read times", async () => {
    const { recordId } = await seedCompany();
    const before = { status: "active", status_raw: "Active", flags: [], disciplinary: [] };
    const after = { status: "dissolved", status_raw: "Dissolved on 1 December 2026", flags: [], disciplinary: [] };
    await insertEvent(env.DB, { record_id: recordId, kind: "recheck", after: before, at: "2026-11-10T09:00:00.000Z" });
    await insertEvent(env.DB, { record_id: recordId, kind: "status_change", before, after, fields: ["status", "status_raw"], at: "2026-12-01T21:02:00.000Z" });
    const html = await page(`/records/${recordId}`);
    const rows = [...html.matchAll(/<li class="change[^"]*">([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
    expect(rows).toHaveLength(2);
    // Newest first: the status change, read on 1 Dec, before it the re-read of 10 Nov.
    expect(rows[0]).toMatch(/class="chip ok"[^>]*>Active</);
    expect(rows[0]).toMatch(/class="chip bad"[^>]*>Dissolved</);
    expect(textOf(rows[0]!)).toContain(formatUtc("2026-11-10T09:00:00.000Z"));
    expect(textOf(rows[0]!)).toContain(formatUtc("2026-12-01T21:02:00.000Z"));
    expect(textOf(rows[0]!)).toContain("Dissolved on 1 December 2026");
    expect(textOf(rows[1]!)).toContain("No change");
  });

  it("a public visitor's watch form: 303 back to the record, which then says until when it is watched", async () => {
    const { recordId } = await seedCompany({ watched: false });
    expect(textOf(await page(`/records/${recordId}`))).toContain("Watch this record");
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: monitorCreate } });
    const res = await postWatch(recordId);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/records/${recordId}`);
    expect(callsTo("POST", MONITORS_API)).toHaveLength(1);
    const expires = (await env.DB.prepare("SELECT expires_at FROM watches WHERE record_id = ?").bind(recordId).first<string>("expires_at"))!;
    const text = textOf(await page(`/records/${recordId}`));
    expect(text).toContain(`Watched until ${formatUtc(expires)}. Its history is kept after that.`);
    // Sending the form again changes nothing and creates no second Monitor.
    expect((await postWatch(recordId)).status).toBe(303);
    expect(callsTo("POST", MONITORS_API)).toHaveLength(1);
  });

  it("with every public slot taken the page says when the next one frees, and the form is refused without a Monitor", async () => {
    const soonest = await fillPublicSlots();
    const { recordId } = await seedCompany({ watched: false });
    const line = `All 4 public watch slots are in use. The next one frees on ${formatUtc(soonest)}.`;
    const html = await page(`/records/${recordId}`);
    expect(textOf(html)).toContain(line);
    expect(textOf(html)).not.toContain("Watch this record");
    const res = await postWatch(recordId);
    expect(res.status).toBe(409);
    expect(textOf(await res.text())).toContain(line);
    expect(callsTo("POST", MONITORS_API)).toHaveLength(0);
  });

  it("an unknown record is the 404 page", async () => {
    await page("/records/00000000-0000-4000-8000-000000000000", 404);
  });
});
