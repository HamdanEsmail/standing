// Florida Division of Corporations (Sunbiz): read with plain Fetch, on fixtures recorded 9 Nov 2026
// (people's names on the record pages replaced).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyRows } from "../src/core/classify";
import { flSunbiz, parseSearch } from "../src/registries/fl-sunbiz";
import active from "./fixtures/registries/fl-record-active.md?raw";
import inactive from "./fixtures/registries/fl-record-inactive.md?raw";
import search from "./fixtures/registries/fl-search-publix.json";
import { callsTo, freshState, getCheckJson, postCheck, restoreState, RUN_ASYNC_API } from "./helpers/checks";
import { fetchMock } from "./helpers/fetch-mock";

beforeEach(freshState);
afterEach(restoreState);

const rows = () => parseSearch(search.text, search.links);
const business = (name: string) => ({ kind: "business" as const, normalized: name });

describe("fl-sunbiz", () => {
  it("reads the search page: name, document number, status and each row's own stable record link", () => {
    const all = rows();
    expect(all).toHaveLength(20);
    const row = all.find((r) => r.number === "P01000027088")!;
    expect(row).toMatchObject({ name: "PUBLIX ASSET MANAGEMENT COMPANY", status_raw: "Active" });
    expect(row.url).toMatch(/^https:\/\/search\.sunbiz\.org\/Inquiry\/CorporationSearch\/SearchResultDetail\?inquirytype=EntityName&directionType=Initial&searchNameOrder=[^&]+&aggregateId=domp-p01000027088-/);
    expect(row.url).not.toMatch(/searchTerm|listNameOrder/);
    // A former name is listed but can never equal the searched name.
    expect(all.find((r) => r.number === "P01000017602")?.name).toBe("PUBLIX AUTO SALES, CORP. (former name)");
    expect(classifyRows(all, business("PUBLIX AUTO SALES CORP")).outcome).toBe("ambiguous");
  });

  it("six entities named exactly PUBLIX are ambiguous; a unique exact name is a match", () => {
    const amb = classifyRows(rows(), business("PUBLIX"));
    expect(amb).toMatchObject({ outcome: "ambiguous" });
    if (amb.outcome === "ambiguous") expect(amb.candidates.slice(0, 6).map((c) => c.number)).toEqual(["910940", "913749", "928735", "928736", "928737", "T08547"]);
    expect(classifyRows(rows(), business("Publix Asset Management Company"))).toMatchObject({ outcome: "match", row: { number: "P01000027088" } });
  });

  it("reads a record page and maps its status; a dissolution is dissolved", () => {
    const a = flSunbiz.parseRecordPage(active)!;
    expect(a).toMatchObject({
      full_name: "PUBLIX ASSET MANAGEMENT COMPANY",
      licence_number: "P01000027088",
      status_raw: "ACTIVE",
      registered_since: "2001-03-15",
      raw_fields: { entity_type: "Florida Profit Corporation", state: "FL", principal_address: "3300 PUBLIX CORPORATE PKWY, LAKELAND, FL 33811", last_annual_report: { year: 2026, filed: "2026-04-02" } },
    });
    expect(flSunbiz.statusFromRecord(a, "2026-11-09")).toEqual({ status: "active", flags: [] });
    const i = flSunbiz.parseRecordPage(inactive)!;
    expect(i).toMatchObject({ status_raw: "INACTIVE - ADMIN DISSOLUTION FOR ANNUAL REPORT", raw_fields: { last_event: "ADMIN DISSOLUTION FOR ANNUAL REPORT" } });
    expect(flSunbiz.statusFromRecord(i, "2026-11-09").status).toBe("dissolved");
    expect(flSunbiz.normalizeStatus("INACTIVE", {}).status).toBe("unknown");
    expect(JSON.stringify([a, i])).not.toMatch(/REDACTED/);
    expect(flSunbiz.parseRecordPage("# Something else")).toBeNull();
  });

  it("a name check reads the search and the matched row's record page with Fetch, never the Agent; a number is refused", async () => {
    const recordUrl = rows().find((r) => r.number === "P01000027088")!.url!;
    fetchMock.intercept({
      method: "POST",
      url: "https://api.fetch.tinyfish.ai/",
      times: Infinity,
      reply: (_req, body) => {
        const url = (body as { urls: string[] }).urls[0]!;
        if (url.includes("/SearchResults?")) return Response.json({ results: [{ url, final_url: url, text: search.text, links: search.links }], errors: [] });
        if (url === recordUrl) return Response.json({ results: [{ url, final_url: url, text: active }], errors: [] });
        throw new Error(`unexpected read ${url}`);
      },
    });
    const res = await postCheck({ query: "Publix Asset Management Company", record_type: "company", jurisdiction: "US-FL" }, { admin: true });
    const id = ((await res.json()) as { check_id: string }).check_id;
    expect(await getCheckJson(id)).toMatchObject({ outcome: "match", status: "active", method: "fetch", source_url: recordUrl, licence_number: "P01000027088" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(0);

    const byNumber = await postCheck({ number: "P01000027088", record_type: "company", jurisdiction: "US-FL" }, { admin: true });
    expect(byNumber.status).toBe(400);
    expect(await byNumber.json()).toMatchObject({ error: "invalid_query", detail: expect.stringMatching(/by name/) });
  });
});
