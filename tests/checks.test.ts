import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePerson, variantsFor } from "../src/core/names";
import { PUBLIC_CHECKS_PER_IP_PER_DAY } from "../src/core/limits";
import { insertCheck } from "../src/db/checks";
import { companiesHouse } from "../src/registries/companies-house";
import { gmc } from "../src/registries/gmc";
import { SUPPORTED } from "../src/registries/index";
import agentAmbiguous from "./fixtures/registries/gmc-agent-result-ambiguous.json";
import chCompany from "./fixtures/registries/ch-company.md?raw";
import gmcConditionsPlain from "./fixtures/registries/gmc-record-conditions-plain.md?raw";
import fetchChSearch from "./fixtures/tinyfish/fetch-ch-search.json";
import fetchGmcRecord from "./fixtures/tinyfish/fetch-gmc-record.json";
import fetchSelectorNotMatched from "./fixtures/tinyfish/fetch-selector-not-matched.json";
import gmcAgentRun from "./fixtures/tinyfish/gmc-agent-run.json";
import { callWorker } from "./helpers/app";
import {
  AGENT_CALLBACK,
  agentCallback,
  callsTo,
  completedRun,
  count,
  FETCH_API,
  freshState,
  getCheckJson,
  GMC_URL,
  JPEG,
  mockFetchPages,
  mockGetRun,
  mockStartRun,
  mockStepShot,
  pageResponse,
  postCheck,
  restoreState,
  RUN_ASYNC_API,
  shot,
  slotRow,
  spendRows,
  startAgentCheck,
} from "./helpers/checks";
import { fetchMock } from "./helpers/fetch-mock";

const WICKFOLD_RUN = gmcAgentRun.run_id;
/** The step the evidence screenshot comes from: the last one on the doctor's details page. */
const WICKFOLD_EVIDENCE_STEP = "76536869-6e99-452d-8f9d-ff34fc28ca3e";
const GMC_RECORD_TEXT = fetchGmcRecord.results[0]!.text;
const CH_COMPANY_URL = "https://find-and-update.company-information.service.gov.uk/company/00502851";

beforeEach(freshState);
afterEach(restoreState);

async function bytesOf(key: string): Promise<{ bytes: Uint8Array; type: string | undefined } | null> {
  const object = await env.STORE.get(key);
  if (object === null) return null;
  return { bytes: new Uint8Array(await object.arrayBuffer()), type: object.httpMetadata?.contentType };
}

/** Everything a duplicate or unknown callback must leave alone. */
async function snapshot() {
  const checks = await env.DB.prepare("SELECT * FROM checks ORDER BY id").all();
  const records = await env.DB.prepare("SELECT * FROM records ORDER BY id").all();
  const candidates = await env.DB.prepare("SELECT * FROM candidates ORDER BY check_id, position").all();
  return { checks: checks.results, records: records.results, candidates: candidates.results, spend: await spendRows(), slot: await slotRow() };
}

/** The Wickfold match run resolved through the callback: the run, the record page and the evidence step. */
async function resolveDoctorMatch(checkFinishedAt?: string): Promise<string> {
  const id = await startAgentCheck("Christopher Wickfold", WICKFOLD_RUN);
  mockGetRun(WICKFOLD_RUN, checkFinishedAt === undefined ? gmcAgentRun : { ...gmcAgentRun, finished_at: checkFinishedAt });
  mockFetchPages({ [GMC_URL]: fetchGmcRecord });
  mockStepShot(WICKFOLD_RUN, WICKFOLD_EVIDENCE_STEP);
  const res = await agentCallback({ run_id: WICKFOLD_RUN, status: "COMPLETED" });
  expect(res.status).toBe(200);
  return id;
}

