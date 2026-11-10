// The one-Agent-run-in-flight rule (one run at a time keeps spend and the load on the registers predictable): a D1 slot with a
// 5-minute stale timeout, a queue of pending checks without a run, and the pump that starts
// the oldest one when the slot is free.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkDeps } from "../src/checks/deps";
import { pumpQueue } from "../src/checks/queue";
import { releaseSlot, takeSlot } from "../src/checks/slot";
import { AGENT_ESTIMATE_USD, AGENT_SLOT_STALE_MINUTES } from "../src/core/limits";
import agentAmbiguous from "./fixtures/registries/gmc-agent-result-ambiguous.json";
import {
  agentCallback,
  callsTo,
  completedRun,
  freshState,
  getCheckJson,
  mockGetRun,
  mockStartRun,
  postCheck,
  restoreState,
  RUN_ASYNC_API,
  slotRow,
  startAgentCheck,
} from "./helpers/checks";
import { fetchMock } from "./helpers/fetch-mock";

beforeEach(freshState);
afterEach(restoreState);

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function setSlot(holder: string | null, since: string | null): Promise<void> {
  await env.DB.prepare("UPDATE agent_slot SET holder_check_id = ?, since = ? WHERE id = 1").bind(holder, since).run();
}

describe("agent slot", () => {
  it("is taken by one holder at a time, released only by its holder, and stale after five minutes", async () => {
    expect(AGENT_SLOT_STALE_MINUTES).toBe(5);
    expect(await takeSlot(env.DB, "check-a")).toBe(true);
    expect(await takeSlot(env.DB, "check-b")).toBe(false);
    expect(await releaseSlot(env.DB, "check-b")).toBe(false);
    expect((await slotRow()).holder_check_id).toBe("check-a");
    expect(await releaseSlot(env.DB, "check-a")).toBe(true);
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });

    await setSlot("check-old", minutesAgo(4));
    expect(await takeSlot(env.DB, "check-b")).toBe(false);
    await setSlot("check-old", minutesAgo(6));
    expect(await takeSlot(env.DB, "check-b")).toBe(true);
    expect((await slotRow()).holder_check_id).toBe("check-b");
  });
});

