// Opt-in live test: ONE real DCA Agent name search across boards for a business (Santa Fe Family Pharmacy, the pharmacy in tests/fixtures/registries/dca-record-pharmacy.md).
// Runs only with STANDING_LIVE=1 (see tests/integration/gmc.live.test.ts for how the key is passed):
//
//   STANDING_LIVE=1 npx vitest run tests/integration/ca-dca.live.test.ts --reporter=verbose
//
// Cost: at most $0.19 (12 steps at $0.016). Every live call is logged in docs/build-log.md.
import { it } from "vitest";
import { caDca } from "../../src/registries/ca-dca";
import { liveKey, runLiveAgent } from "./live-agent";

it.skipIf(!liveKey)("runs one real DCA Agent name search and reads a result of the expected shape", () => runLiveAgent(caDca, { variants: ["Santa Fe Family Pharmacy"], profession: "pharmacy" }), 240_000);