describe("POST /api/checks", () => {
  it("POST /api/checks with unsupported type returns 400 and the supported list", async () => {
    const res = await postCheck({ query: "Jo Example", record_type: "solicitor", jurisdiction: "US-CA" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported", supported: SUPPORTED });
    // Nothing stored, nothing counted against the visitor, nothing called.
    expect(await count("checks")).toBe(0);
    expect(await count("public_use")).toBe(0);
    expect(fetchMock.calls).toEqual([]);
  });

  it("number path for a doctor reads the record page with Fetch, stores markdown and screenshot evidence, outcome match, method fetch", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: (_req, body) => {
        expect(body).toMatchObject({ urls: [GMC_URL], format: "markdown", include_selectors: ["[role='main']"] });
        return Response.json(fetchGmcRecord);
      },
    });
    const before = new Date().toISOString();
    const res = await postCheck({ number: "9360749", record_type: "doctor", jurisdiction: "GB" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { check_id: string };
    expect(body).toEqual({ check_id: expect.any(String), status: "done", cached: false, estimated_cost_usd: 0.002 });
    const id = body.check_id;

    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({
      check_id: id,
      registry: "gmc",
      outcome: "match",
      status: "active",
      status_raw: "Registered with a licence to practise",
      full_name: "Christopher John Marlow WICKFOLD",
      licence_number: "9360749",
      specialties: ["Infectious diseases", "Tropical medicine"],
      registered_since: "1992-08-01",
      method: "fetch",
      cached: false,
      source_url: GMC_URL,
      evidence_screenshot_url: `https://standing.test/evidence/${id}.jpg`,
      spend_usd: 0.002,
      variants_tried: [],
    });
    expect(rec.checked_at as string >= before).toBe(true);

    const md = await bytesOf(`evidence/${id}.md`);
    expect(new TextDecoder().decode(md!.bytes)).toBe(GMC_RECORD_TEXT);
    expect(md!.type).toMatch(/^text\/markdown/);
    const jpg = await bytesOf(`evidence/${id}.jpg`);
    expect(jpg).toEqual({ bytes: JPEG, type: "image/jpeg" });
    expect(shot).toHaveBeenCalledTimes(1);
    expect(shot.mock.calls[0]![1]).toBe(GMC_URL);
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(0);
    // The record is stored with the evidence key.
    const stored = await env.DB.prepare("SELECT licence_number, status, evidence_key FROM records").first();
    expect(stored).toEqual({ licence_number: "9360749", status: "active", evidence_key: `evidence/${id}.jpg` });
  });

  it("name path starts one Agent run with the adapter goal and the callback url; check is pending", async () => {
    mockStartRun("run-wickfold-1");
    const res = await postCheck({ query: "Dr Christopher Wickfold", record_type: "doctor", jurisdiction: "GB" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { check_id: string };
    expect(body).toEqual({ check_id: expect.any(String), status: "pending", cached: false, estimated_cost_usd: 0.208 });

    const starts = callsTo("POST", RUN_ASYNC_API);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.body).toEqual({
      url: gmc.searchUrl,
      goal: gmc.goal({ variants: variantsFor(normalizePerson("Christopher Wickfold"), true) }),
      browser_profile: "lite",
      agent_config: { max_steps: 12, max_duration_seconds: 160 },
      output_schema: gmc.outputSchema,
      webhook_url: AGENT_CALLBACK,
    });

    expect(await getCheckJson(body.check_id)).toEqual({
      status: "pending",
      started_at: expect.any(String),
      run_id: "run-wickfold-1",
      queued: false,
    });
    expect((await slotRow()).holder_check_id).toBe(body.check_id);
  });

  it("a second identical check within 24h is served from cache with cached:true and the original checked_at; fresh:true starts a new run", async () => {
    const readAnHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const first = await resolveDoctorMatch(readAnHourAgo);
    const original = await getCheckJson(first);
    expect(original).toMatchObject({ outcome: "match", cached: false, checked_at: readAnHourAgo });

    const res = await postCheck({ query: "christopher  WICKFOLD", record_type: "doctor", jurisdiction: "GB" });
    expect(res.status).toBe(202);
    const hit = (await res.json()) as { check_id: string };
    expect(hit).toEqual({ check_id: expect.any(String), status: "done", cached: true, estimated_cost_usd: 0 });
    expect(hit.check_id).not.toBe(first);
    const cached = await getCheckJson(hit.check_id);
    expect(cached).toMatchObject({
      check_id: hit.check_id,
      outcome: "match",
      status: "active",
      cached: true,
      checked_at: readAnHourAgo,
      licence_number: "9360749",
      evidence_screenshot_url: `https://standing.test/evidence/${first}.jpg`,
      spend_usd: 0,
    });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    expect((await spendRows()).filter((r) => r.kind === "agent_step")).toHaveLength(1);

    // fresh: true skips the cache, starts a new run and says what it will cost.
    mockStartRun("run-wickfold-2");
    const freshRes = await postCheck({ query: "Christopher Wickfold", record_type: "doctor", jurisdiction: "GB", fresh: true });
    const fresh = (await freshRes.json()) as { check_id: string };
    expect(fresh).toEqual({ check_id: expect.any(String), status: "pending", cached: false, estimated_cost_usd: 0.208 });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(2);

    mockGetRun("run-wickfold-2", { ...gmcAgentRun, run_id: "run-wickfold-2", finished_at: new Date().toISOString() });
    mockFetchPages({ [GMC_URL]: fetchGmcRecord });
    mockStepShot("run-wickfold-2", WICKFOLD_EVIDENCE_STEP);
    expect((await agentCallback({ run_id: "run-wickfold-2", status: "COMPLETED" })).status).toBe(200);
    const freshRecord = await getCheckJson(fresh.check_id);
    expect(freshRecord).toMatchObject({ outcome: "match", cached: false });
    expect(freshRecord.checked_at as string > readAnHourAgo).toBe(true);
    const steps = (await spendRows()).filter((r) => r.kind === "agent_step");
    expect(steps.map((r) => r.ref)).toEqual([first, fresh.check_id]);
  });

  it("one public check past the daily allowance from the same ip is 429 daily_limit", async () => {
    // A finished check to serve from cache, so the allowed checks cost nothing.
    await insertCheck(env.DB, {
      registry: "gmc",
      record_type: "doctor",
      jurisdiction: "GB",
      query_raw: "Ada Fictitious",
      query_normalized: "ada fictitious",
      cache_key: "gmc|doctor||ada fictitious",
      state: "done",
      outcome: "no_match",
      method: "agent",
      variants_tried: ["ada fictitious", "fictitious a", "fictitious"],
      checked_at: new Date(Date.now() - 600_000).toISOString(),
    });
    const ask = { query: "Ada Fictitious", record_type: "doctor", jurisdiction: "GB" };
    for (let i = 0; i < PUBLIC_CHECKS_PER_IP_PER_DAY; i++) expect((await postCheck(ask, { ip: "203.0.113.9" })).status).toBe(202);
    const over = await postCheck(ask, { ip: "203.0.113.9" });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "daily_limit" });
    // Another visitor, and the admin, are not limited by it.
    expect((await postCheck(ask, { ip: "203.0.113.10" })).status).toBe(202);
    expect((await postCheck(ask, { ip: "203.0.113.9", admin: true })).status).toBe(202);
    // The IP is never stored in the clear.
    const hashes = await env.DB.prepare("SELECT DISTINCT ip_hash FROM public_use").all<{ ip_hash: string }>();
    for (const { ip_hash } of hashes.results) expect(ip_hash).toMatch(/^[0-9a-f]{64}$/);
    const who = await env.DB.prepare("SELECT added_by, COUNT(*) AS n FROM checks WHERE cached_from_check_id IS NOT NULL GROUP BY added_by ORDER BY added_by").all();
    expect(who.results).toEqual([{ added_by: "admin", n: 1 }, { added_by: "public", n: PUBLIC_CHECKS_PER_IP_PER_DAY + 1 }]);
  });

  it("company name check uses Fetch search, matches the single exact-name row and reads the company page", async () => {
    const searchUrl = companiesHouse.searchQueryUrl("Greggs plc");
    const reads: unknown[] = [];
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      times: 2,
      reply: (_req, body) => {
        reads.push(body);
        const url = (body as { urls: string[] }).urls[0];
        if (url === searchUrl) return Response.json(fetchChSearch);
        if (url === CH_COMPANY_URL) return Response.json(pageResponse(CH_COMPANY_URL, chCompany));
        throw new Error(`unexpected read of ${url}`);
      },
    });
    const res = await postCheck({ query: "Greggs plc", record_type: "company", jurisdiction: "GB" });
    expect(res.status).toBe(202);
    const { check_id: id } = (await res.json()) as { check_id: string };
    expect(reads).toEqual([
      expect.objectContaining({ urls: [searchUrl], include_selectors: ["#results"] }),
      expect.objectContaining({ urls: [CH_COMPANY_URL] }),
    ]);

    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({
      registry: "companies-house",
      record_type: "company",
      outcome: "match",
      status: "active",
      status_raw: "Active",
      full_name: "GREGGS PLC",
      licence_number: "00502851",
      registered_since: "1951-12-29",
      method: "fetch",
      source_url: CH_COMPANY_URL,
      evidence_screenshot_url: `https://standing.test/evidence/${id}.jpg`,
      variants_tried: ["Greggs plc"],
      candidates: [],
      spend_usd: 0.002,
    });
    expect(shot.mock.calls[0]![1]).toBe(CH_COMPANY_URL);
    expect(new TextDecoder().decode((await bytesOf(`evidence/${id}.md`))!.bytes)).toBe(chCompany);
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(0);
  });
});

