// Opt-in live test: ONE real TinyAgent run on the GMC register, for the doctor named in the shell
// (STANDING_LIVE_GMC_NAME, so that no person is named in this file; the spike searched a public
// office holder).
// Cost: at most $0.19 (the run is capped at AGENT_MAX_STEPS = 12 steps at $0.016); the spike
// run took 8 steps, about $0.13. It runs only when the shell sets STANDING_LIVE=1, which makes
// vitest.config.ts pass the real key in as LIVE_TINYFISH_API_KEY:
//
//   STANDING_LIVE=1 STANDING_LIVE_GMC_NAME="<a doctor's name>" npx vitest run tests/integration/gmc.live.test.ts --reporter=verbose
//
// The key comes from .dev.vars (else TINYFISH_API_KEY in the shell). The default reporter hides
// console output in this pool; --reporter=verbose shows the step-count line. There is no
// fetchMock here: the calls are real. `npm run check` skips this file, and it is run only on
// purpose, by hand (every live call is logged in docs/build-log.md).
//
// The test asserts the SHAPE of the result through gmc.parseAgentResult, never the values: the
// register changes, and this checks that the goal and schema still produce something the adapter
// can read. The run's webhook_url points at a host that does not exist (there is no live
// receiver here); the test polls getRun instead.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { AGENT_MAX_STEPS } from "../../src/core/limits";
import { normalizePerson, variantsFor } from "../../src/core/names";
import { gmc } from "../../src/registries/gmc";
import { getRun, startRun } from "../../src/tinyfish/agent";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const POLL_EVERY_MS = 5_000;
const WAIT_AT_MOST_MS = 180_000;

it.skipIf(!env.LIVE_TINYFISH_API_KEY || !env.LIVE_GMC_NAME)(
  "runs one real GMC Agent search for the name given in the shell and reads a result of the expected shape",
  async () => {
    const liveEnv = { ...env, TINYFISH_API_KEY: env.LIVE_TINYFISH_API_KEY! };
    const variants = variantsFor(normalizePerson(env.LIVE_GMC_NAME!), gmc.allowSurnameOnly);
    const started = Date.now();

    const { runId } = await startRun(liveEnv, {
      url: gmc.searchUrl,
      goal: gmc.goal({ variants }),
      outputSchema: gmc.outputSchema,
      browserProfile: gmc.browserProfile,
      callbackUrl: `${env.PUBLIC_BASE_URL}/hooks/agent/live-test-no-receiver`,
    });
    expect(runId).not.toBe("");

    let run = await getRun(liveEnv, runId, "none");
    while (!TERMINAL.has(run.status) && Date.now() - started < WAIT_AT_MOST_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_EVERY_MS));
      run = await getRun(liveEnv, runId, "none");
    }
    console.log(
      `live gmc run: status=${run.status} steps=${run.num_of_steps} (cap ${AGENT_MAX_STEPS}) ms=${Date.now() - started} run=${runId}`,
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.num_of_steps).toBeGreaterThan(0);
    expect(run.num_of_steps).toBeLessThanOrEqual(AGENT_MAX_STEPS + 1) // TinyFish has run one step past the cap;

    const outcome = gmc.parseAgentResult(run.result);
    expect(typeof outcome.blocked).toBe("boolean");
    expect(Array.isArray(outcome.variantsTried)).toBe(true);
    expect(Array.isArray(outcome.rows)).toBe(true);
    expect(outcome.resultsFound === null || Number.isInteger(outcome.resultsFound)).toBe(true);
    for (const row of outcome.rows) expect(typeof row.name).toBe("string");
    if (outcome.opened !== null) {
      expect(typeof outcome.opened.full_name === "string" || outcome.opened.licence_number !== null).toBe(true);
    }
  },
  240_000,
);
