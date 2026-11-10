// Opt-in live test: ONE real CSLB Agent search by licence number (738180, the business licence the 3 Nov probes used), starting at CheckLicense.aspx and reading the licence page in the same run.
// Runs only with STANDING_LIVE=1 (see tests/integration/gmc.live.test.ts for how the key is passed):
//
//   STANDING_LIVE=1 npx vitest run tests/integration/cslb.live.test.ts --reporter=verbose
//
// Cost: at most $0.19 (12 steps at $0.016). Every live call is logged in docs/build-log.md.
import { expect, it } from "vitest";
import { cslb } from "../../src/registries/cslb";
import { liveKey, runLiveAgent } from "./live-agent";

it.skipIf(!liveKey)("runs one real CSLB Agent search by licence number and reads a result of the expected shape", async () => {
  await runLiveAgent(cslb, { variants: [], number: "738180" });
  expect(cslb.goal({ variants: [], number: "738180" })).toContain("CheckLicense.aspx");
}, 240_000);