describe("POST /hooks/agent/:secret", () => {
  it("agent callback with the real match fixture resolves to match, stores evidence from the record-page step, checked_at = finished_at, spend = steps x 0.016", async () => {
    const id = await resolveDoctorMatch();
    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({
      outcome: "match",
      status: "active",
      status_raw: "Registered with a licence to practise",
      // The record page's fields are preferred over the Agent's.
      full_name: "Christopher John Marlow WICKFOLD",
      licence_number: "9360749",
      specialties: ["Infectious diseases", "Tropical medicine"],
      method: "agent",
      cached: false,
      source_url: GMC_URL,
      checked_at: "2026-11-03T09:22:34.000Z",
      evidence_screenshot_url: `https://standing.test/evidence/${id}.jpg`,
      // The recorded run reports no variants, so these are the ones the goal asked for.
      variants_tried: variantsFor(normalizePerson("Christopher Wickfold"), true),
    });
    expect(rec.spend_usd as number).toBeCloseTo(8 * 0.016, 10);

    const downloads = fetchMock.calls.filter((c) => c.url.includes("/steps/"));
    expect(downloads.map((c) => c.url)).toEqual([
      `https://agent.tinyfish.ai/v1/runs/${WICKFOLD_RUN}/steps/${WICKFOLD_EVIDENCE_STEP}/screenshot`,
    ]);
    expect(await bytesOf(`evidence/${id}.jpg`)).toEqual({ bytes: JPEG, type: "image/jpeg" });
    // No TinyBrowser screenshot when the run had one.
    expect(shot).not.toHaveBeenCalled();
    // The run was read with step screenshots.
    expect(fetchMock.calls.some((c) => c.url.startsWith(`https://agent.tinyfish.ai/v1/runs/${WICKFOLD_RUN}?screenshots=url`))).toBe(true);

    const steps = (await spendRows()).filter((r) => r.kind === "agent_step");
    expect(steps).toHaveLength(1);
    expect(steps[0]!.amount_usd).toBeCloseTo(0.128, 10);
    expect(steps[0]!.ref).toBe(id);
    // The slot is free again.
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
  });

  it("agent callback with the two-row fixture resolves to ambiguous with both candidates and no status", async () => {
    const id = await startAgentCheck("Syeda Sickfold", "run-amb");
    mockGetRun("run-amb", completedRun("run-amb", agentAmbiguous));
    expect((await agentCallback({ run_id: "run-amb", status: "COMPLETED" })).status).toBe(200);

    const rec = await getCheckJson(id);
    expect(rec.outcome).toBe("ambiguous");
    expect(rec).not.toHaveProperty("status");
    expect(rec).not.toHaveProperty("status_raw");
    expect(rec).toMatchObject({
      candidates_total: 2,
      how_to_resolve: "Repeat the check with number=<…>",
      variants_tried: ["syeda sickfold"],
      method: "agent",
      full_name: null,
      licence_number: null,
      evidence_screenshot_url: null,
    });
    expect(rec.candidates).toEqual([
      { licence_number: null, full_name: "Syeda Varisha Amira SICKFOLD", status_raw: "Registered with a licence to practise", detail: null, source_url: null },
      { licence_number: null, full_name: "Syeda Humaira SICKFOLD", status_raw: "Registered without a licence to practise", detail: null, source_url: null },
    ]);
    expect(rec.spend_usd as number).toBeCloseTo(9 * 0.016, 10);
    expect(await count("records")).toBe(0);
  });

  it("agent callback with one row whose name fails the match rule (query 'Christopher Wickfold', row 'Christine WICKFOLD') resolves to ambiguous with that one candidate, candidates_total 1, how_to_resolve, no status", async () => {
    const id = await startAgentCheck("Christopher Wickfold", "run-one-row");
    const result = {
      blocked: false,
      results_found: 1,
      variants_tried: ["christopher wickfold", "wickfold c"],
      rows: [{ name: "Christine WICKFOLD", number: null, status: "Registered with a licence to practise", specialty: null }],
      full_name: null,
      gmc_number: null,
      status: null,
      entry_url: null,
      sanctions_text: null,
    };
    mockGetRun("run-one-row", completedRun("run-one-row", result));
    expect((await agentCallback({ run_id: "run-one-row", status: "COMPLETED" })).status).toBe(200);

    const rec = await getCheckJson(id);
    expect(rec.outcome).toBe("ambiguous");
    expect(rec).not.toHaveProperty("status");
    expect(rec).not.toHaveProperty("status_raw");
    expect(rec).toMatchObject({
      candidates_total: 1,
      how_to_resolve: "Repeat the check with number=<…>",
      variants_tried: ["christopher wickfold", "wickfold c"],
      candidates: [
        { licence_number: null, full_name: "Christine WICKFOLD", status_raw: "Registered with a licence to practise", detail: null, source_url: null },
      ],
    });
  });

  it("callback for an unknown run_id, and a duplicate callback, are 200 no-ops", async () => {
    const unknown = await agentCallback({ run_id: "run-nobody-started", status: "COMPLETED" });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true, ignored: true });
    expect(fetchMock.calls).toEqual([]);
    expect(await count("checks")).toBe(0);
    expect(await count("spend")).toBe(0);

    await resolveDoctorMatch();
    const before = await snapshot();
    const callsBefore = fetchMock.calls.length;

    const duplicate = await agentCallback({ run_id: WICKFOLD_RUN, status: "COMPLETED", num_of_steps: 8 });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true, ignored: true });
    expect(fetchMock.calls.length).toBe(callsBefore);
    expect(await snapshot()).toEqual(before);
  });
});

