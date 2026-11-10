// Requests that arrive at the same moment. Every cap must hold when its check and its write are raced:
// the watch slots, a visitor's watches, one watch per record, and the day's public Agent checks.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_AGENT_CHECKS_PER_DAY, PUBLIC_WATCH_SLOTS, PUBLIC_WATCHES_PER_IP } from "../src/core/limits";
import { upsertRecord } from "../src/db/records";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import { callWorker } from "./helpers/app";
import { FETCH_API, freshState, postCheck, restoreState, RUN_ASYNC_API } from "./helpers/checks";
import { fetchMock } from "./helpers/fetch-mock";

beforeEach(freshState);
afterEach(restoreState);

const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";

/** A stored GMC record under an invented number, with a record page a Page monitor can watch. */
function gmcRecord(number: string): Promise<string> {
  return upsertRecord(env.DB, {
    registry: "gmc",
    record_type: "doctor",
    record: { full_name: `Ada Example ${number}`, licence_number: number, status_raw: "Registered with a licence to practise", status: "active", flags: [], disciplinary: [], raw_fields: {} },
    source_url: `https://www.gmc-uk.org/registrants/${number}`,
  });
}

/** TinyFish takes seconds to create a Monitor and run its baseline; here, long enough for the others to arrive. */
function slowMonitorCreate(fail = false): void {
  let n = 0;
  fetchMock.intercept({
    method: "POST",
    url: MONITORS_API,
    times: Infinity,
    reply: async () => {
      n++;
      await new Promise((r) => setTimeout(r, 40));
      if (fail) return Response.json({ error: { code: "INTERNAL" } }, { status: 500 });
      const body = structuredClone(monitorCreate) as { monitor: { id: string } };
      body.monitor.id = `mon-${n}`;
      return Response.json(body, { status: 201 });
    },
  });
}

function watch(recordId: string, ip: string): Promise<Response> {
  return callWorker(`/api/records/${recordId}/watch`, {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
    body: "{}",
  });
}

const monitorCreates = () => fetchMock.calls.filter((c) => c.method === "POST" && c.url === MONITORS_API).length;
const one = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

describe("watches asked for at the same moment", () => {
  it("one visitor asking for eight at once gets two, and only two Monitors are made", async () => {
    slowMonitorCreate();
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(await gmcRecord(String(7000001 + i)));
    const res = await Promise.all(ids.map((id) => watch(id, "203.0.113.9")));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 201).length).toBe(PUBLIC_WATCHES_PER_IP);
    expect(codes.filter((c) => c === 429).length).toBe(8 - PUBLIC_WATCHES_PER_IP);
    expect(monitorCreates()).toBe(PUBLIC_WATCHES_PER_IP);
    expect(await one("SELECT COUNT(*) AS n FROM watches")).toBe(PUBLIC_WATCHES_PER_IP);
    expect(await one("SELECT COUNT(*) AS n FROM watches WHERE status = 'active' AND monitor_id IS NOT NULL")).toBe(PUBLIC_WATCHES_PER_IP);
  });

  it("eight visitors at once fill the four public slots and no more", async () => {
    slowMonitorCreate();
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(await gmcRecord(String(7100001 + i)));
    const res = await Promise.all(ids.map((id, i) => watch(id, `203.0.113.${20 + i}`)));
    const refused = await Promise.all(res.filter((r) => r.status !== 201).map((r) => r.json() as Promise<{ error: string }>));
    expect(res.filter((r) => r.status === 201).length).toBe(PUBLIC_WATCH_SLOTS);
    expect(refused.map((b) => b.error)).toEqual(Array(8 - PUBLIC_WATCH_SLOTS).fill("public_slots_full"));
    expect(monitorCreates()).toBe(PUBLIC_WATCH_SLOTS);
    expect(await one("SELECT COUNT(*) AS n FROM watches WHERE status = 'active'")).toBe(PUBLIC_WATCH_SLOTS);
    // A refused visitor has used none of the day's watches.
    expect(await one("SELECT COALESCE(SUM(watches), 0) AS n FROM public_use")).toBe(PUBLIC_WATCH_SLOTS);
  });

  it("two visitors watching the same record at once make one watch and one Monitor", async () => {
    slowMonitorCreate();
    const id = await gmcRecord("7200001");
    const res = await Promise.all([watch(id, "203.0.113.40"), watch(id, "203.0.113.41")]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = (await res.find((r) => r.status === 409)!.json()) as { error: string };
    expect(refused.error).toBe("already_watched");
    expect(monitorCreates()).toBe(1);
    expect(await one("SELECT COUNT(*) AS n FROM watches WHERE record_id = ?", id)).toBe(1);
  });

  it("a Monitor TinyFish refuses leaves no watch behind, and the record can be watched afterwards", async () => {
    slowMonitorCreate(true);
    const id = await gmcRecord("7300001");
    const refused = await watch(id, "203.0.113.50");
    expect(refused.status).toBe(502);
    expect(await one("SELECT COUNT(*) AS n FROM watches")).toBe(0);
    expect(await one("SELECT COALESCE(SUM(watches), 0) AS n FROM public_use")).toBe(0);
    fetchMock.reset();
    fetchMock.activate();
    slowMonitorCreate();
    expect((await watch(id, "203.0.113.50")).status).toBe(201);
  });
});

