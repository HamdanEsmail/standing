// The site shares the Worker with the API. These tests hold the line between them: switched off,
// every path answers exactly as before the site existed; switched on, the API, hooks and evidence
// still answer as they always did, and every HTML response carries the security headers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callWorker } from "./helpers/app";
import { freshState, restoreState } from "./helpers/checks";
import { callWith } from "./helpers/site";

beforeEach(freshState);
afterEach(restoreState);

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

describe("site shell", () => {
  it("switched off, the home and any screen path answer Hono's plain 404, as before the site", async () => {
    for (const path of ["/", "/coverage", "/no/such/screen"]) {
      const res = await callWith({ SITE_ENABLED: "0" }, path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("404 Not Found");
      expect(res.headers.get("content-security-policy"), path).toBeNull();
    }
    const stats = await callWith({ SITE_ENABLED: "0" }, "/api/stats");
    expect(stats.status).toBe(200);
  });

  it("switched on, the API, the hooks and the evidence files keep their own answers", async () => {
    const api = await callWorker("/api/no-such-route");
    expect(api.status).toBe(404);
    expect(await api.text()).toBe("404 Not Found");
    const evidence = await callWorker("/evidence/not-a-key.jpg");
    expect(evidence.status).toBe(404);
    expect(await evidence.json()).toEqual({ error: "not_found" });
    const hook = await callWorker("/hooks/monitor/wrong-secret", { method: "POST", body: "{}" });
    expect(hook.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("switched on, an unknown screen is the site's 404 page with the security headers", async () => {
    const res = await callWorker("/no/such/screen");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("No such page.");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
  });

  it("every screen carries absolute link-preview tags (their title is the page title, which never names a person)", async () => {
    const html = await (await callWorker("/coverage")).text();
    expect(html).toContain('<meta property="og:title" content="Coverage · Standing"/>');
    expect(html).toContain('<meta property="og:url" content="https://standing.test/coverage"/>');
    expect(html).toContain('<meta property="og:image" content="https://standing.test/assets/social.png"/>');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
  });

  it("every screen names who built it, with a link to his GitHub, in the footer", async () => {
    for (const path of ["/", "/coverage", "/about"]) {
      const html = await (await callWorker(path)).text();
      expect(html).toContain('<p>Built by <a href="https://github.com/HamdanEsmail" rel="author">Hamdan Esmail</a></p>');
      expect(html).toContain('<meta name="author" content="Hamdan Esmail"/>');
    }
  });

  it("sends the security headers on the home", async () => {
    const res = await callWorker("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});