describe("edge cases: input, number fallback, Agent results, spend, evidence, callback_url", () => {
  it("a missing query and number, or a name that is only a title, is 400 invalid_query and costs nothing", async () => {
    for (const body of [
      { record_type: "doctor", jurisdiction: "GB" },
      { query: "   ", record_type: "doctor", jurisdiction: "GB" },
      { query: "Dr", record_type: "doctor", jurisdiction: "GB" },
    ]) {
      const res = await postCheck(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_query", detail: expect.any(String) });
    }
    const notJson = await postCheck("{not json");
    expect(notJson.status).toBe(400);
    expect(await count("checks")).toBe(0);
    expect(await count("public_use")).toBe(0);
    expect(fetchMock.calls).toEqual([]);
  });

  it("a number path whose record page cannot be read queues one Agent run that searches by the number, and resolves by number", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchSelectorNotMatched } });
    mockStartRun("run-by-number");
    const res = await postCheck({ number: "9360749", record_type: "doctor", jurisdiction: "GB" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { check_id: string };
    expect(body).toMatchObject({ status: "pending", estimated_cost_usd: 0.208 });
    const id = body.check_id;
    const starts = callsTo("POST", RUN_ASYNC_API);
    expect(starts).toHaveLength(1);
    expect((starts[0]!.body as { goal: string }).goal).toBe(gmc.goal({ variants: [], number: "9360749" }));
    expect(await getCheckJson(id)).toMatchObject({ status: "pending", run_id: "run-by-number", queued: false });
    expect(shot).not.toHaveBeenCalled();

    // The run lists two rows; only the one whose number is the input number is the match.
    const result = {
      blocked: false,
      results_found: 2,
      variants_tried: [],
      rows: [
        { name: "Bo IMAGINARY", number: "99000003", status: "Registered with a licence to practise", specialty: null },
        { name: "Christopher John Marlow WICKFOLD", number: "9360749", status: "Registered with a licence to practise", specialty: null },
      ],
    };
    mockGetRun("run-by-number", completedRun("run-by-number", result, { num_of_steps: 6 }));
    mockFetchPages({ [GMC_URL]: fetchGmcRecord });
    expect((await agentCallback({ run_id: "run-by-number", status: "COMPLETED" })).status).toBe(200);
    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({ outcome: "match", status: "active", licence_number: "9360749", method: "agent", variants_tried: [] });
    // The run had no step screenshots, so the record page was screenshotted instead.
    expect(shot.mock.calls.map((c) => c[1])).toEqual([GMC_URL]);
    expect(rec.evidence_screenshot_url).toBe(`https://standing.test/evidence/${id}.jpg`);
    expect(rec.spend_usd as number).toBeCloseTo(6 * 0.016 + 0.002, 10);
  });

  it("a number search with no row of that number is no_match with the adapter's suggestions", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchSelectorNotMatched } });
    mockStartRun("run-wrong-number");
    const res = await postCheck({ number: "99000002", record_type: "doctor", jurisdiction: "GB" });
    const { check_id: id } = (await res.json()) as { check_id: string };
    const result = { blocked: false, results_found: 1, rows: [{ name: "Bo IMAGINARY", number: "99000003", status: null, specialty: null }] };
    mockGetRun("run-wrong-number", completedRun("run-wrong-number", result));
    await agentCallback({ run_id: "run-wrong-number", status: "COMPLETED" });
    const rec = await getCheckJson(id);
    expect(rec.outcome).toBe("no_match");
    expect(rec).not.toHaveProperty("status");
    expect(rec.suggestions).toEqual(gmc.noMatchSuggestions);
  });

  it("a name search whose run listed fewer rows than it found is never a match: ambiguous with candidates_total = results_found", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-truncated");
    const result = {
      blocked: false,
      results_found: 3,
      variants_tried: ["ada fictitious"],
      rows: [{ name: "Ada FICTITIOUS", number: "99000001", status: "Registered with a licence to practise", specialty: null }],
      full_name: "Ada FICTITIOUS",
      gmc_number: "99000001",
      status: "Registered with a licence to practise",
      entry_url: "https://www.gmc-uk.org/registrants/99000001",
      sanctions_text: null,
    };
    mockGetRun("run-truncated", completedRun("run-truncated", result));
    await agentCallback({ run_id: "run-truncated", status: "COMPLETED" });
    const rec = await getCheckJson(id);
    expect(rec.outcome).toBe("ambiguous");
    expect(rec).not.toHaveProperty("status");
    expect(rec).toMatchObject({
      candidates_total: 3,
      candidates: [expect.objectContaining({ full_name: "Ada FICTITIOUS", licence_number: "99000001" })],
    });
    expect(await count("records")).toBe(0);
  });

  it("a run that found rows but listed none is error incomplete_agent_result, never no_match; a blocked run is error blocked", async () => {
    const incomplete = await startAgentCheck("Ada Fictitious", "run-incomplete");
    mockGetRun("run-incomplete", completedRun("run-incomplete", { blocked: false, results_found: 2, rows: [] }));
    await agentCallback({ run_id: "run-incomplete", status: "COMPLETED" });
    expect(await getCheckJson(incomplete)).toMatchObject({ outcome: "error", error: "incomplete_agent_result" });

    const blocked = await startAgentCheck("Bo Imaginary", "run-blocked");
    mockGetRun(
      "run-blocked",
      completedRun("run-blocked", { blocked: true, block_message: "Access denied, see https://blocked.example/why", rows: [] }),
    );
    await agentCallback({ run_id: "run-blocked", status: "COMPLETED" });
    const rec = await getCheckJson(blocked);
    expect(rec).toMatchObject({ outcome: "error", error: "blocked" });
    expect(rec).not.toHaveProperty("status");
  });

  it("a FAILED run is error with a shaped code only, billed once for its steps, and frees the slot", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-failed");
    const res = await agentCallback({
      run_id: "run-failed",
      status: "FAILED",
      num_of_steps: 3,
      error: { message: "Page said: Ada Fictitious is not on <b>this</b> register", code: "Navigation failed!" },
    });
    expect(res.status).toBe(200);
    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({ outcome: "error", error: "agent_failed", method: "agent" });
    expect(JSON.stringify(rec)).not.toContain("Page said");
    expect(rec.spend_usd as number).toBeCloseTo(0.048, 10);
    expect((await spendRows()).filter((r) => r.kind === "agent_step")).toHaveLength(1);
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });

    // A callback whose status is not terminal changes nothing.
    const other = await startAgentCheck("Bo Imaginary", "run-running");
    const running = await agentCallback({ run_id: "run-running", status: "RUNNING" });
    expect(running.status).toBe(200);
    expect(await getCheckJson(other)).toMatchObject({ status: "pending", run_id: "run-running" });
  });

  it("a wrong secret is 404", async () => {
    const res = await agentCallback({ run_id: "anything", status: "COMPLETED" }, "not-the-secret");
    expect(res.status).toBe(404);
  });

  it("at the spend pause a check that would spend is 503 spend_paused, while a cache hit is still served", async () => {
    await env.DB.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('big', 'agent_step', 8, 'earlier', ?)")
      .bind(new Date().toISOString())
      .run();
    const paused = await postCheck({ query: "Ada Fictitious", record_type: "doctor", jurisdiction: "GB" });
    expect(paused.status).toBe(503);
    expect(await paused.json()).toEqual({ error: "spend_paused" });
    const pausedNumber = await postCheck({ number: "9360749", record_type: "doctor", jurisdiction: "GB" });
    expect(pausedNumber.status).toBe(503);
    expect(fetchMock.calls).toEqual([]);

    await insertCheck(env.DB, {
      registry: "gmc",
      record_type: "doctor",
      jurisdiction: "GB",
      cache_key: "gmc|doctor||ada fictitious",
      state: "done",
      outcome: "no_match",
      method: "agent",
      checked_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const hit = await postCheck({ query: "Ada Fictitious", record_type: "doctor", jurisdiction: "GB" });
    expect(hit.status).toBe(202);
    expect(await hit.json()).toMatchObject({ status: "done", cached: true });
  });

  it("an ambiguous cached copy carries the original's candidates", async () => {
    const original = await startAgentCheck("Syeda Sickfold", "run-amb-cache");
    mockGetRun("run-amb-cache", completedRun("run-amb-cache", agentAmbiguous, { finished_at: new Date().toISOString() }));
    await agentCallback({ run_id: "run-amb-cache", status: "COMPLETED" });
    const res = await postCheck({ query: "Syeda Sickfold", record_type: "doctor", jurisdiction: "GB" });
    const { check_id: copy } = (await res.json()) as { check_id: string };
    const a = await getCheckJson(original);
    const b = await getCheckJson(copy);
    expect(b).toMatchObject({ outcome: "ambiguous", cached: true, candidates_total: 2, checked_at: a.checked_at, spend_usd: 0 });
    expect(b.candidates).toEqual(a.candidates);
  });

  it("GET /api/checks/:id is 404 for an unknown id", async () => {
    const res = await callWorker("/api/checks/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    await res.arrayBuffer();
  });

  it("GET /evidence/:key serves a stored object with immutable cache headers, and 404 for anything else", async () => {
    const key = "0b9d6f3e-2a51-4c8e-9a7b-5f1e2d3c4b5a";
    await env.STORE.put(`evidence/${key}.jpg`, JPEG, { httpMetadata: { contentType: "image/jpeg" } });
    await env.STORE.put(`evidence/${key}.md`, "# Page", { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    const jpg = await callWorker(`/evidence/${key}.jpg`);
    expect(jpg.status).toBe(200);
    expect(jpg.headers.get("content-type")).toBe("image/jpeg");
    expect(jpg.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await jpg.arrayBuffer())).toEqual(JPEG);
    const md = await callWorker(`/evidence/${key}.md`);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await md.text()).toBe("# Page");
    for (const bad of [`${key}.png`, `${key.toUpperCase()}.jpg`, "..%2Fsecret.jpg", "00000000-0000-4000-8000-000000000000.jpg"]) {
      const res = await callWorker(`/evidence/${bad}`);
      expect(res.status).toBe(404);
      await res.arrayBuffer();
    }
  });

  it("a callback_url gets the public record once the check finishes; a non-https or own-host one is refused at the door", async () => {
    const posted: unknown[] = [];
    fetchMock.intercept({
      method: "POST",
      url: "https://hooks.example.com/standing",
      reply: async (req) => {
        posted.push(await req.json());
        return new Response(null, { status: 204 });
      },
    });
    const id = await startAgentCheck("Syeda Sickfold", "run-notify", { callback_url: "https://hooks.example.com/standing" });
    expect(posted).toEqual([]);
    mockGetRun("run-notify", completedRun("run-notify", agentAmbiguous));
    await agentCallback({ run_id: "run-notify", status: "COMPLETED" });
    expect(posted).toEqual([await getCheckJson(id)]);

    const plain = { query: "Bo Imaginary", record_type: "doctor", jurisdiction: "GB" };
    const refused = await postCheck({ ...plain, callback_url: "http://hooks.example.com/x" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_body" });
    const ownHost = await postCheck({ ...plain, callback_url: "https://standing.test/api/stats" });
    expect(ownHost.status).toBe(400);
    await ownHost.arrayBuffer();
  });
});

// ---------------------------------------------------------------------------------------------
// Number searches, opened entries, Fetch paths and callbacks

const ADA_URL = "https://www.gmc-uk.org/registrants/99000001";
const LICENSED = "Registered with a licence to practise";
const noEntry = { full_name: null, gmc_number: null, status: null, entry_url: null, sanctions_text: null };

/** Starts a GMC number check whose record page cannot be read, so it goes to the Agent as `runId`. */
async function startNumberAgentCheck(number: string, runId: string): Promise<string> {
  fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchSelectorNotMatched } });
  mockStartRun(runId);
  const res = await postCheck({ number, record_type: "doctor", jurisdiction: "GB" });
  return ((await res.json()) as { check_id: string }).check_id;
}

