// When the register cannot be read: a check answers with the last result Standing read for the same
// question, labelled as stored with its real read time and the failed attempt, or ends as the error when
// nothing (or nothing still true) is stored.
import { env } from "cloudflare:workers";
import { fetchMock } from "./helpers/fetch-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeEvent } from "../src/monitoring/events";
import { companiesHouse } from "../src/registries/companies-house";
import chCompany from "./fixtures/registries/ch-company.md?raw";
import fetchChSearch from "./fixtures/tinyfish/fetch-ch-search.json";
import { callsTo, FETCH_API, freshState, getCheckJson, pageResponse, postCheck, restoreState, RUN_ASYNC_API } from "./helpers/checks";
import { callWith, textOf } from "./helpers/site";

beforeEach(freshState);
afterEach(restoreState);

const SEARCH_URL = companiesHouse.searchQueryUrl("Greggs plc");
const COMPANY_URL = "https://find-and-update.company-information.service.gov.uk/company/00502851";
const byName = { query: "Greggs plc", record_type: "company", jurisdiction: "GB" };
const DAYS_AGO = new Date(Date.now() - 3 * 86_400_000).toISOString();

/** One live name check that reads the search and the company page. */
async function liveMatch(): Promise<string> {
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: 2,
    reply: (_req, body) => {
      const url = (body as { urls: string[] }).urls[0];
      if (url === SEARCH_URL) return Response.json(fetchChSearch);
      if (url === COMPANY_URL) return Response.json(pageResponse(COMPANY_URL, chCompany));
      throw new Error(`unexpected read of ${url}`);
    },
  });
  const res = await postCheck(byName);
  return ((await res.json()) as { check_id: string }).check_id;
}

/** Ages every stored check past the 24-hour cache, so a new request reads the register. */
async function ageChecks(): Promise<void> {
  await env.DB.prepare("UPDATE checks SET checked_at = ?, started_at = ?").bind(DAYS_AGO, DAYS_AGO).run();
}

/** From now on the register answers every read with an HTTP error. */
function registerDown(): void {
  fetchMock.intercept({ method: "POST", url: FETCH_API, times: Infinity, reply: () => Response.json({ results: [], errors: [{ error: "target_http_error" }] }) });
}

async function post(body: Record<string, unknown>): Promise<{ id: string; json: Record<string, unknown> }> {
  const res = await postCheck(body);
  expect(res.status).toBe(202);
  const { check_id: id } = (await res.json()) as { check_id: string };
  return { id, json: await getCheckJson(id) };
}

describe("the last stored result when a register cannot be read", () => {
  it("a failed search with a stored match answers that match, cached, with its real read time and the failed attempt", async () => {
    const first = await liveMatch();
    await ageChecks();
    registerDown();
    const { id, json } = await post(byName);
    expect(id).not.toBe(first);
    expect(json).toMatchObject({
      outcome: "match",
      status: "active",
      full_name: "GREGGS PLC",
      cached: true,
      checked_at: DAYS_AGO,
      spend_usd: 0,
      live_read_failed: { error: "target_http_error", attempted_at: expect.any(String) },
    });
    expect((json.live_read_failed as { attempted_at: string }).attempted_at > DAYS_AGO).toBe(true);
    // It is a stored copy of the check that read it, and the record keeps that check as its latest.
    const row = await env.DB.prepare("SELECT cached_from_check_id FROM checks WHERE id = ?").bind(id).first<string>("cached_from_check_id");
    expect(row).toBe(first);
    const record = await (await callWith({}, `/api/records/${json.record_id}`)).json();
    expect(record).toMatchObject({ check_id: first });
    expect(record).not.toHaveProperty("live_read_failed");

    // The page and the receipt say it plainly, never "live".
    for (const path of [`/checks/${id}`, `/checks/${id}/receipt`]) {
      const text = textOf(await (await callWith({}, path)).text());
      expect(text, path).toMatch(/Companies House could not be read at \d+ \w{3} \d{4}, \d{2}:\d{2} UTC\. This is the last result Standing read\./);
      expect(text, path).not.toMatch(/· live\b/);
    }
    expect(textOf(await (await callWith({}, `/checks/${id}`)).text())).toContain("stored result");
  });

  it("with nothing stored, a failed search still ends as the error", async () => {
    registerDown();
    const { json } = await post(byName);
    expect(json).toMatchObject({ outcome: "error", error: "target_http_error", cached: false });
    expect(json).not.toHaveProperty("live_read_failed");
  });

  it("a stored match made stale by a later status change is never served", async () => {
    await liveMatch();
    await ageChecks();
    const recordId = await env.DB.prepare("SELECT id FROM records").first<string>("id");
    await writeEvent(env, { record_id: recordId!, kind: "status_change", after: { status: "dissolved" } });
    registerDown();
    const { json } = await post(byName);
    expect(json).toMatchObject({ outcome: "error", error: "target_http_error" });
  });

  it("Fresh check, when the register cannot be read, answers the stored result with the notice", async () => {
    const first = await liveMatch();
    registerDown();
    const { id, json } = await post({ ...byName, fresh: true });
    expect(id).not.toBe(first);
    expect(json).toMatchObject({ outcome: "match", cached: true, live_read_failed: { error: "target_http_error" } });
  });

  it("a number lookup of a watched record whose page cannot be read answers the record's last match, with no Agent run", async () => {
    await liveMatch();
    await env.DB.prepare("UPDATE records SET watched = 1").run();
    await ageChecks();
    registerDown();
    const { json } = await post({ number: "00502851", record_type: "company", jurisdiction: "GB" });
    expect(json).toMatchObject({ outcome: "match", licence_number: "00502851", cached: true, live_read_failed: { error: "target_http_error" } });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(0);
  });
});
