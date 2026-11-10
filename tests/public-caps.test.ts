// The live product's two money lines: the spend pause at $4, and at most
// PUBLIC_AGENT_CHECKS_PER_DAY public checks a UTC day that start an Agent run.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_AGENT_CHECKS_PER_DAY, SPEND_PAUSE_USD } from "../src/core/limits";
import { insertCheck } from "../src/db/checks";
import { callsTo, freshState, mockStartRun, postCheck, restoreState, RUN_ASYNC_API } from "./helpers/checks";

beforeEach(freshState);
afterEach(restoreState);

const NURSE = { query: "Ada Fictitious", record_type: "nurse", jurisdiction: "GB" };

describe("public caps", () => {
  it("the day's ninth public Agent check is 429 daily_agent_checks_used with a plain message; an admin check still runs", async () => {
    expect(PUBLIC_AGENT_CHECKS_PER_DAY).toBe(8);
    const now = new Date().toISOString();
    for (let i = 0; i < PUBLIC_AGENT_CHECKS_PER_DAY; i++) {
      await insertCheck(env.DB, { registry: "nmc", record_type: "nurse", jurisdiction: "GB", method: "agent", run_id: `run-${i}`, added_by: "public", started_at: now, state: "done", outcome: "no_match" });
    }
    const refused = await postCheck(NURSE, { ip: "203.0.113.9" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "daily_agent_checks_used", detail: expect.stringMatching(/00:00 UTC/) });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(0);

    mockStartRun("run-admin");
    expect((await postCheck(NURSE, { admin: true })).status).toBe(202);
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
  });

  it("paid work pauses once total spend reaches $4", async () => {
    expect(SPEND_PAUSE_USD).toBe(4);
    await env.DB.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('s1', 'agent_step', 3.5, 'x', ?)").bind(new Date().toISOString()).run();
    mockStartRun("run-under");
    expect((await postCheck(NURSE, { admin: true })).status).toBe(202);
    await env.DB.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('s2', 'agent_step', 0.5, 'x', ?)").bind(new Date().toISOString()).run();
    const paused = await postCheck({ ...NURSE, query: "Bo Imaginary" }, { admin: true });
    expect(paused.status).toBe(503);
    expect(await paused.json()).toEqual({ error: "spend_paused" });
  });
});