/**
 * Hand-built Companies House search results in the shape of `ch-search.md` (one `* ### NAME` block per
 * row, read with the `#results` selector). The companies are fictional ("ZZTEST ...") and the numbers
 * (99xxxxxx) are far beyond any number Companies House has issued.
 */
function handBuiltChSearch(rows: { name: string; number: number; dissolved?: boolean }[]): unknown {
  const text = rows
    .map(
      (r) =>
        `* ### ${r.name}\n\n  ${r.number} - ${r.dissolved ? "Dissolved on 1 March 2011" : "Incorporated on 1 March 2001"}\n\n  1 Placeholder Road, Testtown, AB1 2CD`,
    )
    .join("\n");
  return { results: [{ url: "https://find-and-update.company-information.service.gov.uk/search/companies", text }], errors: [] };
}

/** Page 1 of a hand-built search for "ZZTest Widgets Ltd": 20 rows, the exact name at position 17. */
function handBuiltPageOne(): { name: string; number: number }[] {
  return Array.from({ length: 20 }, (_, i) => ({ name: i === 17 ? "ZZTEST WIDGETS LTD" : `ZZTEST WIDGETS NO.${i} LTD`, number: 99000000 + i }));
}

describe("number searches and the opened entry", () => {
  it("a number search whose rows show no numbers matches the opened entry whose number is the input", async () => {
    const id = await startNumberAgentCheck("9360749", "run-numberless");
    const result = {
      blocked: false,
      results_found: 1,
      variants_tried: [],
      rows: [{ name: "Christopher John Marlow WICKFOLD", number: null, status: LICENSED, specialty: null }],
      full_name: "Christopher John Marlow WICKFOLD",
      gmc_number: "9360749",
      status: LICENSED,
      entry_url: GMC_URL,
      sanctions_text: null,
    };
    mockGetRun("run-numberless", completedRun("run-numberless", result));
    mockFetchPages({ [GMC_URL]: fetchGmcRecord });
    await agentCallback({ run_id: "run-numberless", status: "COMPLETED" });
    expect(await getCheckJson(id)).toMatchObject({ outcome: "match", status: "active", licence_number: "9360749" });
  });

  it("a number search where no row or entry carries a number is error incomplete_agent_result, never no_match", async () => {
    const first = await startNumberAgentCheck("99000002", "run-no-numbers");
    const numberless = { blocked: false, results_found: 1, rows: [{ name: "Ada FICTITIOUS", number: null, status: null, specialty: null }], ...noEntry };
    mockGetRun("run-no-numbers", completedRun("run-no-numbers", numberless));
    await agentCallback({ run_id: "run-no-numbers", status: "COMPLETED" });
    expect(await getCheckJson(first)).toMatchObject({ outcome: "error", error: "incomplete_agent_result" });

    // No rows at all, and an opened entry without a number: the same.
    const second = await startNumberAgentCheck("99000003", "run-entry-no-number");
    const entryOnly = { blocked: false, results_found: 1, rows: [], ...noEntry, full_name: "Ada FICTITIOUS", status: LICENSED };
    mockGetRun("run-entry-no-number", completedRun("run-entry-no-number", entryOnly));
    await agentCallback({ run_id: "run-entry-no-number", status: "COMPLETED" });
    expect(await getCheckJson(second)).toMatchObject({ outcome: "error", error: "incomplete_agent_result" });
  });

  it("two rows that pass the match rule are ambiguous even when the run opened one of them", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-two-and-opened");
    const result = {
      blocked: false,
      results_found: 2,
      rows: [
        { name: "Ada FICTITIOUS", number: "99000001", status: LICENSED, specialty: null },
        { name: "Ada Jane FICTITIOUS", number: "99000002", status: LICENSED, specialty: null },
      ],
      full_name: "Ada FICTITIOUS",
      gmc_number: "99000001",
      status: LICENSED,
      entry_url: ADA_URL,
      sanctions_text: null,
    };
    mockGetRun("run-two-and-opened", completedRun("run-two-and-opened", result));
    await agentCallback({ run_id: "run-two-and-opened", status: "COMPLETED" });
    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({ outcome: "ambiguous", candidates_total: 2 });
    expect(rec).not.toHaveProperty("status");
    expect(await count("records")).toBe(0);
  });

  it("a name search with no results_found and ten listed rows is never a match", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-ten-rows");
    const rows = Array.from({ length: 10 }, (_, i) => ({
      name: i === 4 ? "Ada FICTITIOUS" : `Ada FICTITIOUS-${String.fromCharCode(65 + i)}`,
      number: String(99000010 + i),
      status: LICENSED,
      specialty: null,
    }));
    mockGetRun("run-ten-rows", completedRun("run-ten-rows", { blocked: false, rows, ...noEntry }));
    await agentCallback({ run_id: "run-ten-rows", status: "COMPLETED" });
    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({ outcome: "ambiguous", candidates_total: 10 });
    expect((rec.candidates as { full_name: string }[])[0]!.full_name).toBe("Ada FICTITIOUS");
  });
});

