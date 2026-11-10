// The hourly job.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron";
import { getCheck, insertCheck } from "../src/db/checks";
import { insertEvent } from "../src/db/events";
import { getRecord, upsertRecord } from "../src/db/records";
import { getSharedMonitor, getWatch, insertWatch, putSharedMonitor } from "../src/db/watches";
import { nmcHearingsPageUrl } from "../src/registries/nmc";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import { AGENT_ESTIMATE_USD } from "../src/core/limits";
import { agentCallback, completedRun, FETCH_API, freshState, mockFetchPages, mockGetRun, pageResponse, restoreState, slotRow, spendRows, startAgentCheck } from "./helpers/checks";
import { fetchMock } from "./helpers/fetch-mock";

beforeEach(freshState);
afterEach(restoreState);

const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function record(number: string, watched: boolean, evidence: string | null = null): Promise<string> {
  const id = await upsertRecord(env.DB, {
    registry: "nmc",
    record_type: "nurse",
    record: { full_name: "Ada Fictitious", licence_number: number, status_raw: "Registered", status: "active", flags: [], disciplinary: [], raw_fields: {} },
    source_url: null,
    evidence_key: evidence,
  });
  if (watched) await env.DB.prepare("UPDATE records SET watched = 1 WHERE id = ?").bind(id).run();
  return id;
}

