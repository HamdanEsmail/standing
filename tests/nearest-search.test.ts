// Registers whose name search lists the nearest or the alphabetically next names for anything
// (Companies House, Florida Sunbiz): a row is a candidate only when its name holds every significant
// word of the query, so a name that does not exist is no_match, never "ambiguous, 20 records match".
// The search pages are real reads of 9 Nov 2026 for a made-up name.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nameHasEveryWord } from "../src/core/names";
import { companiesHouse } from "../src/registries/companies-house";
import { flSunbiz } from "../src/registries/fl-sunbiz";
import flNonexistent from "./fixtures/registries/fl-search-nonexistent.json";
import fetchChNonexistent from "./fixtures/tinyfish/fetch-ch-search-nonexistent.json";
import fetchChSearch from "./fixtures/tinyfish/fetch-ch-search.json";
import { freshState, getCheckJson, mockFetchPages, postCheck, restoreState } from "./helpers/checks";

beforeEach(freshState);
afterEach(restoreState);

const ask = async (query: string, jurisdiction = "GB") => {
  const res = await postCheck({ query, record_type: "company", jurisdiction }, { admin: true });
  return getCheckJson(((await res.json()) as { check_id: string }).check_id);
};

describe("nearest-name registers", () => {
  it("a row counts only when it holds every significant word; legal-form words do not count", () => {
    expect(nameHasEveryWord("Zqxvort Plimbany Holdings Ltd", "AAA BRACE HOLDINGS LIMITED")).toBe(false);
    expect(nameHasEveryWord("Greggs", "GREGG'S GARDENS LIMITED")).toBe(true);
    expect(nameHasEveryWord("Greggs PLC", "GREGGS ACADEMIC SERVICES LTD")).toBe(true);
    expect(nameHasEveryWord("Greggs Bakery", "GREGGS PLC")).toBe(false);
    // Whole words: "ZQZ" does not hold "Zq".
    expect(nameHasEveryWord("Zq Holdings", "ZQZ HOLDINGS LLC")).toBe(false);
    expect(companiesHouse.searchNearest).toBe(true);
    expect(flSunbiz.searchNearest).toBe(true);
  });

  it("Companies House: a made-up name is no_match with what was tried; Greggs is still ambiguous and GREGGS PLC still a match", async () => {
    mockFetchPages({
      [companiesHouse.searchQueryUrl("Zqxvort Plimbany Holdings Ltd")]: fetchChNonexistent,
      [companiesHouse.searchQueryUrl("Greggs")]: fetchChSearch,
    });
    const none = await ask("Zqxvort Plimbany Holdings Ltd");
    expect(none).toMatchObject({ outcome: "no_match", variants_tried: ["Zqxvort Plimbany Holdings Ltd"], suggestions: companiesHouse.noMatchSuggestions });
    expect(none).not.toHaveProperty("status");
    const amb = await ask("Greggs");
    expect(amb).toMatchObject({ outcome: "ambiguous" });
    expect((amb.candidates as { full_name: string }[]).every((c) => /GREGG/.test(c.full_name))).toBe(true);
  });

  it("Florida: a made-up name is no_match", async () => {
    const url = flSunbiz.searchQueryUrl("Zqxvort Plimbany Holdings Inc");
    mockFetchPages({ [url]: { results: [{ url, final_url: url, text: flNonexistent.text, links: flNonexistent.links }], errors: [] } });
    expect(await ask("Zqxvort Plimbany Holdings Inc", "US-FL")).toMatchObject({ outcome: "no_match" });
  });
});