describe("a match's status never comes from a results row", () => {
  it("a name match the run did not open, whose record page cannot be read, queues one Agent run by its number; that run does not fall back again", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-name-first", {}, { admin: true });
    const row = { name: "Ada FICTITIOUS", number: "99000001", status: LICENSED, specialty: null };
    mockGetRun(
      "run-name-first",
      completedRun("run-name-first", { blocked: false, results_found: 1, variants_tried: ["ada fictitious"], rows: [row], ...noEntry }),
    );
    mockFetchPages({ [ADA_URL]: fetchSelectorNotMatched });
    mockStartRun("run-by-its-number");
    expect((await agentCallback({ run_id: "run-name-first", status: "COMPLETED" })).status).toBe(200);

    // Not a match from the row: the same check is now searched by the row's number.
    expect(await getCheckJson(id)).toEqual({ status: "pending", started_at: expect.any(String), run_id: "run-by-its-number", queued: false });
    const starts = callsTo("POST", RUN_ASYNC_API);
    expect(starts).toHaveLength(2);
    expect((starts[1]!.body as { goal: string }).goal).toBe(gmc.goal({ variants: [], number: "99000001" }));
    expect((await spendRows()).filter((r) => r.kind === "agent_step")).toHaveLength(1);

    // The number run cannot read the page either and opened nothing: a match with status unknown.
    mockGetRun("run-by-its-number", completedRun("run-by-its-number", { blocked: false, results_found: 1, rows: [row], ...noEntry }));
    await agentCallback({ run_id: "run-by-its-number", status: "COMPLETED" });
    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({
      outcome: "match",
      status: "unknown",
      status_raw: LICENSED,
      licence_number: "99000001",
      method: "agent",
      variants_tried: ["ada fictitious"],
    });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(2);
    // Both runs' steps, plus the screenshot taken because the runs had no step screenshots.
    expect(rec.spend_usd as number).toBeCloseTo(2 * 9 * 0.016 + 0.002, 10);
    expect((await spendRows()).filter((r) => r.kind === "agent_step")).toHaveLength(2);
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
  });

  it("a name match with no number, no record page and no opened entry has status unknown with status_raw kept", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-no-number");
    const rows = [{ name: "Ada FICTITIOUS", number: null, status: LICENSED, specialty: null }];
    mockGetRun("run-no-number", completedRun("run-no-number", { blocked: false, results_found: 1, rows, ...noEntry }));
    await agentCallback({ run_id: "run-no-number", status: "COMPLETED" });
    expect(await getCheckJson(id)).toMatchObject({ outcome: "match", status: "unknown", status_raw: LICENSED, licence_number: null });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
  });

  it("a name match whose page cannot be read takes the status from the opened entry, conditions notice included", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-entry");
    const result = {
      blocked: false,
      results_found: 1,
      rows: [{ name: "Ada FICTITIOUS", number: "99000001", status: LICENSED, specialty: null }],
      full_name: "Ada FICTITIOUS",
      gmc_number: "99000001",
      status: LICENSED,
      entry_url: ADA_URL,
      sanctions_text: "This registrant has conditions (details available in history tab)",
    };
    mockGetRun("run-entry", completedRun("run-entry", result));
    mockFetchPages({ [ADA_URL]: fetchSelectorNotMatched });
    await agentCallback({ run_id: "run-entry", status: "COMPLETED" });
    expect(await getCheckJson(id)).toMatchObject({
      outcome: "match",
      status: "conditions",
      status_raw: LICENSED,
      restrictions: ["This registrant has conditions (details available in history tab)"],
    });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
  });

  it("a record-page read that throws while a run is resolved is an unreadable page, not resolve_failed", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-fetch-throws", {}, { admin: true });
    const row = { name: "Ada FICTITIOUS", number: "99000001", status: LICENSED, specialty: null };
    mockGetRun("run-fetch-throws", completedRun("run-fetch-throws", { blocked: false, results_found: 1, rows: [row], ...noEntry }));
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: () => {
        throw new TypeError("network connection lost");
      },
    });
    mockStartRun("run-after-throw");
    await agentCallback({ run_id: "run-fetch-throws", status: "COMPLETED" });
    expect(await getCheckJson(id)).toMatchObject({ status: "pending", run_id: "run-after-throw" });
  });
});

