// Five cases in the shared resolver and the queue: the slot of a requeued check, the cost a requeued check carries, number searches that
// mix numbered and numberless rows, an opened entry that names nothing, and the list size per adapter.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planSearch } from "../src/checks/plan";
import { decideRows, settleAgentRun, type FinishedRun } from "../src/checks/resolve";
import { getCheck } from "../src/db/checks";
import { gmc } from "../src/registries/gmc";
import type { AgentEntry, RegistryRow } from "../src/registries/types";
import fetchSelectorNotMatched from "./fixtures/tinyfish/fetch-selector-not-matched.json";
import {
  agentCallback,
  callsTo,
  completedRun,
  freshState,
  getCheckJson,
  mockFetchPages,
  mockGetRun,
  mockStartRun,
  restoreState,
  RUN_ASYNC_API,
  slotRow,
  spendRows,
  startAgentCheck,
} from "./helpers/checks";
import { fetchMock } from "./helpers/fetch-mock";

beforeEach(freshState);
afterEach(restoreState);

const ADA_URL = "https://www.gmc-uk.org/registrants/99000001";
const LICENSED = "Registered with a licence to practise";
const noEntry = { full_name: null, gmc_number: null, status: null, entry_url: null, sanctions_text: null };
const ADA_ROW = { name: "Ada FICTITIOUS", number: "99000001", status: LICENSED, specialty: null };

function finished(runId: string, result: unknown): FinishedRun {
  return { runId, status: "COMPLETED", result, num_of_steps: 9, finished_at: "2026-11-03T09:01:30Z", steps: [], errorCode: null };
}

const row = (name: string, number: string | null): RegistryRow => ({ name, number, status_raw: null, detail: null, url: null });
const opened = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  full_name: null,
  licence_number: null,
  status_raw: null,
  url: null,
  sanctions_text: null,
  ...over,
});

describe("the slot of a requeued check", () => {
  /** The admin's name check whose run (run-a) found one numbered row and opened nothing, with the record
   *  page unreadable: settling it sends the check back to the queue for a run by number (run-b). A
   *  public check never does this (below). */
  async function requeueScenario() {
    const id = await startAgentCheck("Ada Fictitious", "run-a", {}, { admin: true });
    const check = (await getCheck(env.DB, id))!;
    expect(check.run_id).toBe("run-a");
    const run = finished("run-a", { blocked: false, results_found: 1, variants_tried: ["ada fictitious"], rows: [ADA_ROW], ...noEntry });
    mockFetchPages({ [ADA_URL]: fetchSelectorNotMatched });
    mockStartRun("run-b");
    return { id, check, run };
  }

  it("a losing duplicate settle (not applied) does not free the slot the winner's pump re-took", async () => {
    const { id, check, run } = await requeueScenario();

    const first = await settleAgentRun(env, check, run);
    expect(first).toMatchObject({ applied: true, requeued: true });
    expect(await getCheckJson(id)).toMatchObject({ status: "pending", run_id: "run-b" });
    expect((await slotRow()).holder_check_id).toBe(id);
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(2);

    // The duplicate still holds the stale snapshot of the check (pending, run-a) and loses the guard.
    const second = await settleAgentRun(env, check, run);
    expect(second.applied).toBe(false);
    expect((await slotRow()).holder_check_id).toBe(id);
    // The number run is still the only run in flight, and it was billed once.
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(2);
    expect((await spendRows()).filter((r) => r.kind === "agent_step")).toHaveLength(1);
  });

  it("two concurrent settles of the same run start exactly one number run and leave the slot with the check", async () => {
    const { id, check, run } = await requeueScenario();
    const [a, b] = await Promise.all([settleAgentRun(env, check, run), settleAgentRun(env, check, run)]);
    expect([a.applied, b.applied].filter(Boolean)).toHaveLength(1);
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(2);
    expect((await slotRow()).holder_check_id).toBe(id);
    expect(await getCheckJson(id)).toMatchObject({ status: "pending", run_id: "run-b" });
  });

  it("a settle that applied still frees the slot (the check finished)", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-done");
    const check = (await getCheck(env.DB, id))!;
    const run = finished("run-done", { blocked: false, results_found: 0, variants_tried: ["ada fictitious"], rows: [], ...noEntry });
    expect((await settleAgentRun(env, check, run)).applied).toBe(true);
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
    // A duplicate of a finished check changes nothing and does not touch a slot a later check holds.
    const later = await startAgentCheck("Bo Imaginary", "run-later");
    expect((await settleAgentRun(env, check, run)).applied).toBe(false);
    expect((await slotRow()).holder_check_id).toBe(later);
  });
});

