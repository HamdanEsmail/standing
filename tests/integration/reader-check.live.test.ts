// Opt-in live test: the daily reader check against the real registers. Three runs, one register each:
// Companies House (one page), the California DCA (one page) and Sunbiz (the name search and one page).
// Runs only with STANDING_LIVE=1 (see tests/integration/gmc.live.test.ts for how the key is passed):
//
//   STANDING_LIVE=1 npx vitest run tests/integration/reader-check.live.test.ts --reporter=verbose
//
// Cost: $0 (TinyFetch is free). Every live call is logged in docs/build-log.md.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { runReaderCheck } from "../../src/readerCheck";
import { liveKey } from "./live-agent";

it.skipIf(!liveKey)("finds each known business record, with its number, its name and a status, on the real registers", async () => {
  const liveEnv = { ...env, TINYFISH_API_KEY: liveKey! };
  const now = new Date();
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push(await runReaderCheck(liveEnv, now));
  console.log(JSON.stringify(rows.map((r) => [r?.registry, r?.outcome, r?.detail])));
  expect(rows.map((r) => [r?.registry, r?.outcome])).toEqual([
    ["companies-house", "understood"],
    ["ca-dca", "understood"],
    ["fl-sunbiz", "understood"],
  ]);
}, 180_000);