describe("the hourly job", () => {
  it("expiry deletes the Monitor and keeps the events and the watched record", async () => {
    const rec = await record("99Z9999Z", true);
    const w = await insertWatch(env.DB, { record_id: rec, kind: "topic", monitor_id: "mon-expiring", added_by: "public", expires_at: hoursAgo(1), ip_hash: "ip" });
    await insertEvent(env.DB, { record_id: rec, kind: "notice", after: { url: "https://news.example.org/a" } });
    fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/mon-expiring`, reply: { status: 204 } });
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { monitors: [] } } });

    const out = await runCron(env);
    expect(out.expired_watches).toBe(1);
    expect(fetchMock.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect((await getWatch(env.DB, w))?.status).toBe("expired");
    expect((await getRecord(env.DB, rec))?.watched).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE record_id = ?").bind(rec).first()).toEqual({ n: 1 });
  });

  it("purge removes an old public check with its evidence objects and skips a watched record's", async () => {
    const lone = await record("11A1111A", false, "evidence/old-lookup.jpg");
    const kept = await record("22B2222B", true, "evidence/watched-one.jpg");
    const c1 = await insertCheck(env.DB, { id: "old-lookup", registry: "nmc", record_type: "nurse", added_by: "public", started_at: hoursAgo(30), state: "done", outcome: "match", record_id: lone, evidence_key: "evidence/old-lookup.jpg" });
    const c2 = await insertCheck(env.DB, { id: "watched-one", registry: "nmc", record_type: "nurse", added_by: "public", started_at: hoursAgo(30), state: "done", outcome: "match", record_id: kept, evidence_key: "evidence/watched-one.jpg" });
    for (const key of ["evidence/old-lookup.jpg", "evidence/old-lookup.md", "evidence/watched-one.jpg"]) await env.STORE.put(key, "x");
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { monitors: [] } } });

    const out = await runCron(env);
    expect(out.purged_checks).toBe(1);
    expect(await getCheck(env.DB, c1)).toBeNull();
    expect(await getRecord(env.DB, lone)).toBeNull();
    expect(await env.STORE.head("evidence/old-lookup.jpg")).toBeNull();
    expect(await env.STORE.head("evidence/old-lookup.md")).toBeNull();
    expect(await getCheck(env.DB, c2)).not.toBeNull();
    expect(await env.STORE.head("evidence/watched-one.jpg")).not.toBeNull();
  });

  it("a pending check whose run completed without a callback is resolved, and the slot freed", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-quiet");
    await env.DB.prepare("UPDATE checks SET started_at = ? WHERE id = ?").bind(hoursAgo(0.25), id).run();
    mockGetRun("run-quiet", completedRun("run-quiet", { blocked: false, results_found: 0, variants_tried: ["ada fictitious"], rows: [] }));
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { monitors: [] } } });

    const out = await runCron(env);
    expect(out.pending_followups).toBe(1);
    expect(await getCheck(env.DB, id)).toMatchObject({ state: "done", outcome: "no_match" });
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
  });

  it("a check that waited in the queue is timed from its run's start, not from when it was asked for", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-late-start");
    // Asked for 45 minutes ago, but its run started only 12 minutes ago and is still going.
    await env.DB.prepare("UPDATE checks SET started_at = ? WHERE id = ?").bind(new Date(Date.now() - 45 * 60_000).toISOString(), id).run();
    mockGetRun("run-late-start", { run_id: "run-late-start", status: "RUNNING", started_at: new Date(Date.now() - 12 * 60_000).toISOString(), steps: [] });
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { monitors: [] } } });
    await runCron(env);
    expect(await getCheck(env.DB, id)).toMatchObject({ state: "pending", run_id: "run-late-start" });
    expect(await spendRows()).toEqual([]);
  });

  it("a run still going 30 minutes after it started is given up on, and its cost is booked at the most a run can cost", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-stuck");
    await env.DB.prepare("UPDATE checks SET started_at = ? WHERE id = ?").bind(new Date(Date.now() - 45 * 60_000).toISOString(), id).run();
    mockGetRun("run-stuck", { run_id: "run-stuck", status: "RUNNING", started_at: new Date(Date.now() - 31 * 60_000).toISOString(), steps: [] });
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { monitors: [] } } });
    await runCron(env);
    const check = await getCheck(env.DB, id);
    expect(check).toMatchObject({ state: "done", outcome: "error", error: "timeout" });
    expect(check!.spend_usd).toBeCloseTo(AGENT_ESTIMATE_USD, 10);
    expect(await spendRows()).toEqual([{ kind: "agent_step", amount_usd: AGENT_ESTIMATE_USD, ref: id }]);
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });

    // The run ends after all: its callback finds the check finished and books nothing more.
    mockGetRun("run-stuck", completedRun("run-stuck", { blocked: false, results_found: 0, rows: [] }, { num_of_steps: 12 }));
    await agentCallback({ run_id: "run-stuck", status: "COMPLETED" });
    expect(await spendRows()).toHaveLength(1);
  });

  describe("the NMC hearings page, which has a new address every month", () => {
    const NOVEMBER = nmcHearingsPageUrl("2026-11-01");
    const DECEMBER = nmcHearingsPageUrl("2026-12-01");
    const FIRST_OF_DECEMBER = new Date("2026-12-01T00:15:00Z");
    const monitorCalls = () => fetchMock.calls.filter((c) => c.url.startsWith(MONITORS_API) && c.method !== "GET").map((c) => `${c.method} ${c.url}`);

    it("is left alone while the month is the same", async () => {
      await putSharedMonitor(env.DB, { registry: "nmc", monitor_id: "mon-november", url: NOVEMBER });
      fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { monitors: [{ id: "mon-november", status: "active" }] } } });
      await runCron(env, new Date("2026-11-30T23:15:00Z"));
      expect(monitorCalls()).toEqual([]);
      expect(fetchMock.calls.filter((c) => c.url === FETCH_API)).toEqual([]);
      expect(await getSharedMonitor(env.DB, "nmc")).toMatchObject({ monitor_id: "mon-november", url: NOVEMBER });
    });

    it("gets a Monitor on the new month's page once that page can be read, and last month's is deleted after", async () => {
      await putSharedMonitor(env.DB, { registry: "nmc", monitor_id: "mon-november", url: NOVEMBER });
      mockFetchPages({ [DECEMBER]: pageResponse(DECEMBER, "# Hearings December 2026") });
      const made = structuredClone(monitorCreate) as { monitor: { id: string } };
      made.monitor.id = "mon-december";
      fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: made } });
      fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/mon-november`, reply: { status: 204 } });
      fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { monitors: [{ id: "mon-december", status: "active" }] } } });
      const out = await runCron(env, FIRST_OF_DECEMBER);
      expect(out.failed_steps).toEqual([]);
      expect(monitorCalls()).toEqual([`POST ${MONITORS_API}`, `DELETE ${MONITORS_API}/mon-november`]);
      const created = fetchMock.calls.find((c) => c.method === "POST" && c.url === MONITORS_API)!;
      expect(JSON.stringify(created.body)).toContain(DECEMBER);
      expect(await getSharedMonitor(env.DB, "nmc")).toMatchObject({ monitor_id: "mon-december", url: DECEMBER });
    });

    it("stays on last month's page while the new month's cannot be read yet, and says so", async () => {
      await putSharedMonitor(env.DB, { registry: "nmc", monitor_id: "mon-november", url: NOVEMBER });
      fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: { results: [], errors: [{ url: DECEMBER, error: "target_unreachable" }] } } });
      fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { monitors: [{ id: "mon-november", status: "active" }] } } });
      const out = await runCron(env, FIRST_OF_DECEMBER);
      expect(monitorCalls()).toEqual([]);
      expect(await getSharedMonitor(env.DB, "nmc")).toMatchObject({ monitor_id: "mon-november", url: NOVEMBER });
      expect(out.unhealthy.join(" ")).toMatch(/nmc.*cannot be read yet/);
    });
  });

  it("health marks a watch failed when its Monitor is paused, and never touches a monitor that is not Standing's", async () => {
    const rec = await record("99Z9999Z", true);
    const w = await insertWatch(env.DB, { record_id: rec, kind: "topic", monitor_id: "mon-paused", added_by: "admin" });
    fetchMock.intercept({
      method: "GET",
      url: MONITORS_API,
      reply: { json: { monitors: [{ id: "mon-paused", status: "paused" }, { id: "e92c04d7-foreign", status: "paused" }] } },
    });

    const out = await runCron(env);
    expect((await getWatch(env.DB, w))?.status).toBe("failed");
    expect(out.unhealthy).toEqual([`watch ${w}: its Monitor is paused; marked failed`]);
    // One GET of the list and nothing else: no pause, delete or edit of any monitor.
    expect(fetchMock.calls.map((c) => c.method)).toEqual(["GET"]);
  });
});
