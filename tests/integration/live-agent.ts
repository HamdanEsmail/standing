// Shared by the opt-in Agent live tests: start ONE real run with the adapter's own goal and schema,
// poll it to the end, and check that the adapter can read what came back. The SHAPE is asserted,
// never the values (registers change). The callback points at a host with no receiver; the test polls.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { AGENT_MAX_STEPS } from "../../src/core/limits";
import type { RegistryAdapter } from "../../src/registries/types";
import { getRun, startRun } from "../../src/tinyfish/agent";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export const liveKey = env.LIVE_TINYFISH_API_KEY;

export async function runLiveAgent(adapter: RegistryAdapter, q: { variants: string[]; number?: string; profession?: string }): Promise<void> {
  const liveEnv = { ...env, TINYFISH_API_KEY: liveKey! };
  const started = Date.now();
  const { runId } = await startRun(liveEnv, {
    url: adapter.searchUrl,
    goal: adapter.goal(q),
    outputSchema: adapter.outputSchema,
    browserProfile: adapter.browserProfile,
    callbackUrl: `${env.PUBLIC_BASE_URL}/hooks/agent/live-test-no-receiver`,
  });
  let run = await getRun(liveEnv, runId, "none");
  while (!TERMINAL.has(run.status) && Date.now() - started < 180_000) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    run = await getRun(liveEnv, runId, "none");
  }
  console.log(`live ${adapter.id} run: status=${run.status} steps=${run.num_of_steps} (cap ${AGENT_MAX_STEPS}) ms=${Date.now() - started} run=${runId}`);
  console.log(`live ${adapter.id} result: ${JSON.stringify(run.result)}`);

  expect(run.status).toBe("COMPLETED");
  expect(run.num_of_steps).toBeLessThanOrEqual(AGENT_MAX_STEPS + 1) // TinyFish has run one step past the cap;
  const outcome = adapter.parseAgentResult(run.result);
  expect(typeof outcome.blocked).toBe("boolean");
  expect(outcome.blocked).toBe(false);
  expect(outcome.rows.length > 0 || outcome.opened !== null).toBe(true);
  for (const row of outcome.rows) expect(typeof row.name).toBe("string");
}
