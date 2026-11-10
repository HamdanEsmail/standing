// Opt-in live test: ONE real NMC Agent search by PIN. The PIN is given in the shell (STANDING_LIVE_NMC_PIN),
// so no registrant is named here. Runs only with STANDING_LIVE=1 (see tests/integration/gmc.live.test.ts for how the key is passed):
//
//   STANDING_LIVE=1 STANDING_LIVE_NMC_PIN=<a PIN> npx vitest run tests/integration/nmc.live.test.ts --reporter=verbose
//
// Cost: at most $0.19 (12 steps at $0.016). Every live call is logged in docs/build-log.md.
import { env } from "cloudflare:workers";
import { it } from "vitest";
import { nmc } from "../../src/registries/nmc";
import { liveKey, runLiveAgent } from "./live-agent";

it.skipIf(!liveKey || !env.LIVE_NMC_PIN)("runs one real NMC Agent search by PIN and reads a result of the expected shape", () => runLiveAgent(nmc, { variants: [], number: env.LIVE_NMC_PIN! }), 240_000);
