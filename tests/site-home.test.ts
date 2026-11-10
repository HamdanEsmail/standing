// The home's opening: the headline, the check form, the examples, and one stored record shown honestly
// (a stored result is never called live; register text is escaped; nothing loads from another host).
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshCheck } from "../src/site/components";
import { recordView } from "../src/monitoring/events";
import { getRecord, upsertRecord } from "../src/db/records";
import { insertCandidates, insertCheck } from "../src/db/checks";
import { insertEvent } from "../src/db/events";
import { insertWatch } from "../src/db/watches";
import { listAdapters } from "../src/registries/index";
import { callWorker } from "./helpers/app";
import { freshState, restoreState } from "./helpers/checks";
import { byClass, EVIDENCE_CHECK, seedCompany, textOf } from "./helpers/site";

beforeEach(freshState);
afterEach(restoreState);

async function home(): Promise<string> {
  const res = await callWorker("/");
  expect(res.status).toBe(200);
  return res.text();
}

describe("site home", () => {
  it("leads with the headline and a form that posts q, record_type, place and number to /check", async () => {
    const html = await home();
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)![1]!;
    expect(textOf(h1)).toBe("The register's own answer, read a minute ago.");
    const form = /<form class="form" method="post" action="\/check">([\s\S]*?)<\/form>/.exec(html)![1]!;
    for (const name of ["q", "record_type", "place", "number"]) expect(form).toContain(`name="${name}"`);
    expect(textOf(form)).toContain("Some registers answer in seconds. Those that need a real browser can take a minute or two.");
    // The three examples are small forms posting preset values; the Florida one replaced California contractors.
    expect(html.match(/<form class="inline" method="post" action="\/check">/g)).toHaveLength(3);
    expect(html).toContain('value="Publix Asset Management Company"');
  });

  it("the check button says what it is doing once pressed, and every page carries the script that shows it", async () => {
    const html = await home();
    expect(html).toMatch(/<button class="btn" type="submit" data-busy="Reading the register…">\s*Check the register\s*<\/button>/);
    for (const path of ["/", "/coverage", "/watchlist", "/about", "/api"]) {
      const page = await (await callWorker(path)).text();
      expect(page, path).toContain('<script src="/assets/wait.js" defer=""></script>');
    }
  });

  it("on a fresh deploy with nothing watched, the page opens with the form and no record card", async () => {
    const html = await home();
    expect(html).not.toContain('class="record');
    expect(textOf(html)).toContain("6 registers");
    expect(textOf(html)).toContain("2 countries");
  });

  it("shows the newest curated record: status word, the register's wording, name, number and the evidence line", async () => {
    await seedCompany();
    const html = await home();
    expect(byClass(html, "status-word")).toMatch(/class="status-word active"[^>]*>Active</);
    const text = textOf(html);
    expect(text).toContain("The register says: “Active — Active proposal to strike off”");
    expect(text).toContain("ADA FICTITIOUS TRADING LIMITED 99000001");
    expect(text).toContain("Proposal to strike off");
    expect(textOf(byClass(html, "evidence")!)).toBe("Companies House · read 9 Nov 2026, 07:55 UTC · Fetch · stored result · source ↗");
    // Evidence by path, never by the absolute PUBLIC_BASE_URL form the JSON carries.
    expect(html).toContain(`src="/evidence/${EVIDENCE_CHECK}.jpg"`);
    expect(html).not.toContain("https://standing.test/evidence/");
  });

  it("a record whose latest check is a cached copy says stored result, never live", async () => {
    await seedCompany({ cached: true });
    const html = await home();
    const card = /<article class="record[\s\S]*?<\/article>/.exec(html)![0];
    expect(textOf(card)).toContain("stored result");
    expect(textOf(card)).not.toMatch(/\blive\b/);
  });

  it("escapes register text: markup and right-to-left text in a name stay text", async () => {
    await seedCompany({ name: "O'BRIEN <b>BOLD</b> ‮TRADING LIMITED" });
    const html = await home();
    expect(html).not.toContain("<b>BOLD</b>");
    expect(html).toContain("&lt;b&gt;BOLD&lt;/b&gt;");
    expect(textOf(html)).toContain("O'BRIEN <b>BOLD</b>");
  });

  it("loads nothing from another host: every src, stylesheet, script and form action is on this site", async () => {
    await seedCompany();
    const html = await home();
    // Links to the register itself (`source ↗`) are plain <a href> to the register, which the evidence
    // line must carry; what is checked here is everything the browser would load or post on its own.
    const loads = [...html.matchAll(/<(?:img|script|iframe)\b[^>]*\bsrc="([^"]*)"|<link\b[^>]*\bhref="([^"]*)"|<form\b[^>]*\baction="([^"]*)"/g)].map(
      (m) => m[1] ?? m[2] ?? m[3]!,
    );
    expect(loads.length).toBeGreaterThan(5);
    for (const url of loads) expect(url, url).toMatch(/^\/(?!\/)/);
  });

  it("prices a fresh check by the method it would take", async () => {
    const { recordId } = await seedCompany();
    const ch = recordView(env, (await getRecord(env.DB, recordId))!, null, null);
    if (ch.outcome !== "match") throw new Error("not a match");
    expect(freshCheck(ch)).toMatchObject({ method: "fetch", fields: { number: "99000001", place: "GB", force: "1" } });
    expect(textOf(await home())).toContain("Fresh check ($0.00)");

    // NMC has no record page: a number check goes to the Agent, priced at its estimate.
    const nmcId = await upsertRecord(env.DB, {
      registry: "nmc",
      record_type: "nurse",
      record: { full_name: "Ada Fictitious", licence_number: "99A9999O", status_raw: "Registered", status: "active", flags: [], disciplinary: [] },
      source_url: null,
    });
    const nmc = recordView(env, (await getRecord(env.DB, nmcId))!, null, null);
    if (nmc.outcome !== "match") throw new Error("not a match");
    expect(freshCheck(nmc)).toMatchObject({ method: "agent", fields: { number: "99A9999O" } });

    // Sunbiz is looked up by name only.
    const flId = await upsertRecord(env.DB, {
      registry: "fl-sunbiz",
      record_type: "company",
      record: { full_name: "ADA FICTITIOUS INC", licence_number: "P99000000001", status_raw: "ACTIVE", status: "active", flags: [], disciplinary: [] },
      source_url: null,
    });
    const fl = recordView(env, (await getRecord(env.DB, flId))!, null, null);
    if (fl.outcome !== "match") throw new Error("not a match");
    expect(freshCheck(fl)).toMatchObject({ method: "fetch", fields: { q: "ADA FICTITIOUS INC", place: "US-FL" } });
    expect(freshCheck(fl)!.fields.number).toBeUndefined();
  });

  it("below the opening, in the comp's order: the ambiguity example, how a check works, status changes, registers, the bounty proof", async () => {
    await seedCompany();
    // A stored ambiguous check that does not expire (an admin check), with its candidates.
    const amb = await insertCheck(env.DB, {
      state: "done", registry: "companies-house", record_type: "company", jurisdiction: "GB", query_raw: "Greggs", outcome: "ambiguous",
      method: "fetch", candidates_total: 20, added_by: "admin", checked_at: "2026-11-09T08:40:00.000Z",
    });
    await insertCandidates(env.DB, amb, [
      { name: "GREGGS PLC", number: "00502851", status_raw: null, detail: "Incorporated on 29 December 1951", url: null },
      { name: "GREGGS ACADEMIC SERVICES LTD", number: "SC702856", status_raw: "Dissolved on 11 August 2026", detail: null, url: null },
    ]);
    // A search for nonsense, stored later: the register lists its nearest names; never the example.
    const junk = await insertCheck(env.DB, {
      state: "done", registry: "companies-house", record_type: "company", jurisdiction: "GB", query_raw: "Zqxvort Plimbany", outcome: "ambiguous",
      method: "fetch", candidates_total: 20, added_by: "admin", checked_at: "2026-11-09T09:00:00.000Z",
    });
    await insertCandidates(env.DB, junk, [{ name: "ZOO LIMITED", number: "01234567", status_raw: null, detail: null, url: null }]);
    const html = await home();
    expect(html).not.toContain(junk);
    const order = ["When the name is not enough", "How a check works", "Status changes caught", "registers at launch", "Built for the TinyFish TinyVerify bounty"].map((t) =>
      html.indexOf(t),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const ambiguity = html.slice(order[0], order[1]);
    expect(ambiguity).toMatch(/class="status-word[^"]*"[^>]*>Ambiguous</);
    expect(ambiguity).not.toMatch(/status-word (?:active|dissolved)|chip (?:ok|warn|bad)/);
    expect(textOf(ambiguity)).toContain("GREGGS ACADEMIC SERVICES LTD");
    expect(ambiguity).toContain(`href="/checks/${amb}"`);

    const how = textOf(html.slice(order[1], order[2]));
    for (const service of ["Agent", "Fetch", "Monitor"]) expect(how).toContain(service);

    // No event yet: the honest empty line, no invented rows.
    expect(textOf(html.slice(order[2], order[3]))).toContain("No status change yet. 1 record is watched.");
    for (const a of listAdapters()) expect(textOf(html.slice(order[3], order[4]))).toContain(a.name);

    const proof = html.slice(order[4]);
    expect(proof.match(/<tr class="req">/g)).toHaveLength(5);
    expect(textOf(proof)).toMatch(/TinyFish spend \$\d+\.\d{2}/);
    expect(proof).toContain(`href="/checks/${amb}"`);
  });

  it("the ambiguity block is absent when no stored example exists, and a status change shows both words, a person by type and number", async () => {
    const recordId = await upsertRecord(env.DB, {
      registry: "gmc",
      record_type: "doctor",
      record: { full_name: "Ada Fictitious", licence_number: "9999999", status_raw: "Suspended", status: "suspended", flags: [], disciplinary: [] },
      source_url: "https://www.gmc-uk.org/registrants/9999999",
    });
    await insertWatch(env.DB, { record_id: recordId, kind: "page", monitor_id: "m-gmc", added_by: "admin" });
    await env.DB.prepare("UPDATE records SET watched = 1 WHERE id = ?").bind(recordId).run();
    await insertEvent(env.DB, {
      record_id: recordId, kind: "status_change", fields: ["status"],
      before: { status: "active", status_raw: "Registered with a licence to practise", flags: [], disciplinary: [] },
      after: { status: "suspended", status_raw: "Suspended", flags: [], disciplinary: [] },
      at: "2026-11-12T09:14:00.000Z",
    });
    const html = await home();
    expect(html).not.toContain("When the name is not enough");
    const feed = /<div class="changes">[\s\S]*?<\/div>\s*<\/section>/.exec(html)![0];
    expect(feed).toMatch(/class="chip ok"[^>]*>Active</);
    expect(feed).toMatch(/class="chip bad"[^>]*>Suspended</);
    expect(textOf(feed)).toContain("Doctor · GMC 9999999");
    expect(html).not.toContain("Ada");
  });
});