describe("a public name check costs one run", () => {
  it("one named row with a number, nothing opened and its page unreadable: the row is offered to verify by number, and no second run starts", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-one");
    mockGetRun("run-one", completedRun("run-one", { blocked: false, results_found: 1, variants_tried: ["ada fictitious"], rows: [ADA_ROW], ...noEntry }));
    mockFetchPages({ [ADA_URL]: fetchSelectorNotMatched });
    expect((await agentCallback({ run_id: "run-one", status: "COMPLETED" })).status).toBe(200);

    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({ outcome: "ambiguous", candidates_total: 1 });
    expect((rec.candidates as { licence_number: string }[]).map((c) => c.licence_number)).toEqual(["99000001"]);
    // The one run is billed once, nothing is stored as a record, and the slot is free again.
    expect((await spendRows()).filter((r) => r.kind === "agent_step")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM records").first()).toEqual({ n: 0 });
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
  });
});

describe("the cost a requeued check carries", () => {
  it("keeps the first run's cost on the check when the number run cannot start (busy)", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-first", {}, { admin: true });
    mockGetRun("run-first", completedRun("run-first", { blocked: false, results_found: 1, rows: [ADA_ROW], ...noEntry }));
    mockFetchPages({ [ADA_URL]: fetchSelectorNotMatched });
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      times: 4,
      reply: { status: 429, json: { error: { code: "RATE_LIMIT_EXCEEDED" } } },
    });
    expect((await agentCallback({ run_id: "run-first", status: "COMPLETED" })).status).toBe(200);

    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({ outcome: "error", error: "busy" });
    expect(rec.spend_usd as number).toBeCloseTo(9 * 0.016, 10);
    const billed = (await spendRows()).filter((r) => r.kind === "agent_step");
    expect(billed).toHaveLength(1);
    expect(billed[0]!.amount_usd).toBeCloseTo(9 * 0.016, 10);
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
  });

  it("keeps it when the number run cannot start because spending is paused", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-first", {}, { admin: true });
    mockGetRun("run-first", completedRun("run-first", { blocked: false, results_found: 1, rows: [ADA_ROW], ...noEntry }));
    mockFetchPages({ [ADA_URL]: fetchSelectorNotMatched });
    // The first run's own steps take spending to the pause.
    await env.DB.prepare("INSERT INTO spend (id, at, kind, amount_usd, ref) VALUES ('s1', ?, 'agent_step', 8, 'other')")
      .bind(new Date().toISOString())
      .run();
    expect((await agentCallback({ run_id: "run-first", status: "COMPLETED" })).status).toBe(200);
    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({ outcome: "error", error: "spend_paused" });
    expect(rec.spend_usd as number).toBeCloseTo(9 * 0.016, 10);
  });
});

describe("a number search with numberless rows", () => {
  const plan = () => {
    const p = planSearch(gmc, "doctor", undefined, "99000001");
    if ("invalid" in p) throw new Error(p.invalid);
    return p;
  };

  it("a differing number next to a numberless row is incomplete, not no_match: the numberless row could be the registrant", () => {
    expect(decideRows(plan(), [row("Bo IMAGINARY", "99000002"), row("Cy MADEUP", null)], 2)).toEqual({ outcome: "incomplete" });
    expect(decideRows(plan(), [row("Cy MADEUP", null), row("Bo IMAGINARY", "99000002")], 2)).toEqual({ outcome: "incomplete" });
  });

  it("is no_match only when every compared row carries a number and none is the input", () => {
    expect(decideRows(plan(), [row("Bo IMAGINARY", "99000002"), row("Cy MADEUP", "99000003")], 2)).toEqual({ outcome: "no_match" });
    expect(decideRows(plan(), [], 0)).toEqual({ outcome: "no_match" });
    expect(decideRows(plan(), [], 0, null)).toEqual({ outcome: "no_match" });
  });

  it("an opened entry is compared too: a different number is no_match, no number at all is incomplete, the input number matches", () => {
    const rows = [row("Bo IMAGINARY", "99000002")];
    expect(decideRows(plan(), rows, 1, opened({ licence_number: "99000003" }))).toEqual({ outcome: "no_match" });
    expect(decideRows(plan(), rows, 1, opened({ full_name: "Cy MADEUP" }))).toEqual({ outcome: "incomplete" });
    expect(decideRows(plan(), rows, 1, opened({ licence_number: "99000001", full_name: "Ada FICTITIOUS" }))).toMatchObject({
      outcome: "match",
      row: { number: "99000001", name: "Ada FICTITIOUS" },
    });
  });

  it("the existing cases hold: the equal row matches, two equal rows are ambiguous, rows without any number are incomplete", () => {
    expect(decideRows(plan(), [row("Bo IMAGINARY", "99000002"), row("Ada FICTITIOUS", "99000001")], 2)).toMatchObject({ outcome: "match" });
    expect(decideRows(plan(), [row("Ada FICTITIOUS", "99000001"), row("Ada FICTITIOUS", "99000001")], 2)).toMatchObject({ outcome: "ambiguous" });
    expect(decideRows(plan(), [row("Cy MADEUP", null)], 1)).toEqual({ outcome: "incomplete" });
    expect(decideRows(plan(), [], 0, opened({ full_name: "Ada FICTITIOUS" }))).toEqual({ outcome: "incomplete" });
  });
});