describe("Fetch paths", () => {
  it("a number path whose Fetch throws takes the Agent fallback, not internal_error", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: () => {
        throw new TypeError("network connection lost");
      },
    });
    mockStartRun("run-after-fetch-throw");
    const res = await postCheck({ number: "9360749", record_type: "doctor", jurisdiction: "GB" });
    const { check_id: id } = (await res.json()) as { check_id: string };
    expect(await getCheckJson(id)).toMatchObject({ status: "pending", run_id: "run-after-fetch-throw" });
    expect((callsTo("POST", RUN_ASYNC_API)[0]!.body as { goal: string }).goal).toBe(gmc.goal({ variants: [], number: "9360749" }));
  });

  it("a number path whose page parses without a status line takes the Agent fallback", async () => {
    const url = "https://www.gmc-uk.org/registrants/9662428";
    mockFetchPages({ [url]: pageResponse(url, gmcConditionsPlain) });
    mockStartRun("run-no-status-line");
    const res = await postCheck({ number: "9662428", record_type: "doctor", jurisdiction: "GB" });
    const body = (await res.json()) as { check_id: string };
    expect(body).toMatchObject({ status: "pending", estimated_cost_usd: 0.208 });
    expect((callsTo("POST", RUN_ASYNC_API)[0]!.body as { goal: string }).goal).toBe(gmc.goal({ variants: [], number: "9662428" }));
    expect(shot).not.toHaveBeenCalled();
  });

  it("a Companies House name with no exact row is ambiguous, with no rows is no_match, and a failed search is an error", async () => {
    mockFetchPages({
      [companiesHouse.searchQueryUrl("Greggs")]: fetchChSearch,
      [companiesHouse.searchQueryUrl("ZZTest Nothing Ltd")]: pageResponse(companiesHouse.searchQueryUrl("ZZTest Nothing Ltd"), "No results"),
      [companiesHouse.searchQueryUrl("ZZTest Unreachable Ltd")]: { results: [], errors: [{ error: "target_unreachable" }] },
    });
    const ask = (query: string) => postCheck({ query, record_type: "company", jurisdiction: "GB" }, { admin: true });

    const amb = (await (await ask("Greggs")).json()) as { check_id: string };
    const ambRec = await getCheckJson(amb.check_id);
    expect(ambRec).toMatchObject({ outcome: "ambiguous", candidates_total: 20, method: "fetch", variants_tried: ["Greggs"] });
    expect(ambRec).not.toHaveProperty("status");
    expect(ambRec.candidates as unknown[]).toHaveLength(10);

    const none = (await (await ask("ZZTest Nothing Ltd")).json()) as { check_id: string };
    expect(await getCheckJson(none.check_id)).toMatchObject({ outcome: "no_match", suggestions: companiesHouse.noMatchSuggestions });

    const failed = (await (await ask("ZZTest Unreachable Ltd")).json()) as { check_id: string };
    expect(await getCheckJson(failed.check_id)).toMatchObject({ outcome: "error", error: "target_unreachable" });
    expect(shot).not.toHaveBeenCalled();
  });

  it("a full Companies House page with the exact name in its last five rows also reads page 2, and a namesake there makes it ambiguous", async () => {
    const q = "ZZTest Widgets Ltd";
    mockFetchPages({
      [companiesHouse.searchQueryUrl(q)]: handBuiltChSearch(handBuiltPageOne()),
      [companiesHouse.searchQueryUrl(q, 2)]: handBuiltChSearch([
        { name: "ZZTEST WIDGETS LIMITED", number: 99000100, dissolved: true },
        { name: "ZZTEST WIDGETS (NORTH) LTD", number: 99000101 },
      ]),
    });
    const res = await postCheck({ query: q, record_type: "company", jurisdiction: "GB" });
    const rec = await getCheckJson(((await res.json()) as { check_id: string }).check_id);
    expect(rec).toMatchObject({ outcome: "ambiguous", candidates_total: 22 });
    expect(rec).not.toHaveProperty("status");
    expect((rec.candidates as { full_name: string }[]).slice(0, 2).map((c) => c.full_name)).toEqual(["ZZTEST WIDGETS LTD", "ZZTEST WIDGETS LIMITED"]);
  });

  it("when page 2 cannot be read, the exact name in page 1's last rows is not a match", async () => {
    const q = "ZZTest Widgets Ltd";
    mockFetchPages({
      [companiesHouse.searchQueryUrl(q)]: handBuiltChSearch(handBuiltPageOne()),
      [companiesHouse.searchQueryUrl(q, 2)]: { results: [], errors: [{ error: "target_unreachable" }] },
    });
    const res = await postCheck({ query: q, record_type: "company", jurisdiction: "GB" });
    const rec = await getCheckJson(((await res.json()) as { check_id: string }).check_id);
    expect(rec).toMatchObject({ outcome: "ambiguous", candidates_total: 20 });
    expect((rec.candidates as { full_name: string }[])[0]!.full_name).toBe("ZZTEST WIDGETS LTD");
  });

  it("when page 2 holds no namesake, the exact name is a match and its company page is read", async () => {
    const q = "ZZTest Widgets Ltd";
    const companyUrl = "https://find-and-update.company-information.service.gov.uk/company/99000017";
    // Hand-built from ch-company.md: the same page with the fictional company's name and number.
    const page = chCompany.replaceAll("GREGGS PLC (00502851)", "ZZTEST WIDGETS LTD (99000017)");
    mockFetchPages({
      [companiesHouse.searchQueryUrl(q)]: handBuiltChSearch(handBuiltPageOne()),
      [companiesHouse.searchQueryUrl(q, 2)]: handBuiltChSearch([{ name: "ZZTEST WIDGETS (NORTH) LTD", number: 99000101 }]),
      [companyUrl]: pageResponse(companyUrl, page),
    });
    const res = await postCheck({ query: q, record_type: "company", jurisdiction: "GB" });
    const rec = await getCheckJson(((await res.json()) as { check_id: string }).check_id);
    expect(rec).toMatchObject({ outcome: "match", status: "active", full_name: "ZZTEST WIDGETS LTD", licence_number: "99000017" });
  });
});

