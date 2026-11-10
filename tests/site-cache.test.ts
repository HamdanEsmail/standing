// Stored copies of the screens many people open: served from R2 with the cache header, dropped when an
// event, a watch change or a new read alters what they show, dropped by the hourly job, never kept for a
// pending check, an admin's view or a URL with a query, and never shared across deploys.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron";
import { insertCheck } from "../src/db/checks";
import { insertWatch } from "../src/db/watches";
import { writeEvent } from "../src/monitoring/events";
import { CACHE_HEADER } from "../src/site/htmlCache";
import chCompany from "./fixtures/registries/ch-company.md?raw";
import { freshState, mockFetchPages, pageResponse, restoreState } from "./helpers/checks";
import { callWith, seedCompany } from "./helpers/site";

beforeEach(freshState);
afterEach(restoreState);

const ON = { HTML_CACHE: "1" } as const;
const get = (path: string, over: Record<string, unknown> = {}) => callWith({ ...ON, ...over } as never, path);

async function storedKeys(): Promise<string[]> {
  return (await env.STORE.list({ prefix: "screens/" })).objects.map((o) => o.key);
}

describe("site stored copies", () => {
  it("the home, coverage, API, About, watchlist and a watched record page are served from R2 on the second visit", async () => {
    const { recordId } = await seedCompany();
    for (const path of ["/", "/coverage", "/api", "/about", "/watchlist", `/records/${recordId}`]) {
      const first = await get(path);
      expect(first.headers.get(CACHE_HEADER), path).toBe("miss");
      const body = await first.text();
      const second = await get(path);
      expect(second.headers.get(CACHE_HEADER), path).toBe("hit");
      expect(await second.text(), path).toBe(body);
      expect(second.headers.get("content-security-policy"), path).toContain("default-src 'self'");
    }
  });

  it("a finished check's page and its receipt are stored, with noindex kept", async () => {
    const { checkId } = await seedCompany();
    for (const path of [`/checks/${checkId}`, `/checks/${checkId}/receipt`]) {
      const first = await get(path);
      expect(first.headers.get(CACHE_HEADER), path).toBe("miss");
      const body = await first.text();
      const second = await get(path);
      expect(second.headers.get(CACHE_HEADER), path).toBe("hit");
      expect(await second.text(), path).toBe(body);
      expect(body, path).toContain('<meta name="robots" content="noindex"');
    }
  });

  it("a pending check, a URL with a query, an admin's view and an unwatched record are never stored", async () => {
    const { checkId } = await seedCompany();
    const lookup = await seedCompany({ number: "99000300", watched: false });
    const pending = await insertCheck(env.DB, {
      state: "pending",
      registry: "companies-house",
      record_type: "company",
      jurisdiction: "GB",
      number: "99000500",
      method: "fetch",
      added_by: "public",
      started_at: new Date().toISOString(),
    });
    const admin = { headers: { Authorization: "Bearer test-admin" } };
    const paths: [string, RequestInit?][] = [
      [`/checks/${pending}`],
      [`/checks/${pending}`],
      [`/checks/${checkId}?w=2`],
      [`/checks/${checkId}`, admin],
      [`/checks/${checkId}/receipt`, admin],
      ["/?utm=x"],
      [`/records/${lookup.recordId}`],
    ];
    for (const [path, init] of paths) expect((await callWith(ON, path, init)).headers.get(CACHE_HEADER), path).not.toBe("hit");
    expect(await storedKeys()).toEqual([]);
    // An admin is never served a visitor's stored copy either.
    await get(`/checks/${checkId}`);
    expect((await callWith(ON, `/checks/${checkId}`, admin)).headers.get(CACHE_HEADER)).toBeNull();
  });

  it("a new read of a record drops the stored pages of its earlier checks", async () => {
    const url = "https://find-and-update.company-information.service.gov.uk/company/00502851";
    mockFetchPages({ [url]: pageResponse(url, chCompany) });
    const post = (ip: string, fresh: boolean) =>
      callWith(ON, "/check", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
        body: new URLSearchParams({ q: "", number: "00502851", record_type: "company", place: "GB", ...(fresh ? { force: "1" } : {}) }).toString(),
        redirect: "manual",
      });
    const first = (await post("203.0.113.21", false)).headers.get("location")!;
    await get(first);
    await get(`${first}/receipt`);
    expect((await get(first)).headers.get(CACHE_HEADER)).toBe("hit");
    expect((await post("203.0.113.22", true)).status).toBe(303);
    expect((await get(first)).headers.get(CACHE_HEADER)).toBe("miss");
    expect((await get(`${first}/receipt`)).headers.get(CACHE_HEADER)).toBe("miss");
  });

  it("a new event and a watch change drop the screens they show; the hourly job drops every copy", async () => {
    const { recordId, checkId } = await seedCompany();
    const shown = ["/", `/records/${recordId}`, "/watchlist", `/checks/${checkId}`, `/checks/${checkId}/receipt`];
    for (const path of shown) await get(path);
    await writeEvent({ ...env, ...ON } as never, { record_id: recordId, kind: "recheck", after: { status: "active" } });
    for (const path of shown) expect((await get(path)).headers.get(CACHE_HEADER), path).toBe("miss");

    const other = await seedCompany({ number: "99000400", watched: false });
    await get("/watchlist");
    await insertWatch(env.DB, { record_id: other.recordId, kind: "page", monitor_id: "m-x", added_by: "admin" });
    // A watch made through the site or the API drops the copies; one inserted behind its back waits for the hour.
    expect((await get("/watchlist")).headers.get(CACHE_HEADER)).toBe("hit");
    await runCron({ ...env, ...ON } as never);
    expect(await storedKeys()).toEqual([]);
    expect((await get("/watchlist")).headers.get(CACHE_HEADER)).toBe("miss");
  });

  it("a new deploy starts a fresh set: copies are kept per Worker version", async () => {
    await get("/", { CF_VERSION_METADATA: { id: "aaaaaaaa-0000-4000-8000-000000000001", tag: "", timestamp: "" } });
    const other = await get("/", { CF_VERSION_METADATA: { id: "aaaaaaaa-0000-4000-8000-000000000002", tag: "", timestamp: "" } });
    expect(other.headers.get(CACHE_HEADER)).toBe("miss");
    expect((await storedKeys()).length).toBe(2);
  });
});