describe("public checks that need the Agent, asked for at the same moment", () => {
  const NAMES = ["Ada Fictitious", "Bea Imaginary", "Cy Madeup", "Di Example", "Ed Sample", "Flo Invented", "Gus Notreal", "Hal Placeholder", "Ivy Pretend", "Jo Fabricated", "Kit Unreal", "Lu Dummy"];

  it("twelve visitors at once: eight are queued, four are told the day's Agent checks are used, and those four used no check", async () => {
    let n = 0;
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, times: Infinity, reply: () => Response.json({ run_id: `run-${++n}` }) });
    const res = await Promise.all(NAMES.map((q, i) => postCheck({ query: q, record_type: "nurse", jurisdiction: "GB" }, { ip: `192.0.2.${i + 1}` })));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 202).length).toBe(PUBLIC_AGENT_CHECKS_PER_DAY);
    expect(codes.filter((c) => c === 429).length).toBe(NAMES.length - PUBLIC_AGENT_CHECKS_PER_DAY);
    const refused = (await res.find((r) => r.status === 429)!.json()) as { error: string };
    expect(refused.error).toBe("daily_agent_checks_used");
    expect(await one("SELECT COUNT(*) AS n FROM checks WHERE added_by = 'public' AND method = 'agent'")).toBe(PUBLIC_AGENT_CHECKS_PER_DAY);
    expect(await one("SELECT COALESCE(SUM(checks), 0) AS n FROM public_use")).toBe(PUBLIC_AGENT_CHECKS_PER_DAY);
  });

  it("a number check whose page cannot be read, with the day's Agent checks used, is never put in the queue", async () => {
    let n = 0;
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, times: Infinity, reply: () => Response.json({ run_id: `run-${++n}` }) });
    for (let i = 0; i < PUBLIC_AGENT_CHECKS_PER_DAY; i++) {
      expect((await postCheck({ query: NAMES[i], record_type: "nurse", jurisdiction: "GB" }, { ip: `192.0.2.${i + 1}` })).status).toBe(202);
    }
    // The GMC record page cannot be read, so this check would fall back to the Agent.
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      times: Infinity,
      reply: (_req, body) => Response.json({ results: [], errors: [{ url: (body as { urls: string[] }).urls[0], error: "timeout" }] }),
    });
    const res = await postCheck({ number: "7999999", record_type: "doctor", jurisdiction: "GB" }, { ip: "192.0.2.99" });
    expect(res.status).toBe(429);
    const row = await env.DB.prepare("SELECT state, error, method, run_id FROM checks WHERE number = '7999999'").first();
    // It never carried `method = 'agent'` while pending, so no pump could have started a run for it.
    expect(row).toEqual({ state: "done", error: "daily_agent_checks_used", method: "fetch", run_id: null });
  });
});
