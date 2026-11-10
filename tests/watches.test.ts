// Watches with Page and Topic monitors, the Monitor webhook, and what the read API may show.
// Each test guards a real failure.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePage } from "../src/checks/record";
import { insertEvent } from "../src/db/events";
import { getRecord, upsertRecord } from "../src/db/records";
import { insertWatch, putSharedMonitor } from "../src/db/watches";
import { PAGE_PURPOSE, TOPIC_PURPOSE } from "../src/monitoring/watch";
import { gmc } from "../src/registries/gmc";
import { nmc } from "../src/registries/nmc";
import gmcClean from "./fixtures/registries/gmc-record-clean.md?raw";
import gmcConditions from "./fixtures/registries/gmc-record-conditions.md?raw";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import topicCreate from "./fixtures/tinyfish/monitor-topic-create.json";
import pageChanged from "./fixtures/webhooks/page-changed.json";
import sharedChanged from "./fixtures/webhooks/shared-changed.json";
import topicNewResult from "./fixtures/webhooks/topic-new-result.json";
import { callWorker } from "./helpers/app";
import { callsTo, freshState, mockFetchPages, mockStartRun, pageResponse, restoreState, RUN_ASYNC_API } from "./helpers/checks";
import { fetchMock } from "./helpers/fetch-mock";

beforeEach(freshState);
afterEach(restoreState);

const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const CALLBACK = "https://hooks.example.org/standing";

/** A record stored from a real GMC page, optionally under another number and page URL. */
async function gmcRecord(markdown: string, over: { number?: string; url?: string; watched?: boolean } = {}): Promise<string> {
  const parsed = gmc.parseRecordPage(markdown)!;
  const url = over.url ?? `https://www.gmc-uk.org/registrants/${over.number ?? parsed.licence_number}`;
  const { record, restrictions } = normalizePage(gmc, { ...parsed, licence_number: over.number ?? parsed.licence_number }, url, "2026-11-09");
  const id = await upsertRecord(env.DB, { registry: "gmc", record_type: "doctor", record, source_url: url, restrictions });
  if (over.watched) await env.DB.prepare("UPDATE records SET watched = 1 WHERE id = ?").bind(id).run();
  return id;
}

async function nmcRecord(name: string, pin: string, watched = true): Promise<string> {
  const id = await upsertRecord(env.DB, {
    registry: "nmc",
    record_type: "nurse",
    record: { full_name: name, licence_number: pin, status_raw: "Registered", status: "active", flags: [], disciplinary: [], raw_fields: {} },
    source_url: null,
  });
  if (watched) await env.DB.prepare("UPDATE records SET watched = 1 WHERE id = ?").bind(id).run();
  return id;
}

function watch(recordId: string, opts: { admin?: boolean; ip?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "CF-Connecting-IP": opts.ip ?? "198.51.100.7" };
  if (opts.admin) headers.Authorization = "Bearer test-admin";
  return callWorker(`/api/records/${recordId}/watch`, { method: "POST", headers, body: JSON.stringify(opts.body ?? {}) });
}

function monitorHook(payload: unknown): Promise<Response> {
  return callWorker("/hooks/monitor/test-secret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

async function events(recordId: string): Promise<{ kind: string; fields: string; after: string | null; before: string | null }[]> {
  const { results } = await env.DB.prepare("SELECT kind, fields, after, before FROM events WHERE record_id = ? ORDER BY at, rowid")
    .bind(recordId)
    .all<{ kind: string; fields: string; after: string | null; before: string | null }>();
  return results;
}

describe("watches", () => {
  it("watching a GMC record creates a Page monitor on its record url with the purpose and a 12h cron", async () => {
    const id = await gmcRecord(gmcClean);
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: monitorCreate } });
    const res = await watch(id, { admin: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { watch_id: string; kind: string; next_check: string };
    expect(body).toMatchObject({ kind: "page", watch_id: expect.any(String) });
    expect(Date.parse(body.next_check)).toBeGreaterThan(Date.now());

    const sent = callsTo("POST", MONITORS_API)[0]!.body as Record<string, any>;
    expect(sent).toMatchObject({ type: "fetch", config: { url: "https://www.gmc-uk.org/registrants/9360749", format: "markdown" }, purpose: PAGE_PURPOSE });
    expect(sent.webhook_url).toBe("https://standing.test/hooks/monitor/test-secret");
    const cron = /^(\d{1,2}) (\d{1,2}),(\d{1,2}) \* \* \*$/.exec(sent.schedule_cron)!;
    expect(Number(cron[3]) - Number(cron[2])).toBe(12);
    expect(sent.name).not.toMatch(/wickfold|christopher/i);
    expect((await getRecord(env.DB, id))?.watched).toBe(1);
  });

  it("watching an NMC record creates a Topic monitor with the adapter query", async () => {
    const id = await nmcRecord("Ada Fictitious", "99Z9999Z", false);
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: topicCreate } });
    const res = await watch(id, { admin: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ kind: "topic" });
    const sent = callsTo("POST", MONITORS_API)[0]!.body as Record<string, any>;
    expect(sent).toMatchObject({
      type: "search",
      config: { query: nmc.topicQuery("Ada Fictitious"), recency_minutes: 1440, result_limit: 5 },
      purpose: TOPIC_PURPOSE,
    });
  });

  it("fifth public watch is 409 public_slots_full; ninth watch overall is 409 watchlist_full (10 minus 2 shared)", async () => {
    // Four public watches already hold the public slots (from four visitors).
    for (let i = 0; i < 4; i++) {
      const r = await nmcRecord(`Person${i} Filler`, `99A000${i}A`);
      await insertWatch(env.DB, { record_id: r, kind: "topic", monitor_id: `m-pub-${i}`, added_by: "public", ip_hash: `ip${i}` });
    }
    const target = await nmcRecord("Ada Fictitious", "99Z9999Z", false);
    const fifth = await watch(target, { ip: "203.0.113.50" });
    expect(fifth.status).toBe(409);
    expect(await fifth.json()).toEqual({ error: "public_slots_full" });

    // Four admin and curated watches fill the account's eight watch slots.
    for (let i = 0; i < 4; i++) {
      const r = await nmcRecord(`Admin${i} Filler`, `99B000${i}B`);
      await insertWatch(env.DB, { record_id: r, kind: "topic", monitor_id: `m-adm-${i}`, added_by: i < 2 ? "curated" : "admin" });
    }
    const ninth = await watch(target, { admin: true });
    expect(ninth.status).toBe(409);
    expect(await ninth.json()).toEqual({ error: "watchlist_full" });
    // Refused before any Monitor was created.
    expect(callsTo("POST", MONITORS_API)).toHaveLength(0);
  });
});

