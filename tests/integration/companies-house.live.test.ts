// Opt-in live test: Companies House by Fetch only: ONE exact-name search (GREGGS PLC) and ONE company page (00502851), with the selectors production uses.
// Runs only with STANDING_LIVE=1 (see tests/integration/gmc.live.test.ts for how the key is passed):
//
//   STANDING_LIVE=1 npx vitest run tests/integration/companies-house.live.test.ts --reporter=verbose
//
// Cost: $0 (TinyFetch is free). Every live call is logged in docs/build-log.md.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { companiesHouse } from "../../src/registries/companies-house";
import { fetchPage } from "../../src/tinyfish/fetch";
import { liveKey } from "./live-agent";

it.skipIf(!liveKey)("reads one real search page and one company page of the expected shape", async () => {
  const liveEnv = { ...env, TINYFISH_API_KEY: liveKey! };
  const rows = await companiesHouse.fetchSearch(liveEnv, "GREGGS PLC");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((r) => r.name.length > 0 && r.number !== null)).toBe(true);
  const url = companiesHouse.recordUrl("00502851")!;
  const page = await fetchPage(liveEnv, url, "markdown");
  expect(page.ok).toBe(true);
  const parsed = page.ok ? companiesHouse.parseRecordPage(page.text, url) : null;
  expect(parsed?.full_name).toBeTruthy();
  expect(parsed?.status_raw).toBeTruthy();
}, 120_000);