describe("callbacks, gates, slot under errors", () => {
  it("a CANCELLED run is error agent_cancelled, billed for its steps", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-cancelled");
    await agentCallback({ run_id: "run-cancelled", status: "CANCELLED", num_of_steps: 2 });
    const rec = await getCheckJson(id);
    expect(rec).toMatchObject({ outcome: "error", error: "agent_cancelled" });
    expect(rec.spend_usd as number).toBeCloseTo(0.032, 10);
  });

  it("a block message without a URL is kept in the error", async () => {
    const id = await startAgentCheck("Ada Fictitious", "run-blocked-kept");
    mockGetRun("run-blocked-kept", completedRun("run-blocked-kept", { blocked: true, block_message: "Access denied by the register", rows: [] }));
    await agentCallback({ run_id: "run-blocked-kept", status: "COMPLETED" });
    expect(await getCheckJson(id)).toMatchObject({ outcome: "error", error: "blocked: Access denied by the register" });
  });

  it("a request refused at the spend pause does not use one of the visitor's daily checks", async () => {
    await env.DB.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('big', 'agent_step', 8, 'earlier', ?)")
      .bind(new Date().toISOString())
      .run();
    for (let i = 0; i < 6; i++) {
      const res = await postCheck({ query: "Ada Fictitious", record_type: "doctor", jurisdiction: "GB" }, { ip: "203.0.113.20" });
      expect(res.status).toBe(503);
      await res.arrayBuffer();
    }
    expect(await count("public_use")).toBe(0);
  });

  it("a resolver whose writes fail still frees the slot", async () => {
    await startAgentCheck("Syeda Sickfold", "run-writes-fail");
    await env.DB.prepare(
      "CREATE TRIGGER refuse_finish BEFORE UPDATE OF state ON checks WHEN NEW.state = 'done' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    ).run();
    mockGetRun("run-writes-fail", completedRun("run-writes-fail", agentAmbiguous));
    const res = await agentCallback({ run_id: "run-writes-fail", status: "COMPLETED" });
    expect(res.status).toBe(500);
    await res.arrayBuffer();
    expect(await slotRow()).toEqual({ holder_check_id: null, since: null });
  });
});