describe("the Monitor webhook", () => {
  it("a wrong secret is 404 with no body and writes nothing", async () => {
    const id = await gmcRecord(gmcClean, { watched: true });
    await insertWatch(env.DB, { record_id: id, kind: "page", monitor_id: pageChanged.fetch_monitor_id, added_by: "admin" });
    const res = await callWorker("/hooks/monitor/not-the-secret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pageChanged) });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(await events(id)).toEqual([]);
    expect(await env.STORE.head(`raw/monitor/${pageChanged.id}.json`)).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM spend").first()).toEqual({ n: 0 });
  });

  it("page changed webhook whose re-read adds a conditions block creates a status_change event with before/after and calls callback_url", async () => {
    // The stored record is the clean page, filed under the number whose live page now shows conditions.
    const url = "https://www.gmc-uk.org/registrants/9662428";
    const id = await gmcRecord(gmcClean, { number: "9662428", url, watched: true });
    await insertWatch(env.DB, { record_id: id, kind: "page", monitor_id: pageChanged.fetch_monitor_id, added_by: "admin", callback_url: CALLBACK });
    mockFetchPages({ [url]: pageResponse(url, gmcConditions) });
    fetchMock.intercept({ method: "POST", url: CALLBACK, reply: { status: 204 } });

    const res = await monitorHook(pageChanged);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, event: "status_change" });
    const [event, ...rest] = await events(id);
    expect(rest).toHaveLength(0);
    expect(event!.kind).toBe("status_change");
    expect(JSON.parse(event!.fields)).toContain("status");
    expect(JSON.parse(event!.before!)).toMatchObject({ status: "active" });
    expect(JSON.parse(event!.after!)).toMatchObject({ status: "conditions" });
    expect((await getRecord(env.DB, id))?.status).toBe("conditions");

    const told = callsTo("POST", CALLBACK);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toMatchObject({ event: { kind: "status_change" }, record: { status: "conditions", licence_number: "9662428" } });
    const notified = await env.DB.prepare("SELECT notified_at FROM events WHERE record_id = ?").bind(id).first<{ notified_at: string | null }>();
    expect(notified?.notified_at).not.toBeNull();
    // A second delivery of the same run changes nothing.
    expect(await (await monitorHook(pageChanged)).json()).toEqual({ ok: true, duplicate: true });
    expect(await events(id)).toHaveLength(1);
  });

  it("page changed webhook whose re-read is identical creates a recheck event, not a status_change", async () => {
    const url = "https://www.gmc-uk.org/registrants/9360749";
    const id = await gmcRecord(gmcClean, { watched: true });
    await insertWatch(env.DB, { record_id: id, kind: "page", monitor_id: pageChanged.fetch_monitor_id, added_by: "admin" });
    mockFetchPages({ [url]: pageResponse(url, gmcClean) });

    const res = await monitorHook(pageChanged);
    expect(await res.json()).toMatchObject({ ok: true, event: "recheck" });
    expect((await events(id)).map((e) => e.kind)).toEqual(["recheck"]);
    expect((await getRecord(env.DB, id))?.status).toBe("active");
  });

  it("topic webhook with a new result creates a notice event and starts one Agent re-check", async () => {
    const id = await nmcRecord("Ada Fictitious", "99Z9999Z");
    await insertWatch(env.DB, { record_id: id, kind: "topic", monitor_id: topicNewResult.search_monitor_id, added_by: "admin" });
    mockStartRun("run-recheck-1");

    const res = await monitorHook(topicNewResult);
    expect(await res.json()).toMatchObject({ ok: true, notices: 1, recheck: expect.any(String) });
    const ev = await events(id);
    expect(ev.map((e) => e.kind)).toEqual(["notice"]);
    expect(JSON.parse(ev[0]!.after!)).toEqual({ url: "https://news.example.org/nmc-hearing-ada-fictitious", title: "Nurse Ada Fictitious faces NMC hearing" });

    const runs = callsTo("POST", RUN_ASYNC_API);
    expect(runs).toHaveLength(1);
    expect((runs[0]!.body as { goal: string }).goal).toBe(nmc.goal({ variants: [], number: "99Z9999Z" }));
    const recheck = await env.DB.prepare("SELECT trigger, record_id, monitor_run_id, run_id FROM checks").first();
    expect(recheck).toEqual({ trigger: "monitor", record_id: id, monitor_run_id: topicNewResult.id, run_id: "run-recheck-1" });
  });

  it("a new result is found by its own position, and the last result of a list can be the new one", async () => {
    const id = await nmcRecord("Ada Fictitious", "99Z9999Z");
    await insertWatch(env.DB, { record_id: id, kind: "topic", monitor_id: topicNewResult.search_monitor_id, added_by: "admin" });
    mockStartRun("run-recheck-2");
    // Three results; the first and the last are new. Read as places in the list from 0, position 1 would
    // name the second result and position 3 would name nothing.
    const results = [
      { position: 1, title: "New at the top", url: "https://news.example.org/top" },
      { position: 2, title: "Seen before", url: "https://news.example.org/seen" },
      { position: 3, title: "New at the end", url: "https://news.example.org/end" },
    ];
    const res = await monitorHook({ ...topicNewResult, id: "9e8d7c6b-0000-4000-8000-positions0001", request_id: undefined, result_count: 3, results, new_result_positions: [1, 3] });
    expect(await res.json()).toMatchObject({ ok: true, notices: 2 });
    expect((await events(id)).map((e) => JSON.parse(e.after!).url)).toEqual(["https://news.example.org/top", "https://news.example.org/end"]);
  });

  it("results that carry no position of their own are read by their place in the list", async () => {
    const id = await nmcRecord("Ada Fictitious", "99Z9999Z");
    await insertWatch(env.DB, { record_id: id, kind: "topic", monitor_id: topicNewResult.search_monitor_id, added_by: "admin" });
    mockStartRun("run-recheck-3");
    const results = [{ title: "Seen before", url: "https://news.example.org/seen" }, { title: "New", url: "https://news.example.org/new" }];
    const res = await monitorHook({ ...topicNewResult, id: "9e8d7c6b-0000-4000-8000-positions0002", request_id: undefined, results, new_result_positions: [1] });
    expect(await res.json()).toMatchObject({ ok: true, notices: 1 });
    expect((await events(id)).map((e) => JSON.parse(e.after!).url)).toEqual(["https://news.example.org/new"]);
  });

  it("shared decision-page webhook mentioning a watched surname creates a notice and starts one re-check; unrelated diff creates nothing", async () => {
    await putSharedMonitor(env.DB, { registry: "nmc", monitor_id: sharedChanged.fetch_monitor_id, url: nmc.decisionPages[0]!.url });
    const simone = await nmcRecord("Simone Jenlowe", "22L4964O");
    // Same surname, another given name and number: a surname alone is not a hit.
    const other = await nmcRecord("Mary Jenlowe", "88M8888M");
    mockStartRun("run-shared-1");

    const res = await monitorHook(sharedChanged);
    expect(await res.json()).toEqual({ ok: true, hits: 1 });
    expect((await events(simone)).map((e) => e.kind)).toEqual(["notice"]);
    expect(await events(other)).toEqual([]);
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);

    const unrelated = { ...sharedChanged, id: "c4d5e6f7-0000-4000-8000-unrelated000", diff: "+| SMITH, Alan 77K7777K | Adult Nurse; | NMC | Devon | SUB | N/A | |\n" };
    expect(await (await monitorHook(unrelated)).json()).toEqual({ ok: true, hits: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first()).toEqual({ n: 1 });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
  });
});

describe("the read API", () => {
  it("export and events include watched records only", async () => {
    const watched = await nmcRecord("Ada Fictitious", "99Z9999Z");
    const lookup = await nmcRecord("Bo Imaginary", "99Y8888Y", false);
    await insertEvent(env.DB, { record_id: watched, kind: "notice", after: { url: "https://news.example.org/a" } });
    await insertEvent(env.DB, { record_id: lookup, kind: "notice", after: { url: "https://news.example.org/b" } });

    const feed = (await (await callWorker("/api/events")).json()) as { events: { record_id: string }[] };
    expect(feed.events.map((e) => e.record_id)).toEqual([watched]);
    const exported = (await (await callWorker("/api/export.json")).json()) as { records: { licence_number: string; events: unknown[] }[] };
    expect(exported.records.map((r) => r.licence_number)).toEqual(["99Z9999Z"]);
    expect(exported.records[0]!.events).toHaveLength(1);
  });
});
