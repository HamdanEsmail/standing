// Opt-in live test: ONE real SRA Agent search by SRA number. The number is given in the shell (STANDING_LIVE_SRA_NUMBER),
// so no solicitor is named here. Runs only with STANDING_LIVE=1 (see tests/integration/gmc.live.test.ts for how the key is passed):
//
//   STANDING_LIVE=1 STANDING_LIVE_SRA_NUMBER=<an SRA number> npx vitest run tests/integration/sra.live.test.ts --reporter=verbose
//
// Cost: at most $0.19 (12 steps at $0.016). Every live call is logged in docs/build-log.md.
import { env } from "cloudflare:workers";
import { it } from "vitest";
import { sra } from "../../src/registries/sra";
import { liveKey, runLiveAgent } from "./live-agent";

it.skipIf(!liveKey || !env.LIVE_SRA_NUMBER)("runs one real SRA Agent search by SRA number and reads a result of the expected shape", () => runLiveAgent(sra, { variants: [], number: env.LIVE_SRA_NUMBER! }), 240_000);
