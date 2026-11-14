// The daily reader check: one known business record on each register Standing reads with Fetch,
// read once a UTC day to see that Standing's own reader still understands the page.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { latestReaderChecks } from "../src/db/readerChecks";
import { KNOWN_RECORDS, runReaderCheck } from "../src/readerCheck";
import { flSunbiz, parseSearch } from "../src/registries/fl-sunbiz";
import chCompany from "./fixtures/registries/ch-company.md?raw";
import dcaPharmacy from "./fixtures/registries/dca-record-pharmacy.md?raw";
import flActive from "./fixtures/registries/fl-record-active.md?raw";
import flSearch from "./fixtures/registries/fl-search-publix.json";
import { callWorker } from "./helpers/app";
import { FETCH_API, freshState, restoreState, spendRows } from "./helpers/checks";
import { fetchMock } from "./helpers/fetch-mock";
import { textOf } from "./helpers/site";

beforeEach(freshState);
afterEach(restoreState);

const CH_URL = "https://find-and-update.company-information.service.gov.uk/company/00502851";
const DCA_URL = "https://search.dca.ca.gov/profile/7200/PHY/59020/";
const SUNBIZ_SEARCH = flSunbiz.searchQueryUrl!("PUBLIX ASSET MANAGEMENT COMPANY");
const SUNBIZ_RECORD = parseSearch(flSearch.text, flSearch.links).find((r) => r.number === "P01000027088")!.url!;
const MORNING = new Date("2026-11-14T00:15:00Z");
const hourLater = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

type Answer = { text: string; links?: string[] } | { error: string };

/** Answers each TinyFetch read from `pages` by the URL it asks for, and records the URLs asked. */
function registers(pages: Record<string, Answer>): string[] {
  const asked: string[] = [];
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const url = (body as { urls?: string[] }).urls?.[0] ?? "";
      asked.push(url);
      const page = pages[url];
      if (page === undefined) throw new Error(`unexpected TinyFetch read of ${url}`);
      if ("error" in page) return Response.json({ results: [], errors: [{ url, error: page.error }] });
      return Response.json({ results: [{ url, final_url: url, title: null, text: page.text, links: page.links ?? [] }], errors: [] });
    },
  });
  return asked;
}

const allGood = (): Record<string, Answer> => ({
  [CH_URL]: { text: chCompany },
  [DCA_URL]: { text: dcaPharmacy },
  [SUNBIZ_SEARCH]: { text: flSearch.text, links: flSearch.links },
  [SUNBIZ_RECORD]: { text: flActive },
});

const tableCounts = async () => {
  const counts: Record<string, number> = {};
  for (const table of ["checks", "records", "events", "watches"]) {
    counts[table] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  }
  return counts;
};

