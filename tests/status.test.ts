import { describe, expect, it } from "vitest";
import { toPublicRecord } from "../src/core/schema";
import { applyStatusMap, type Flag, type Status, type StatusMap } from "../src/core/status";
import type { CandidateRow, CheckRow, RecordRow } from "../src/db/types";
import { CH_MAP } from "../src/registries/companies-house";
import { GMC_MAP } from "../src/registries/gmc";
import { REGISTRY_META } from "../src/registries/meta";

// ---------------------------------------------------------------------------
// The core status-map tests
// ---------------------------------------------------------------------------

describe("applyStatusMap (core)", () => {
  it("maps GMC raw statuses, upgrading to conditions when a conditions block exists", () => {
    expect(applyStatusMap(GMC_MAP, "Registered with a licence to practise", {})).toEqual({ status: "active", flags: [] });
    expect(applyStatusMap(GMC_MAP, "Registered with a licence to practise", { hasConditions: true }).status).toBe("conditions");
    expect(applyStatusMap(GMC_MAP, "Registered without a licence to practise", {}).status).toBe("not_licensed");
    expect(applyStatusMap(GMC_MAP, "Suspended", {}).status).toBe("suspended");
    expect(applyStatusMap(GMC_MAP, "Erased", {}).status).toBe("removed");
  });

  it("maps Companies House statuses with the strike-off flag", () => {
    expect(applyStatusMap(CH_MAP, "Active — Proposal to strike off", {})).toEqual({
      status: "active",
      flags: ["proposal_to_strike_off"],
    });
    expect(applyStatusMap(CH_MAP, "Dissolved", {}).status).toBe("dissolved");
    expect(applyStatusMap(CH_MAP, "Liquidation", {}).status).toBe("insolvency");
    expect(applyStatusMap(CH_MAP, "Something new", {}).status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Every mapped raw value, both registries
// ---------------------------------------------------------------------------

const GMC_CASES: [string, Status][] = [
  ["Registered with a licence to practise", "active"],
  ["Provisionally registered with a licence to practise", "active"],
  ["Registered without a licence to practise", "not_licensed"],
  ["Provisionally registered without a licence to practise", "not_licensed"],
  ["Registered", "not_licensed"],
  ["Suspended", "suspended"],
  ["Erased", "removed"],
  ["Administrative erasure", "removed"],
  ["Voluntary erasure", "removed"],
  ["Not registered", "not_licensed"],
  ["Registration lapsed", "not_licensed"],
  ["Relinquished", "not_licensed"],
];

const CH_CASES: [string, Status, Flag[]][] = [
  ["Active", "active", []],
  ["Active - Proposal to Strike off", "active", ["proposal_to_strike_off"]],
  ["Active — Proposal to strike off", "active", ["proposal_to_strike_off"]],
  ["Active – Proposal to strike off", "active", ["proposal_to_strike_off"]],
  ["Dissolved", "dissolved", []],
  ["Liquidation", "insolvency", []],
  ["In Administration", "insolvency", []],
  ["Administration", "insolvency", []],
  ["Receivership", "insolvency", []],
  ["Receiver Action", "insolvency", []],
  ["Administrative Receiver", "insolvency", []],
  ["Voluntary Arrangement", "insolvency", []],
  ["Insolvency Proceedings", "insolvency", []],
  ["Converted / Closed", "removed", []],
  ["Closed", "removed", []],
  ["Removed", "removed", []],
  ["Open", "active", []],
  ["Registered", "active", []],
];

describe("GMC_MAP", () => {
  it.each(GMC_CASES)("%s -> %s", (raw, status) => {
    expect(applyStatusMap(GMC_MAP, raw, {})).toEqual({ status, flags: [] });
  });

  it("is tolerant of case and whitespace", () => {
    for (const [raw, status] of GMC_CASES) {
      expect(applyStatusMap(GMC_MAP, raw.toUpperCase(), {}).status).toBe(status);
      expect(applyStatusMap(GMC_MAP, raw.toLowerCase(), {}).status).toBe(status);
      expect(applyStatusMap(GMC_MAP, `  ${raw.replace(/ /g, "  ")}\n`, {}).status).toBe(status);
    }
  });

  it("never lets 'without a licence' reach the 'with a licence' pattern", () => {
    for (const raw of [
      "Registered without a licence to practise",
      "REGISTERED WITHOUT A LICENCE TO PRACTISE",
      "Provisionally registered without a licence to practise",
    ]) {
      expect(applyStatusMap(GMC_MAP, raw, {}).status).toBe("not_licensed");
      // ...even when the page also showed a conditions block: only `active` is upgraded.
      expect(applyStatusMap(GMC_MAP, raw, { hasConditions: true }).status).toBe("not_licensed");
    }
  });

  it("maps anything else to unknown", () => {
    for (const raw of ["Something new", "Deceased", "Registered with a licence to practise, probably", "", "   "]) {
      expect(applyStatusMap(GMC_MAP, raw, {})).toEqual({ status: "unknown", flags: [] });
    }
  });
});

describe("CH_MAP", () => {
  it.each(CH_CASES)("%s -> %s", (raw, status, flags) => {
    expect(applyStatusMap(CH_MAP, raw, {})).toEqual({ status, flags });
  });

  it("is tolerant of case, whitespace and the kind of dash", () => {
    for (const [raw, status, flags] of CH_CASES) {
      expect(applyStatusMap(CH_MAP, raw.toUpperCase(), {})).toEqual({ status, flags });
      expect(applyStatusMap(CH_MAP, raw.toLowerCase(), {})).toEqual({ status, flags });
      expect(applyStatusMap(CH_MAP, `\t${raw.replace(/ /g, "   ")} `, {})).toEqual({ status, flags });
    }
    for (const dash of ["-", "‐", "‑", "‒", "–", "—", "―", "−"]) {
      expect(applyStatusMap(CH_MAP, `Active ${dash} Proposal to strike off`, {})).toEqual({
        status: "active",
        flags: ["proposal_to_strike_off"],
      });
      expect(applyStatusMap(CH_MAP, `Active${dash}Proposal to Strike off`, {})).toEqual({
        status: "active",
        flags: ["proposal_to_strike_off"],
      });
    }
  });

  it("maps anything else to unknown", () => {
    for (const raw of ["Something new", "Active but worrying", "Dissolved company", "Converted", ""]) {
      expect(applyStatusMap(CH_MAP, raw, {})).toEqual({ status: "unknown", flags: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// applyStatusMap itself
// ---------------------------------------------------------------------------

describe("applyStatusMap rules", () => {
  it("null or unmatched raw is unknown with no flags", () => {
    expect(applyStatusMap(GMC_MAP, null, {})).toEqual({ status: "unknown", flags: [] });
    expect(applyStatusMap(CH_MAP, "Something new", {})).toEqual({ status: "unknown", flags: [] });
    expect(applyStatusMap([], "Active", {})).toEqual({ status: "unknown", flags: [] });
  });

  it("hasConditions upgrades active, and only active", () => {
    expect(applyStatusMap(GMC_MAP, "Registered with a licence to practise", { hasConditions: true }).status).toBe("conditions");
    expect(applyStatusMap(CH_MAP, "Active", { hasConditions: true }).status).toBe("conditions");
    expect(applyStatusMap(GMC_MAP, "Suspended", { hasConditions: true }).status).toBe("suspended");
    expect(applyStatusMap(GMC_MAP, "Erased", { hasConditions: true }).status).toBe("removed");
    expect(applyStatusMap(CH_MAP, "Dissolved", { hasConditions: true }).status).toBe("dissolved");
    expect(applyStatusMap(CH_MAP, "Something new", { hasConditions: true }).status).toBe("unknown");
    expect(applyStatusMap(GMC_MAP, null, { hasConditions: true }).status).toBe("unknown");
    expect(applyStatusMap(GMC_MAP, "Registered with a licence to practise", { hasConditions: false }).status).toBe("active");
  });

  it("hasInterimOrder adds the flag, whatever the status and even without a raw value", () => {
    expect(applyStatusMap(GMC_MAP, "Suspended", { hasInterimOrder: true })).toEqual({
      status: "suspended",
      flags: ["interim_order"],
    });
    expect(applyStatusMap(GMC_MAP, null, { hasInterimOrder: true })).toEqual({ status: "unknown", flags: ["interim_order"] });
    expect(applyStatusMap(GMC_MAP, "Something new", { hasInterimOrder: true })).toEqual({
      status: "unknown",
      flags: ["interim_order"],
    });
    expect(applyStatusMap(CH_MAP, "Active - Proposal to Strike off", { hasInterimOrder: true })).toEqual({
      status: "active",
      flags: ["proposal_to_strike_off", "interim_order"],
    });
    expect(applyStatusMap(GMC_MAP, "Suspended", { hasInterimOrder: false }).flags).toEqual([]);
  });

  it("both hints together", () => {
    expect(
      applyStatusMap(GMC_MAP, "Registered with a licence to practise", { hasConditions: true, hasInterimOrder: true }),
    ).toEqual({ status: "conditions", flags: ["interim_order"] });
  });

  it("first matching pattern wins, flags are deduped, and a map regex with state is safe to reuse", () => {
    const map: StatusMap = [
      { pattern: /^alpha$/i, status: "suspended", flags: ["under_review"] },
      { pattern: /^alpha|^beta$/i, status: "removed" },
      { pattern: /^gamma$/gi, status: "active", flags: ["interim_order", "interim_order", "name_changed"] },
    ];
    expect(applyStatusMap(map, "alpha", {})).toEqual({ status: "suspended", flags: ["under_review"] });
    expect(applyStatusMap(map, "beta", {}).status).toBe("removed");
    // A /g regex remembers lastIndex after a hit; the second call must still match.
    for (let i = 0; i < 3; i++) {
      expect(applyStatusMap(map, "gamma", { hasInterimOrder: true })).toEqual({
        status: "active",
        flags: ["interim_order", "name_changed"],
      });
    }
  });
});

// ---------------------------------------------------------------------------
// REGISTRY_META
// ---------------------------------------------------------------------------

describe("REGISTRY_META", () => {
  it("is the single source for each registry's name, country and search page", () => {
    expect(REGISTRY_META).toEqual({
      gmc: {
        name: "General Medical Council",
        country: "GB",
        searchUrl: "https://www.gmc-uk.org/registration-and-licensing/the-medical-register",
      },
      nmc: {
        name: "Nursing and Midwifery Council",
        country: "GB",
        searchUrl: "https://www.nmc.org.uk/registration/search-the-register/",
      },
      sra: {
        name: "Solicitors Regulation Authority",
        country: "GB",
        searchUrl: "https://www.sra.org.uk/consumers/register/",
      },
      "companies-house": {
        name: "Companies House",
        country: "GB",
        searchUrl: "https://find-and-update.company-information.service.gov.uk/search/companies",
      },
      cslb: {
        name: "CA Contractors State License Board",
        country: "US-CA",
        searchUrl: "https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx",
      },
      "ca-dca": {
        name: "CA Department of Consumer Affairs",
        country: "US-CA",
        searchUrl: "https://search.dca.ca.gov/",
      },
      "fl-sunbiz": {
        name: "Florida Division of Corporations (Sunbiz)",
        country: "US-FL",
        searchUrl: "https://search.sunbiz.org/Inquiry/CorporationSearch/ByName",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// toPublicRecord
// ---------------------------------------------------------------------------

const BASE = "https://standing.test";

function check(over: Partial<CheckRow> = {}): CheckRow {
  return {
    id: "chk-1",
    state: "done",
    registry: "gmc",
    record_type: "doctor",
    jurisdiction: "GB",
    profession: null,
    query_raw: "Christopher Wickfold",
    query_normalized: "christopher wickfold",
    number: null,
    cache_key: null,
    variants_tried: "[]",
    outcome: "match",
    status: "active",
    flags: "[]",
    record_id: "rec-1",
    run_id: null,
    method: "agent",
    cached_from_check_id: null,
    evidence_key: null,
    spend_usd: 0.128,
    callback_url: null,
    candidates_total: null,
    suggestions: "[]",
    trigger: "request",
    monitor_run_id: null,
    ip_hash: null,
    added_by: null,
    expires_at: null,
    started_at: "2026-11-05T09:21:10Z",
    checked_at: "2026-11-05T09:22:55Z",
    error: null,
    ...over,
  };
}

function record(over: Partial<RecordRow> = {}): RecordRow {
  return {
    id: "rec-1",
    registry: "gmc",
    record_type: "doctor",
    licence_number: "9360749",
    full_name: "Christopher John Marlow Wickfold",
    status: "active",
    status_raw: "Registered with a licence to practise",
    flags: "[]",
    disciplinary: "[]",
    fields: JSON.stringify({
      registered_since: "1992-08-01",
      expiry_date: null,
      specialties: ["Infectious diseases", "Tropical medicine"],
      restrictions: [],
      raw: { gmc_reference: "9360749" },
    }),
    source_url: "https://www.gmc-uk.org/registrants/9360749",
    evidence_key: "evidence/chk-1.jpg",
    watched: 0,
    first_seen_at: "2026-11-05T09:22:55Z",
    last_checked_at: "2026-11-05T09:22:55Z",
    normalized_hash: null,
    ...over,
  };
}

function candidate(position: number, over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    check_id: "chk-2",
    position,
    licence_number: `700000${position}`,
    full_name: `Sarah JONES ${position}`,
    status_raw: "Registered with a licence to practise",
    detail: `Leeds ${position}`,
    source_url: `https://www.gmc-uk.org/registrants/700000${position}`,
    ...over,
  };
}

const ALWAYS = [
  "candidates",
  "candidates_total",
  "check_id",
  "record_id",
  "checked_at",
  "cached",
  "country",
  "disciplinary_actions",
  "evidence_screenshot_url",
  "expiry_date",
  "flags",
  "full_name",
  "licence_number",
  "method",
  "outcome",
  "profession",
  "raw_fields",
  "record_type",
  "registered_since",
  "registry",
  "registry_name",
  "restrictions",
  "source_url",
  "specialties",
  "spend_usd",
  "suggestions",
  "variants_tried",
  "watch",
];

describe("toPublicRecord", () => {
  it("omits status for ambiguous and includes how_to_resolve", () => {
    const c = check({
      id: "chk-2",
      outcome: "ambiguous",
      status: null,
      record_id: null,
      query_raw: "Sarah Jones",
      candidates_total: 12,
      variants_tried: '["Sarah Jones"]',
    });
    // Rows come back out of order; the result lists them by position.
    const r = toPublicRecord(c, null, [candidate(1), candidate(0)], BASE);

    expect(r.outcome).toBe("ambiguous");
    expect("status" in r).toBe(false);
    expect("status_raw" in r).toBe(false);
    expect("error" in r).toBe(false);
    expect(r.how_to_resolve).toBe("Repeat the check with number=<…>");
    expect(r.candidates).toEqual([
      {
        licence_number: "7000000",
        full_name: "Sarah JONES 0",
        status_raw: "Registered with a licence to practise",
        detail: "Leeds 0",
        source_url: "https://www.gmc-uk.org/registrants/7000000",
      },
      {
        licence_number: "7000001",
        full_name: "Sarah JONES 1",
        status_raw: "Registered with a licence to practise",
        detail: "Leeds 1",
        source_url: "https://www.gmc-uk.org/registrants/7000001",
      },
    ]);
    expect(r.candidates_total).toBe(12);
    expect(r.variants_tried).toEqual(["Sarah Jones"]);
    expect(r.full_name).toBeNull();
    expect(r.licence_number).toBeNull();
    expect(r.flags).toEqual([]);
    expect(Object.keys(r).sort()).toEqual([...ALWAYS, "how_to_resolve"].sort());
  });

  it("never carries a status when ambiguous, even if the row and a record say otherwise", () => {
    const c = check({ id: "chk-2", outcome: "ambiguous", status: "active", flags: '["interim_order"]' });
    const r = toPublicRecord(c, record({ flags: '["interim_order"]' }), [candidate(0), candidate(1)], BASE);
    expect("status" in r).toBe(false);
    expect("status_raw" in r).toBe(false);
    expect(r.flags).toEqual([]);
    expect(r.full_name).toBeNull();
    expect(r.candidates).toHaveLength(2);
    // candidates_total falls back to the number of candidates when the row has no total.
    expect(r.candidates_total).toBe(2);
  });

  it("builds absolute evidence and source urls", () => {
    // A base with a trailing slash and a key with a leading slash still make one clean URL.
    const m = toPublicRecord(check({ evidence_key: "evidence/chk-1.jpg" }), record(), [], "https://standing.test/");
    expect(m.evidence_screenshot_url).toBe("https://standing.test/evidence/chk-1.jpg");
    expect(toPublicRecord(check({ evidence_key: "/evidence/chk-1.jpg" }), record(), [], "https://standing.test//").evidence_screenshot_url).toBe(
      "https://standing.test/evidence/chk-1.jpg",
    );
    // A match links the record page; a result without a record links the registry's search page.
    expect(m.source_url).toBe("https://www.gmc-uk.org/registrants/9360749");
    const none = toPublicRecord(check({ outcome: "no_match", status: null, record_id: null }), null, [], BASE);
    expect(none.source_url).toBe("https://www.gmc-uk.org/registration-and-licensing/the-medical-register");
    expect(none.evidence_screenshot_url).toBeNull();
    // Only a .jpg key is a screenshot.
    expect(toPublicRecord(check({ evidence_key: "evidence/chk-1.html" }), record(), [], BASE).evidence_screenshot_url).toBeNull();
    expect(toPublicRecord(check({ evidence_key: "" }), record(), [], BASE).evidence_screenshot_url).toBeNull();
    // A match whose record has no source_url falls back to the search page.
    expect(toPublicRecord(check(), record({ source_url: null }), [], BASE).source_url).toBe(REGISTRY_META.gmc.searchUrl);
  });

  it("a match carries status from the check, status_raw and the record fields", () => {
    const watch = { watch_id: "w-1", kind: "page" as const };
    const r = toPublicRecord(
      check({ status: "conditions", flags: "[]", evidence_key: "evidence/chk-1.jpg", variants_tried: '["Christopher Wickfold"]' }),
      record({
        status: "conditions",
        flags: '["interim_order"]',
        disciplinary: JSON.stringify([
          { date: "2024-03-01", summary: "Conditions imposed", source_url: "https://www.gmc-uk.org/registrants/9360749" },
        ]),
        fields: JSON.stringify({
          registered_since: "1992-08-01",
          expiry_date: "2027-01-31",
          specialties: ["Infectious diseases"],
          restrictions: ["Must not work alone"],
          raw: { register_part: "Specialist" },
        }),
      }),
      [candidate(0)],
      BASE,
      watch,
    );
    expect(r.outcome).toBe("match");
    expect(r.status).toBe("conditions");
    expect(r.status_raw).toBe("Registered with a licence to practise");
    expect(r.flags).toEqual(["interim_order"]);
    expect(r.check_id).toBe("chk-1");
    expect(r.registry).toBe("gmc");
    expect(r.registry_name).toBe("General Medical Council");
    expect(r.country).toBe("GB");
    expect(r.record_type).toBe("doctor");
    expect(r.profession).toBeNull();
    expect(r.full_name).toBe("Christopher John Marlow Wickfold");
    expect(r.licence_number).toBe("9360749");
    expect(r.registered_since).toBe("1992-08-01");
    expect(r.expiry_date).toBe("2027-01-31");
    expect(r.specialties).toEqual(["Infectious diseases"]);
    expect(r.restrictions).toEqual(["Must not work alone"]);
    expect(r.raw_fields).toEqual({ register_part: "Specialist" });
    expect(r.disciplinary_actions).toEqual([
      { date: "2024-03-01", summary: "Conditions imposed", source_url: "https://www.gmc-uk.org/registrants/9360749" },
    ]);
    expect(r.checked_at).toBe("2026-11-05T09:22:55Z");
    expect(r.cached).toBe(false);
    expect(r.method).toBe("agent");
    expect(r.spend_usd).toBe(0.128);
    expect(r.watch).toEqual(watch);
    expect(r.variants_tried).toEqual(["Christopher Wickfold"]);
    // Candidates exist only on an ambiguous result.
    expect(r.candidates).toEqual([]);
    expect(r.candidates_total).toBe(0);
    expect("how_to_resolve" in r).toBe(false);
    expect("error" in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual([...ALWAYS, "status", "status_raw"].sort());
  });

  it("a match takes the status the check found, not the record's later one", () => {
    const r = toPublicRecord(check({ status: "active" }), record({ status: "suspended" }), [], BASE);
    expect(r.status).toBe("active");
  });

  it("a cached check says so, with the cached check's own checked_at", () => {
    const r = toPublicRecord(check({ cached_from_check_id: "chk-0", checked_at: "2026-11-04T08:00:00Z" }), record(), [], BASE);
    expect(r.cached).toBe(true);
    expect(r.checked_at).toBe("2026-11-04T08:00:00Z");
  });

  it("no_match carries variants_tried and suggestions, never a status", () => {
    const r = toPublicRecord(
      check({
        id: "chk-3",
        registry: "nmc",
        record_type: "nurse",
        outcome: "no_match",
        status: null,
        record_id: null,
        method: "agent",
        variants_tried: '["Jane Doe","Doe, Jane","Doe J"]',
        suggestions: '["Try the registration number (PIN).","The NMC search needs the exact surname."]',
        spend_usd: 0.19,
      }),
      null,
      [],
      BASE,
    );
    expect(r.outcome).toBe("no_match");
    expect("status" in r).toBe(false);
    expect("status_raw" in r).toBe(false);
    expect("how_to_resolve" in r).toBe(false);
    expect(r.variants_tried).toEqual(["Jane Doe", "Doe, Jane", "Doe J"]);
    expect(r.suggestions).toEqual(["Try the registration number (PIN).", "The NMC search needs the exact surname."]);
    expect(r.registry_name).toBe("Nursing and Midwifery Council");
    expect(r.country).toBe("GB");
    expect(r.source_url).toBe("https://www.nmc.org.uk/registration/search-the-register/");
    expect(r.candidates).toEqual([]);
    expect(r.candidates_total).toBe(0);
    expect(r.flags).toEqual([]);
    expect(r.full_name).toBeNull();
    expect(r.licence_number).toBeNull();
    expect(r.registered_since).toBeNull();
    expect(r.expiry_date).toBeNull();
    expect(r.disciplinary_actions).toEqual([]);
    expect(r.restrictions).toEqual([]);
    expect(r.specialties).toEqual([]);
    expect(r.raw_fields).toEqual({});
    expect(r.spend_usd).toBe(0.19);
    expect(Object.keys(r).sort()).toEqual([...ALWAYS].sort());
  });

  it("record fields are dropped for non-match outcomes even when a record is passed", () => {
    const r = toPublicRecord(check({ outcome: "no_match", status: null }), record(), [], BASE);
    expect(r.full_name).toBeNull();
    expect(r.specialties).toEqual([]);
    expect(r.raw_fields).toEqual({});
    expect(r.source_url).toBe(REGISTRY_META.gmc.searchUrl);
  });

  it("an error carries its message and no status", () => {
    const r = toPublicRecord(
      check({ outcome: "error", status: null, record_id: null, method: null, checked_at: null, error: "busy", spend_usd: null }),
      null,
      [],
      BASE,
    );
    expect(r.outcome).toBe("error");
    expect(r.error).toBe("busy");
    expect("status" in r).toBe(false);
    expect("how_to_resolve" in r).toBe(false);
    expect(r.method).toBeNull();
    expect(r.checked_at).toBeNull();
    expect(r.spend_usd).toBe(0);
    expect(r.source_url).toBe(REGISTRY_META.gmc.searchUrl);
    expect(Object.keys(r).sort()).toEqual([...ALWAYS, "error"].sort());
  });

  it("unsupported, and a row with no registry, do not throw and link no source", () => {
    const r = toPublicRecord(
      check({ outcome: "unsupported", status: null, record_id: null, registry: null, record_type: "contractor", jurisdiction: "GB", method: null }),
      null,
      [],
      BASE,
    );
    expect(r.outcome).toBe("unsupported");
    expect("status" in r).toBe(false);
    expect(r.registry).toBeNull();
    expect(r.registry_name).toBeNull();
    expect(r.country).toBe("GB");
    expect(r.source_url).toBeNull();
    expect(r.record_type).toBe("contractor");

    // A registry id this build does not know is treated the same way (an old row).
    const old = toPublicRecord(check({ registry: "fca", jurisdiction: "GB", outcome: "unsupported", status: null }), null, [], BASE);
    expect(old.registry).toBe("fca");
    expect(old.registry_name).toBeNull();
    expect(old.source_url).toBeNull();
    // Names that are Object.prototype members are not registries.
    expect(toPublicRecord(check({ registry: "constructor", outcome: "unsupported", status: null }), null, [], BASE).registry_name).toBeNull();
  });

  it("parses stored JSON defensively and never throws", () => {
    const r = toPublicRecord(
      check({ variants_tried: "not json", suggestions: '{"a":1}' }),
      record({ flags: "[", disciplinary: "oops", fields: "{bad" }),
      [],
      BASE,
    );
    expect(r.variants_tried).toEqual([]);
    expect(r.suggestions).toEqual([]);
    expect(r.flags).toEqual([]);
    expect(r.disciplinary_actions).toEqual([]);
    expect(r.registered_since).toBeNull();
    expect(r.specialties).toEqual([]);
    expect(r.raw_fields).toEqual({});

    // Missing JSON (records.fields has no default) and wrong shapes give the empty value.
    const r2 = toPublicRecord(
      check({ variants_tried: '[1, "ok", null]' }),
      record({
        fields: null,
        flags: '["interim_order","made_up",3]',
        disciplinary: '[{"date":null,"summary":"x","source_url":null},"junk",{"summary":5}]',
      }),
      [],
      BASE,
    );
    expect(r2.variants_tried).toEqual(["ok"]);
    expect(r2.flags).toEqual(["interim_order"]);
    expect(r2.disciplinary_actions).toEqual([{ date: null, summary: "x", source_url: null }]);
    expect(r2.registered_since).toBeNull();
    expect(r2.expiry_date).toBeNull();
    expect(r2.restrictions).toEqual([]);
    expect(r2.raw_fields).toEqual({});

    const r3 = toPublicRecord(
      check(),
      record({ fields: JSON.stringify({ registered_since: 1992, specialties: "Cardiology", restrictions: [1, "r"], raw: [1, 2] }) }),
      [],
      BASE,
    );
    expect(r3.registered_since).toBeNull();
    expect(r3.specialties).toEqual([]);
    expect(r3.restrictions).toEqual(["r"]);
    expect(r3.raw_fields).toEqual({});
  });

  it("a match with no record still returns a status and empty record fields", () => {
    const r = toPublicRecord(check({ status: null }), null, [], BASE);
    expect(r.outcome).toBe("match");
    expect(r.status).toBe("unknown");
    expect(r.status_raw).toBeNull();
    expect(r.full_name).toBeNull();
    expect(r.source_url).toBe(REGISTRY_META.gmc.searchUrl);
  });
});
