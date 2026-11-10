// The check flow on the site: the form post, the result page for every outcome, the pending page that
// refreshes itself and where it stops, and the receipt. The strings asserted here are the plan's
// "Honest states" copy.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_CHECKS_PER_IP_PER_DAY } from "../src/core/limits";
import { insertCheck } from "../src/db/checks";
import { insertWatch } from "../src/db/watches";
import { companiesHouse } from "../src/registries/companies-house";
import { runningLine, waitClock } from "../src/site/format";
import chCompany from "./fixtures/registries/ch-company.md?raw";
import fetchChSearch from "./fixtures/tinyfish/fetch-ch-search.json";
import { callWorker } from "./helpers/app";
import { agentCallback, callsTo, FETCH_API, freshState, mockFetchPages, mockStartRun, pageResponse, restoreState, RUN_ASYNC_API } from "./helpers/checks";
import { textOf } from "./helpers/site";

beforeEach(freshState);
afterEach(restoreState);

const CH_COMPANY_URL = "https://find-and-update.company-information.service.gov.uk/company/00502851";
const IP = "203.0.113.9";

/** Posts the check form as a browser does. */
function postForm(fields: Record<string, string>, ip = IP): Promise<Response> {
  return callWorker("/check", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

/** Posts the form, follows the 303 and returns the check id and its page. */
async function check(fields: Record<string, string>): Promise<{ id: string; html: string }> {
  const res = await postForm(fields);
  expect(res.status, await res.clone().text()).toBe(303);
  const location = res.headers.get("location")!;
  const id = /^\/checks\/([0-9a-f-]{36})$/.exec(location)![1]!;
  return { id, html: await page(location) };
}

async function page(path: string, status = 200): Promise<string> {
  const res = await callWorker(path);
  expect(res.status, path).toBe(status);
  return res.text();
}

const refreshOf = (html: string): string | null => /<meta http-equiv="refresh" content="([^"]*)"/.exec(html)?.[1] ?? null;
/** Any colour a status may carry: on a page without a match there must be none. */
const STATUS_COLOUR = /class="[^"]*\b(?:status-word (?:active|conditions|suspended|removed|not_licensed|expired|dissolved|insolvency)|chip (?:ok|warn|bad))\b/;

const chNumber = { q: "", number: "00502851", record_type: "company", place: "GB" };

