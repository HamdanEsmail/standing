// Coverage, API and About: the reference pages. What is tested is what can be wrong: every register
// listed with its reason, the API examples against PUBLIC_BASE_URL with samples from stored checks, the
// spend per TinyFish service from the ledger, and the source link only when REPO_URL is set.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAdapters, UNSUPPORTED } from "../src/registries/index";
import { callWorker } from "./helpers/app";
import { freshState, restoreState } from "./helpers/checks";
import { callWith, seedCompany, textOf } from "./helpers/site";

beforeEach(freshState);
afterEach(restoreState);

async function page(path: string): Promise<string> {
  const res = await callWorker(path);
  expect(res.status, path).toBe(200);
  expect(res.headers.get("content-security-policy"), path).toContain("default-src 'self'");
  return res.text();
}

describe("site reference pages", () => {
  it("coverage lists every register, supported and not, with how it is read and watched, and each reason", async () => {
    const text = textOf(await page("/coverage"));
    for (const a of listAdapters()) expect(text).toContain(a.name);
    for (const u of UNSUPPORTED) expect(text).toContain(u.registry);
    expect(text).toContain("the licence page cannot be read reliably by automated tools yet");
    expect(text).toContain("Page monitor on the record page");
  });

  it("the API page gives each endpoint a curl example against PUBLIC_BASE_URL, and samples from stored checks", async () => {
    const empty = textOf(await page("/api"));
    expect(empty).toContain("curl https://standing.test/api/stats");
    expect(empty).toContain("curl -X POST https://standing.test/api/checks");
    for (const path of ["/api/checks/", "/api/records/", "/api/events", "/api/export.json", "/api/registries"]) expect(empty).toContain(path);
    expect(empty).toContain("No stored match yet.");

    const { checkId } = await seedCompany();
    const html = await page("/api");
    expect(html).toContain(checkId);
    expect(textOf(html)).not.toContain("No stored match yet.");
  });

  it("About shows the spend of each TinyFish service from the ledger, and the source link only when REPO_URL is set", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO spend (id, at, kind, amount_usd, ref) VALUES ('a', ?1, 'agent_step', 0.176, 'x'), ('b', ?1, 'screenshot', 0.002, 'y'), ('c', ?1, 'monitor_check', 0.005, 'z')",
    )
      .bind(now)
      .run();
    const html = await page("/about");
    const services = /<table class="table services[\s\S]*?<\/table>/.exec(html)![0];
    const rows = Object.fromEntries([...services.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => textOf(m[1]!)).map((t) => [t.split(" ")[0], t]));
    expect(rows.Agent).toContain("$0.18");
    expect(rows.Browser).toContain("$0.00");
    expect(rows.Monitor).toContain("$0.01");
    expect(textOf(html)).toContain("deleted after 24 hours");
    expect(html).not.toContain("Source code");

    const withRepo = await (await callWith({ REPO_URL: "https://github.com/example/standing" }, "/about")).text();
    expect(withRepo).toMatch(/<a href="https:\/\/github.com\/example\/standing"[^>]*>Source code/);
  });

  it("switched off, /api, /coverage and /about answer as before the site", async () => {
    for (const path of ["/api", "/coverage", "/about"]) {
      const res = await callWith({ SITE_ENABLED: "0" }, path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("404 Not Found");
    }
  });
});