describe("the daily reader check", () => {
  it("knows three business records, one on each register Standing reads with Fetch, and no person", () => {
    expect(KNOWN_RECORDS.map((k) => [k.registry, k.name, k.number])).toEqual([
      ["companies-house", "GREGGS PLC", "00502851"],
      ["ca-dca", "SANTA FE FAMILY PHARMACY", "59020"],
      ["fl-sunbiz", "PUBLIX ASSET MANAGEMENT COMPANY", "P01000027088"],
    ]);
  });

  it("reads one register a run, and finds the record's number, name and a status: understood", async () => {
    const asked = registers(allGood());
    const row = await runReaderCheck(env, MORNING);
    expect(asked).toEqual([CH_URL]);
    expect(row).toMatchObject({ registry: "companies-house", day: "2026-11-14", outcome: "understood", detail: "Active", source_url: CH_URL });
    expect(row?.started_at).toBe(MORNING.toISOString());
    expect(row?.finished_at).not.toBeNull();
    expect(await latestReaderChecks(env.DB)).toEqual([row]);
  });

  it("checks each register once a UTC day, in order, and then reads nothing until the next day", async () => {
    const asked = registers(allGood());
    const outcomes = [];
    for (let h = 0; h < 5; h++) outcomes.push((await runReaderCheck(env, hourLater(MORNING, h)))?.registry ?? null);
    expect(outcomes).toEqual(["companies-house", "ca-dca", "fl-sunbiz", null, null]);
    // Sunbiz is read the way a lookup reads it: the name search, then the row's own page.
    expect(asked).toEqual([CH_URL, DCA_URL, SUNBIZ_SEARCH, SUNBIZ_RECORD]);
    const latest = await latestReaderChecks(env.DB);
    expect(latest.map((r) => [r.registry, r.outcome, r.detail])).toEqual([
      ["companies-house", "understood", "Active"],
      ["ca-dca", "understood", "CLEAR"],
      ["fl-sunbiz", "understood", "ACTIVE"],
    ]);
    expect((await runReaderCheck(env, new Date("2026-11-15T00:15:00Z")))?.registry).toBe("companies-house");
    expect((await latestReaderChecks(env.DB)).find((r) => r.registry === "companies-house")?.day).toBe("2026-11-15");
  });

  it("says the register did not answer, with Fetch's own code, and does not try that register again the same day", async () => {
    const pages = allGood();
    pages[CH_URL] = { error: "target_unreachable" };
    const asked = registers(pages);
    expect(await runReaderCheck(env, MORNING)).toMatchObject({ registry: "companies-house", outcome: "no_answer", detail: "target_unreachable" });
    expect((await runReaderCheck(env, hourLater(MORNING, 1)))?.registry).toBe("ca-dca");
    expect(asked.filter((u) => u === CH_URL)).toHaveLength(1);
  });

  it("says the page was read but not understood when the number, the name or a status is not where the reader looks", async () => {
    const pages = allGood();
    pages[CH_URL] = { text: chCompany.replaceAll("00502851", "00999999") };
    pages[DCA_URL] = { text: dcaPharmacy.replace(/License Status: CLEAR\r?\n/, "") };
    pages[SUNBIZ_SEARCH] = { text: "# Search results\n\nNo records found.", links: [] };
    registers(pages);
    expect(await runReaderCheck(env, MORNING)).toMatchObject({ outcome: "not_understood", detail: "the page shows another number" });
    expect(await runReaderCheck(env, hourLater(MORNING, 1))).toMatchObject({ outcome: "not_understood", detail: "the page shows no status" });
    expect(await runReaderCheck(env, hourLater(MORNING, 2))).toMatchObject({ outcome: "not_understood", detail: "the search no longer lists the record" });
  });

  it("is a check on Standing's own readers: no lookup, record, event or watch is written, and nothing is stored as evidence", async () => {
    registers(allGood());
    const before = await tableCounts();
    for (let h = 0; h < 3; h++) await runReaderCheck(env, hourLater(MORNING, h));
    expect(await tableCounts()).toEqual(before);
    expect((await env.STORE.list()).objects).toEqual([]);
    // Each Fetch call is in the spend ledger like every other TinyFish call, at $0.
    expect((await spendRows()).map((r) => [r.kind, r.amount_usd])).toEqual([
      ["fetch", 0],
      ["fetch", 0],
      ["fetch", 0],
      ["fetch", 0],
    ]);
  });

  it("is shown on /api/stats, beside each register in /api/registries, and on the coverage page, which says why three registers are not in it", async () => {
    registers(allGood());
    const empty = textOf(await (await callWorker("/coverage")).text());
    expect(empty).toContain("Reader check: GREGGS PLC (00502851), not run yet");

    for (let h = 0; h < 2; h++) await runReaderCheck(env, hourLater(MORNING, h));
    const stats = (await (await callWorker("/api/stats")).json()) as { reader_checks: unknown[] };
    expect(stats.reader_checks).toEqual([
      expect.objectContaining({ registry: "companies-house", record: "GREGGS PLC (00502851)", outcome: "understood", day: "2026-11-14" }),
      expect.objectContaining({ registry: "ca-dca", record: "SANTA FE FAMILY PHARMACY (59020)", outcome: "understood", day: "2026-11-14" }),
      expect.objectContaining({ registry: "fl-sunbiz", record: "PUBLIX ASSET MANAGEMENT COMPANY (P01000027088)", outcome: null, day: null }),
    ]);
    const coverage = (await (await callWorker("/api/registries")).json()) as { registries: { id: string; reader_check: unknown }[] };
    const of = (id: string) => coverage.registries.find((r) => r.id === id)!.reader_check;
    expect(of("companies-house")).toMatchObject({ record: "GREGGS PLC (00502851)", outcome: "understood", detail: "Active" });
    expect(of("fl-sunbiz")).toMatchObject({ record: "PUBLIX ASSET MANAGEMENT COMPANY (P01000027088)", outcome: null });
    expect(of("gmc")).toBeNull();

    const text = textOf(await (await callWorker("/coverage")).text());
    expect(text).toContain("Reader check: GREGGS PLC (00502851) read and understood, 14 Nov 2026");
    expect(text).toContain("Reader check: PUBLIX ASSET MANAGEMENT COMPANY (P01000027088), not run yet");
    expect(text).toContain("Not in the reader check: its pages are doctors' own records");
    expect(text).toContain("Not in the reader check: it is read only by the Agent");
    expect(text).toContain("it changes no record, raises no event and touches no watch");
    expect(text).not.toContain("never reads again");
  });

  it("runs at the end of the hourly job, after the job's own work", async () => {
    registers(allGood());
    fetchMock.intercept({ method: "GET", url: "https://agent.tinyfish.ai/v1/monitors", reply: { json: { monitors: [] } } });
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "15 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    const asked = fetchMock.calls.map((c) => `${c.method} ${c.url}`);
    expect(asked).toEqual(["GET https://agent.tinyfish.ai/v1/monitors", `POST ${FETCH_API}`]);
    expect((await latestReaderChecks(env.DB)).map((r) => [r.registry, r.outcome])).toEqual([["companies-house", "understood"]]);
  });

  it("a check that was started and never finished stays as it is: it is not tried again that day", async () => {
    await env.DB.prepare("INSERT INTO reader_checks (registry, day, started_at) VALUES ('companies-house', '2026-11-14', '2026-11-14T00:15:00.000Z')").run();
    const asked = registers(allGood());
    expect((await runReaderCheck(env, hourLater(MORNING, 1)))?.registry).toBe("ca-dca");
    expect(asked).toEqual([DCA_URL]);
    expect((await latestReaderChecks(env.DB))[0]).toMatchObject({ registry: "companies-house", outcome: "started", finished_at: null });
  });
});