describe("site check flow", () => {
  it("a match: status word, field sheet in the register's order, evidence by path, live evidence line and the actions", async () => {
    mockFetchPages({ [CH_COMPANY_URL]: pageResponse(CH_COMPANY_URL, chCompany) });
    const { id, html } = await check(chNumber);
    expect(html).toMatch(/class="status-word active"[^>]*>Active</);
    const text = textOf(html);
    expect(text).toContain("The register says: “Active”");
    expect(text).toContain("GREGGS PLC 00502851");
    const labels = [...html.matchAll(/<th scope="row">([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(labels.slice(0, 3)).toEqual(["Company type", "Incorporated on", "Registered office"]);
    expect(html).toContain(`src="/evidence/${id}.jpg"`);
    expect(text).toMatch(/Companies House · read \d+ \w{3} \d{4}, \d{2}:\d{2} UTC · Fetch · live · source ↗/);
    expect(text).toContain("Watch this record");
    expect(text).toContain("Fresh check ($0.00)");
    expect(html).toContain(`href="/api/checks/${id}"`);
    expect(html).toContain(`href="/checks/${id}/receipt"`);
    expect(text).toContain("Receipt (print or save as PDF)");
    expect(refreshOf(html)).toBeNull();
  });

  it("a watched record's result shows its watch, not the button", async () => {
    mockFetchPages({ [CH_COMPANY_URL]: pageResponse(CH_COMPANY_URL, chCompany) });
    const { id } = await check(chNumber);
    const recordId = (await env.DB.prepare("SELECT record_id FROM checks WHERE id = ?").bind(id).first<string>("record_id"))!;
    await insertWatch(env.DB, { record_id: recordId, kind: "page", monitor_id: "m-site-1", added_by: "curated" });
    const text = textOf(await page(`/checks/${id}`));
    expect(text).toContain("Watching · Page monitor");
    expect(text).not.toContain("Watch this record");
  });

  it("replaying the same form post returns the same check and reads the register once", async () => {
    mockFetchPages({ [CH_COMPANY_URL]: pageResponse(CH_COMPANY_URL, chCompany) });
    const first = await check(chNumber);
    const reads = callsTo("POST", FETCH_API).length;
    const again = await check(chNumber);
    expect(again.id).toBe(first.id);
    expect(callsTo("POST", FETCH_API)).toHaveLength(reads);

    // Another visitor gets a cached copy; their "Fresh check" right after it reads the register again.
    const other = "198.51.100.77";
    const copy = /\/checks\/([0-9a-f-]{36})/.exec((await postForm(chNumber, other)).headers.get("location")!)![1]!;
    expect(copy).not.toBe(first.id);
    const fresh = /\/checks\/([0-9a-f-]{36})/.exec((await postForm({ ...chNumber, force: "1" }, other)).headers.get("location")!)![1]!;
    expect(fresh).not.toBe(copy);
    expect(callsTo("POST", FETCH_API)).toHaveLength(reads + 1);
  });

  it("a cached result says stored result on its page and its receipt, never live", async () => {
    mockFetchPages({ [CH_COMPANY_URL]: pageResponse(CH_COMPANY_URL, chCompany) });
    await check(chNumber);
    const copy = await postForm(chNumber, "198.51.100.77");
    const id = /\/checks\/([0-9a-f-]{36})/.exec(copy.headers.get("location")!)![1]!;
    for (const html of [await page(`/checks/${id}`), await page(`/checks/${id}/receipt`)]) {
      const evidence = textOf(/<p class="evidence">[\s\S]*?<\/p>/.exec(html)![0]);
      expect(evidence).toContain("stored result");
      expect(evidence).not.toMatch(/\blive\b/);
    }
  });

  it("an ambiguous name: neutral AMBIGUOUS, the count line, candidates with Verify this one, and no status colour anywhere", async () => {
    mockFetchPages({ [companiesHouse.searchQueryUrl("Greggs")]: fetchChSearch });
    const { html } = await check({ q: "Greggs", number: "", record_type: "company", place: "GB" });
    expect(html).toMatch(/class="status-word"[^>]*>Ambiguous</);
    expect(html).not.toMatch(STATUS_COLOUR);
    const text = textOf(html);
    expect(text).toContain("20 records match “Greggs”. Standing gives no status until one is chosen.");
    const verify = [...html.matchAll(/<form class="inline" method="post" action="\/check">([\s\S]*?)<\/form>/g)].filter((m) => m[1]!.includes("Verify this one"));
    expect(verify).toHaveLength(10);
    expect(verify[0]![1]).toMatch(/name="number" value="[0-9A-Z]{8}"/);
    expect(verify[0]![1]).not.toContain('name="q"');
  });

  it("no match: the register, the query as typed and what was tried, with the suggestions", async () => {
    const url = companiesHouse.searchQueryUrl("ZZTest Nothing Ltd");
    mockFetchPages({ [url]: pageResponse(url, "No results") });
    const { html } = await check({ q: "ZZTest Nothing Ltd", number: "", record_type: "company", place: "GB" });
    expect(html).toMatch(/class="status-word"[^>]*>No match</);
    const text = textOf(html);
    expect(text).toContain("The Companies House search returned no result for “ZZTest Nothing Ltd”. Tried: ZZTest Nothing Ltd.");
    for (const s of companiesHouse.noMatchSuggestions ?? []) expect(text).toContain(s);
  });

  it("an unsupported pair is NOT SUPPORTED with a reason, and costs nothing", async () => {
    const res = await postForm({ q: "Ada Fictitious", number: "", record_type: "doctor", place: "US-FL" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/class="status-word"[^>]*>Not supported</);
    expect(textOf(html)).toContain("Standing reads no register for doctors in Florida, US.");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM checks").first("n")).toBe(0);
  });

  it("a failed Agent run is CHECK FAILED with the registry's line", async () => {
    mockStartRun("run-site-failed");
    const { id } = await check({ q: "Ada Fictitious", number: "", record_type: "doctor", place: "GB" });
    await agentCallback({ run_id: "run-site-failed", status: "FAILED", num_of_steps: 2, error: { message: "x", code: "x" } });
    const html = await page(`/checks/${id}`);
    expect(html).toMatch(/class="status-word"[^>]*>Check failed</);
    expect(textOf(html)).toContain("The General Medical Council search did not finish. Nothing was guessed. Try again, or check by registration number.");
    expect(refreshOf(html)).toBeNull();
  });

  it("a pending check refreshes itself every 3 seconds with a counter, and stops at 60 with the still-waiting copy", async () => {
    mockStartRun("run-site-pending");
    const { id, html } = await check({ q: "Ada Fictitious", number: "", record_type: "doctor", place: "GB" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    expect(textOf(html)).toContain("Reading the register now. In a real browser that takes a minute or two. This page refreshes by itself.");
    // What a visitor sees while waiting: the three steps with the one it is on, a moving bar, and a clock that counts.
    expect(html).toMatch(/<ol class="steps"[^>]*><li class="done">Wait for a free browser<\/li><li aria-current="step">Read the register<\/li><li>Show its answer<\/li><\/ol>/);
    expect(html).toMatch(/<div class="bar" role="progressbar" aria-label="Reading the register"><\/div>/);
    expect(html).toMatch(/<span class="clock" data-since="\d{4}-\d{2}-\d{2}T[\d:.]+Z">0:0\d<\/span> so far/);
    expect(html).toContain('<script src="/assets/wait.js" defer=""></script>');
    expect(refreshOf(html)).toBe(`3; url=/checks/${id}?w=1`);
    expect(refreshOf(await page(`/checks/${id}?w=59`))).toBe(`3; url=/checks/${id}?w=60`);
    const stopped = await page(`/checks/${id}?w=60`);
    expect(refreshOf(stopped)).toBeNull();
    // A page that has stopped reloading shows no moving bar and no counting clock.
    expect(stopped).not.toContain('class="bar"');
    expect(stopped).not.toContain("data-since");
    expect(textOf(stopped)).toContain("Still waiting. The register has not answered yet.");
    expect(stopped).toMatch(new RegExp(`<a[^>]*href="/checks/${id}"[^>]*>Look again</a>`));
    // A junk counter starts again from 0.
    expect(refreshOf(await page(`/checks/${id}?w=abc`))).toBe(`3; url=/checks/${id}?w=1`);
  });

  it("a check waiting for the Agent slot says so", async () => {
    await env.DB.prepare("UPDATE agent_slot SET holder_check_id = 'someone-else', since = ? WHERE id = 1").bind(new Date().toISOString()).run();
    const id = await insertCheck(env.DB, { state: "pending", registry: "gmc", record_type: "doctor", jurisdiction: "GB", query_raw: "Ada Fictitious", method: "agent", trigger: "request", started_at: new Date().toISOString() });
    const html = await page(`/checks/${id}`);
    expect(textOf(html)).toContain(
      "Waiting for a free browser. One register search runs at a time, and each takes a minute or two. This page refreshes by itself.",
    );
    expect(html).toMatch(/<ol class="steps"[^>]*><li aria-current="step">Wait for a free browser<\/li><li>Read the register<\/li><li>Show its answer<\/li><\/ol>/);
    expect(html).toMatch(/<div class="bar" role="progressbar" aria-label="Waiting for a free browser"><\/div>/);
    expect(refreshOf(html)).toBe(`3; url=/checks/${id}?w=1`);
  });

  it("a running check says how long it takes and how long ago it was started", async () => {
    const now = new Date("2026-11-10T12:00:00.000Z");
    const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
    expect(runningLine("agent")).toBe("Reading the register now. In a real browser that takes a minute or two. This page refreshes by itself.");
    expect(runningLine("fetch")).toBe("Reading the register now. That takes a few seconds. This page refreshes by itself.");
    expect(runningLine(null)).toBe("Reading the register now. That takes a few seconds. This page refreshes by itself.");
    // The clock: minutes and seconds since the check was started, never negative, nothing without a start.
    expect(waitClock(at(47), now)).toBe("0:47");
    expect(waitClock(at(5), now)).toBe("0:05");
    expect(waitClock(at(135), now)).toBe("2:15");
    expect(waitClock(at(-30), now)).toBe("0:00");
    expect(waitClock(null, now)).toBeNull();
    expect(waitClock("not a time", now)).toBeNull();
  });

  it("invalid input re-renders the home form with a field error, status 400", async () => {
    const res = await postForm({ q: "", number: "", record_type: "company", place: "GB" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('action="/check"');
    expect(html).toMatch(/<p class="field-error"[^>]*>[^<]+<\/p>/);
  });

  it("refusals say why: the spending line, and this visitor's daily checks", async () => {
    await env.DB.prepare("INSERT INTO spend (id, at, kind, amount_usd, ref) VALUES ('s-test', ?, 'agent_step', 4, 'test')").bind(new Date().toISOString()).run();
    const paused = await postForm({ q: "Ada Fictitious", number: "", record_type: "doctor", place: "GB" });
    expect(paused.status).toBe(503);
    expect(textOf(await paused.text())).toContain(
      "Live checks are paused: Standing has reached its spending line of $4. Stored results and watched records are still shown.",
    );
    await env.DB.prepare("DELETE FROM spend").run();

    // The day's allowance per visitor (each a different name: a repeat would only reopen the first).
    const names = Array.from({ length: PUBLIC_CHECKS_PER_IP_PER_DAY + 1 }, (_, i) => `ZZTest Number ${i + 1} Ltd`);
    mockFetchPages(Object.fromEntries(names.map((n) => [companiesHouse.searchQueryUrl(n), pageResponse(companiesHouse.searchQueryUrl(n), "No results")])));
    for (const n of names.slice(0, PUBLIC_CHECKS_PER_IP_PER_DAY)) expect((await postForm({ q: n, number: "", record_type: "company", place: "GB" })).status).toBe(303);
    const over = await postForm({ q: names[PUBLIC_CHECKS_PER_IP_PER_DAY]!, number: "", record_type: "company", place: "GB" });
    expect(over.status).toBe(429);
    expect(textOf(await over.text())).toContain(`You have used today's ${PUBLIC_CHECKS_PER_IP_PER_DAY} live checks. Stored results still open.`);
  });

  it("the receipt: a match only, with the heading, the reading line, the check id and the live address", async () => {
    mockFetchPages({ [CH_COMPANY_URL]: pageResponse(CH_COMPANY_URL, chCompany) });
    const { id } = await check(chNumber);
    const html = await page(`/checks/${id}/receipt`);
    const text = textOf(html);
    expect(text).toContain("Verification receipt");
    expect(html).toMatch(/class="status-word active"[^>]*>Active</);
    expect(text).toMatch(/Read from Companies House on \d+ \w{3} \d{4}, \d{2}:\d{2} UTC\. This receipt shows what the register said at that moment; check again for today's status\./);
    expect(text).toContain(id);
    expect(text).toContain(`https://standing.test/checks/${id}`);
    expect(text).toMatch(/available until \d+ \w{3} \d{4}, \d{2}:\d{2} UTC/i);
    expect(html).toContain(`src="/evidence/${id}.jpg"`);

    mockFetchPages({ [companiesHouse.searchQueryUrl("Greggs")]: fetchChSearch });
    const amb = await check({ q: "Greggs", number: "", record_type: "company", place: "GB" });
    await page(`/checks/${amb.id}/receipt`, 404);
    await page("/checks/00000000-0000-4000-8000-000000000000", 404);
  });
});