describe("an opened entry that names nothing", () => {
  it("is not the matched row's entry: its status is not used, and the match is searched again by its number", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-nameless", {}, { admin: true });
    mockGetRun(
      "run-nameless",
      completedRun("run-nameless", {
        blocked: false,
        results_found: 1,
        rows: [ADA_ROW],
        ...noEntry,
        // An entry with a status line but neither a name nor a number: nothing ties it to the row.
        status: "Suspended",
        entry_url: ADA_URL,
      }),
    );
    mockFetchPages({ [ADA_URL]: fetchSelectorNotMatched });
    mockStartRun("run-by-number");
    expect((await agentCallback({ run_id: "run-nameless", status: "COMPLETED" })).status).toBe(200);
    expect(await getCheckJson(id)).toMatchObject({ status: "pending", run_id: "run-by-number" });
  });

  it("an entry that carries the row's name and number is still used", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-same");
    mockGetRun(
      "run-same",
      completedRun("run-same", { blocked: false, results_found: 1, rows: [ADA_ROW], ...noEntry, full_name: "Ada FICTITIOUS", gmc_number: "99000001", status: "Suspended" }),
    );
    mockFetchPages({ [ADA_URL]: fetchSelectorNotMatched });
    await agentCallback({ run_id: "run-same", status: "COMPLETED" });
    expect(await getCheckJson(id)).toMatchObject({ outcome: "match", status: "suspended", status_raw: "Suspended" });
  });
});

describe("the rows a run lists, per adapter", () => {
  const plan = () => {
    const p = planSearch(gmc, "doctor", "Ada Fictitious", undefined);
    if ("invalid" in p) throw new Error(p.invalid);
    return p;
  };
  const rows = (n: number) => [row("Ada FICTITIOUS", "99000001"), ...Array.from({ length: n - 1 }, (_, i) => row(`Other Person${i}`, `9900${i + 10}`))];

  it("a name match from a full list is truncated, where 'full' is the adapter's own list size (10 by default)", () => {
    expect(decideRows(plan(), rows(10), null)).toMatchObject({ outcome: "ambiguous" });
    expect(decideRows(plan(), rows(9), null)).toMatchObject({ outcome: "match" });
    // A list size of 20 (Companies House's page) or 5 moves the line.
    expect(decideRows(plan(), rows(10), null, null, 20)).toMatchObject({ outcome: "match" });
    expect(decideRows(plan(), rows(5), null, null, 5)).toMatchObject({ outcome: "ambiguous" });
    expect(decideRows(plan(), rows(4), null, null, 5)).toMatchObject({ outcome: "match" });
  });

  it("a name match beside a row with no name is ambiguous: the unnamed row could be the same person", () => {
    expect(decideRows(plan(), [row("Ada FICTITIOUS", "99000001"), row("", "99000002")], 2)).toMatchObject({ outcome: "ambiguous", total: 2 });
    expect(decideRows(plan(), [row("Ada FICTITIOUS", "99000001"), row("   ", null)], 2)).toMatchObject({ outcome: "ambiguous" });
    expect(decideRows(plan(), [row("Ada FICTITIOUS", "99000001")], 1)).toMatchObject({ outcome: "match" });
  });
});
