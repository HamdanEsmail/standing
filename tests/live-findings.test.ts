// What the first live checks (9 Nov 2026) showed, one test each, built from the real run results with
// the people's names replaced.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companiesHouse } from "../src/registries/companies-house";
import { cslb } from "../src/registries/cslb";
import { gmc } from "../src/registries/gmc";
import { agentCallback, completedRun, count, freshState, getCheckJson, mockGetRun, mockStartRun, postCheck, restoreState } from "./helpers/checks";

beforeEach(freshState);
afterEach(restoreState);
import { nmc } from "../src/registries/nmc";
import { sra } from "../src/registries/sra";

const TODAY = "2026-11-09";

describe("live findings", () => {
  it("nmc: 'Not on the register' with the register's reason 'Removed by Agreement' is removed", () => {
    const real = {
      pin: "22L4964O",
      rows: [{ name: "Ada FICTITIOUS", detail: "Removed by Agreement - Outstanding Fitness to Practice Question", number: "22L4964O", status: "Not on the register" }],
      status: "Not on the register",
      blocked: false,
      location: null,
      full_name: "Ada FICTITIOUS",
      block_message: null,
      register_part: null,
      results_found: 1,
      sanctions_text: "Removed by Agreement - Outstanding Fitness to Practice Question",
      variants_tried: [],
    };
    const opened = nmc.parseAgentResult(real).opened!;
    expect(nmc.statusFromAgentEntry(opened, TODAY)).toEqual({ status: "removed", flags: [] });
    // Without a reason the register's headline still says the person is not registered.
    expect(nmc.statusFromAgentEntry({ ...opened, sanctions_text: null }, TODAY).status).toBe("not_licensed");
  });

  it("sra: 'Prohibited' with a suspension from practice in force is suspended, not removed", () => {
    const real = {
      firm: null,
      rows: [{ name: "Ada Fictitious", detail: null, number: "961486", status: "Prohibited" }],
      status: "Prohibited",
      blocked: false,
      full_name: "Ada Fictitious",
      sra_number: "961486",
      block_message: null,
      results_found: 1,
      admission_date: null,
      sanctions_text:
        "Solicitors Disciplinary Tribunal order. Mr Fictitious was suspended from practice as a solicitor for the period of 6 months, to commence on the 25th day of September 2026.",
      variants_tried: [],
    };
    expect(sra.statusFromAgentEntry(sra.parseAgentResult(real).opened!, TODAY)).toEqual({ status: "suspended", flags: [] });
    expect(sra.statusFromAgentEntry({ ...sra.parseAgentResult(real).opened!, sanctions_text: null }, TODAY).status).toBe("removed");
  });

  it("cslb: a run that read only the page header, 'Unknown' and the disclaimer is incomplete, never a match", async () => {
    // The real result of the rerun (run 591bba0c, 9 Nov 2026): no person or business is named in it.
    const real = {
      city: "Unknown",
      rows: [{ name: "DEPARTMENT OF CONSUMER AFFAIRS CONTRACTORS STATE LICENSE BOARD", detail: "Unknown", number: "738180", status: "Unknown" }],
      status: "Unknown",
      blocked: false,
      block_message: null,
      business_name: "DEPARTMENT OF CONSUMER AFFAIRS CONTRACTORS STATE LICENSE BOARD",
      results_found: 1,
      license_number: "738180",
      sanctions_text: "DISCLAIMER: A license status check provides information taken from the CSLB license database. Before relying on this information, you should be aware of the following limitations.",
      variants_tried: [],
      classifications: "Unknown",
    };
    const out = cslb.parseAgentResult(real);
    expect(out.opened).toMatchObject({ full_name: null, licence_number: "738180", status_raw: null, sanctions_text: null });
    expect(out.rows[0]).toMatchObject({ name: "", status_raw: null, detail: null });

    // The same entry reaches the resolver as a match with neither a name nor a status line, which ends
    // as incomplete (tested through the API for GMC below); CSLB itself is no longer supported.
    expect(out.opened?.full_name ?? null).toBeNull();
  });

  it("gmc: a run that reports nothing at all (it never found the search box) is incomplete, never no_match", async () => {
    // The real result of run 31714b6c (standard browser, 9 Nov 2026), and the one search box the goal now names.
    const real = { rows: [], status: null, blocked: false, entry_url: null, full_name: null, gmc_number: null, block_message: null, results_found: null, sanctions_text: null, variants_tried: [] };
    mockStartRun("run-gmc-empty");
    const res = await postCheck({ query: "Ada Fictitious", record_type: "doctor", jurisdiction: "GB" }, { admin: true });
    const id = ((await res.json()) as { check_id: string }).check_id;
    mockGetRun("run-gmc-empty", completedRun("run-gmc-empty", real));
    await agentCallback({ run_id: "run-gmc-empty", status: "COMPLETED" });
    expect(await getCheckJson(id)).toMatchObject({ outcome: "error", error: "incomplete_agent_result" });
    expect(gmc.goal({ variants: ["ada fictitious"] })).toMatch(/one search box/);
    expect(gmc.goal({ variants: ["ada fictitious"] })).not.toMatch(/surname field/);
  });

  it("nmc: the combined line 'Not on the register - Removed by Agreement …' is removed too", () => {
    const e = { full_name: "Ada FICTITIOUS", licence_number: "22L4964O", url: null, sanctions_text: "An explanation of these terms can be found in the glossary of terms." };
    expect(nmc.statusFromAgentEntry({ ...e, status_raw: "Not on the register - Removed by Agreement - Outstanding Fitness to Practice Question" }, TODAY)).toEqual({
      status: "removed",
      flags: [],
    });
  });

  it("sra: 'Prohibited' with 'Suspended from 25/09/2026' in the entry is suspended", () => {
    const e = { full_name: "Ada Fictitious", licence_number: "961486", url: null, status_raw: "Prohibited" };
    const text = "We have prohibited this person from practising as a solicitor. Prohibited Suspended from 25/09/2026.";
    expect(sra.statusFromAgentEntry({ ...e, sanctions_text: text }, TODAY)).toEqual({ status: "suspended", flags: [] });
  });

  it("companies house: 'Active — Active proposal to strike off' is active with the strike-off flag", () => {
    expect(companiesHouse.normalizeStatus("Active — Active proposal to strike off", {})).toEqual({ status: "active", flags: ["proposal_to_strike_off"] });
  });

  it("cslb: the goal says the licence fields are below the banner, and a reached licence page counts as a result", () => {
    const g = cslb.goal({ variants: [], number: "738180" });
    expect(g).toMatch(/scroll down/i);
    expect(g).toMatch(/Is this your license\?/);
    expect(g).toMatch(/results_found is at least 1/);
  });
});