describe("one Agent run in flight", () => {
  it("a second Agent check while the first is pending makes NO Agent call and stays queued", async () => {
    const first = await startAgentCheck("Ada Fictitious", "run-first");
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);

    const res = await postCheck({ query: "Bo Imaginary", record_type: "doctor", jurisdiction: "GB" });
    expect(res.status).toBe(202);
    const second = (await res.json()) as { check_id: string };
    expect(second).toMatchObject({ status: "pending", cached: false, estimated_cost_usd: 0.208 });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    expect(await getCheckJson(second.check_id)).toEqual({ status: "pending", started_at: expect.any(String), run_id: null, queued: true });
    // Polling the queued check tries the pump, which still finds the slot held.
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    expect((await slotRow()).holder_check_id).toBe(first);
  });

  it("the first's callback starts the second (one Agent call)", async () => {
    const first = await startAgentCheck("Syeda Sickfold", "run-first");
    const res = await postCheck({ query: "Bo Imaginary", record_type: "doctor", jurisdiction: "GB" });
    const { check_id: second } = (await res.json()) as { check_id: string };
    const third = (await (await postCheck({ query: "Cy Madeup", record_type: "doctor", jurisdiction: "GB" })).json()) as {
      check_id: string;
    };
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);

    mockGetRun("run-first", completedRun("run-first", agentAmbiguous));
    mockStartRun("run-second");
    expect((await agentCallback({ run_id: "run-first", status: "COMPLETED" })).status).toBe(200);

    expect(await getCheckJson(first)).toMatchObject({ outcome: "ambiguous" });
    const starts = callsTo("POST", RUN_ASYNC_API);
    expect(starts).toHaveLength(2);
    // The oldest queued check goes first, and only one run is started.
    expect((starts[1]!.body as { goal: string }).goal).toContain('"bo imaginary"');
    expect(await getCheckJson(second)).toMatchObject({ status: "pending", run_id: "run-second", queued: false });
    expect(await getCheckJson(third.check_id)).toMatchObject({ status: "pending", run_id: null, queued: true });
    expect((await slotRow()).holder_check_id).toBe(second);
  });

  it("a holder older than 5 minutes is taken over", async () => {
    await setSlot("check-that-never-called-back", minutesAgo(AGENT_SLOT_STALE_MINUTES + 1));
    const id = await startAgentCheck("Ada Fictitious", "run-takeover");
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    expect(await getCheckJson(id)).toMatchObject({ status: "pending", run_id: "run-takeover" });
    expect((await slotRow()).holder_check_id).toBe(id);
  });

  it("a fresh holder is not taken over, and polling the queued check starts it once the holder is stale", async () => {
    await setSlot("someone-else", minutesAgo(1));
    const res = await postCheck({ query: "Ada Fictitious", record_type: "doctor", jurisdiction: "GB" });
    const { check_id: id } = (await res.json()) as { check_id: string };
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(0);
    expect(await getCheckJson(id)).toMatchObject({ queued: true });

    await setSlot("someone-else", minutesAgo(AGENT_SLOT_STALE_MINUTES + 1));
    mockStartRun("run-after-stale");
    expect(await getCheckJson(id)).toMatchObject({ status: "pending", run_id: "run-after-stale", queued: false });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
  });

  it("four 429s → the check is error: busy and the slot is free again", async () => {
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      times: 4,
      reply: { status: 429, json: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many concurrent runs" } } },
    });
    const res = await postCheck({ query: "Ada Fictitious", record_type: "doctor", jurisdiction: "GB" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { check_id: string };
    // No run started, so nothing was spent and nothing will be.
    expect(body).toMatchObject({ status: "done", estimated_cost_usd: 0 });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(4);
    const rec = await getCheckJson(body.check_id);
    expect(rec).toMatchObject({ outcome: "error", error: "busy", spend_usd: 0 });
    expect(rec).not.toHaveProperty("status");
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
  });

  it("the slot counts from the run's start: a run that started after 4 minutes of 429 waits is not taken over 2 minutes later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-11-05T09:00:00.000Z");
    vi.setSystemTime(t0);
    // Three 429s whose waits take 80 s each: the run starts at t0 + 4 min.
    checkDeps.sleep = async () => {
      vi.setSystemTime(Date.now() + 80_000);
    };
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, times: 3, reply: { status: 429, json: { error: { code: "RATE_LIMIT_EXCEEDED" } } } });
    const first = await startAgentCheck("Ada Fictitious", "run-slow-start");
    expect(Date.now()).toBe(t0 + 4 * 60_000);
    expect(await slotRow()).toEqual({ holder_check_id: first, since: new Date(t0 + 4 * 60_000).toISOString() });

    vi.setSystemTime(t0 + 6 * 60_000);
    const res = await postCheck({ query: "Bo Imaginary", record_type: "doctor", jurisdiction: "GB" });
    const second = (await res.json()) as { check_id: string };
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(4);
    expect(await getCheckJson(second.check_id)).toMatchObject({ queued: true });
    expect((await slotRow()).holder_check_id).toBe(first);
  });

  it("a queued check whose writes fail still frees the slot", async () => {
    await env.DB.prepare(
      "CREATE TRIGGER refuse_finish BEFORE UPDATE OF state ON checks WHEN NEW.state = 'done' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    ).run();
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, times: 4, reply: { status: 429, json: { error: { code: "RATE_LIMIT_EXCEEDED" } } } });
    const res = await postCheck({ query: "Ada Fictitious", record_type: "doctor", jurisdiction: "GB" });
    expect(res.status).toBe(500);
    await res.arrayBuffer();
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
  });

  it("a run whose id cannot be recorded ends its check as run_not_recorded, the live run keeps the slot, and its cost is booked", async () => {
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: async () => {
        // Something else writes a run id first, so this run's id cannot be recorded.
        await env.DB.prepare("UPDATE checks SET run_id = 'run-from-elsewhere' WHERE state = 'pending' AND run_id IS NULL").run();
        return Response.json({ run_id: "run-unrecorded" });
      },
    });
    const res = await postCheck({ query: "Ada Fictitious", record_type: "doctor", jurisdiction: "GB" });
    const { check_id: id } = (await res.json()) as { check_id: string };
    expect(await getCheckJson(id)).toMatchObject({ outcome: "error", error: "run_not_recorded" });
    // The run is live on TinyFish, so the slot stays held (re-stamped at its start) until it goes stale.
    expect((await slotRow()).holder_check_id).toBe(id);
    // Nothing will ever settle that run, so the most it can cost is in the ledger now.
    const booked = await env.DB.prepare("SELECT kind, amount_usd, ref FROM spend").all();
    expect(booked.results).toEqual([{ kind: "agent_step", amount_usd: AGENT_ESTIMATE_USD, ref: id }]);
  });

  it("pumpQueue with nothing queued does nothing", async () => {
    await pumpQueue(env);
    expect(fetchMock.calls).toEqual([]);
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
  });
});
