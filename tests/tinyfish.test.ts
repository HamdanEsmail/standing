import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MAX_DURATION_SECONDS, AGENT_MAX_STEPS } from "../src/core/limits";
import { companiesHouse } from "../src/registries/companies-house";
import { gmc } from "../src/registries/gmc";
import { downloadStepScreenshot, getRun, pickEvidenceStep, startRun } from "../src/tinyfish/agent";
import { consentScript, DECLINE_LABEL, isConsentButton, screenshotFullPage } from "../src/tinyfish/browser";
import { TinyFishError, tinyfishFetch } from "../src/tinyfish/client";
import { fetchPage } from "../src/tinyfish/fetch";
import {
  createMonitor,
  createTopicMonitor,
  deleteMonitor,
  listMonitors,
  setMonitorStatus,
  updateMonitor,
} from "../src/tinyfish/monitor";
import { searchWeb } from "../src/tinyfish/search";
import { fetchMock } from "./helpers/fetch-mock";
import browserCreate from "./fixtures/tinyfish/browser-create.json";
import fetchChSearch from "./fixtures/tinyfish/fetch-ch-search.json";
import fetchGmcRecord from "./fixtures/tinyfish/fetch-gmc-record.json";
import fetchSelectorNotMatched from "./fixtures/tinyfish/fetch-selector-not-matched.json";
import gmcAgentRun from "./fixtures/tinyfish/gmc-agent-run.json";
import gmcConditionsRun from "./fixtures/tinyfish/gmc-conditions-run.json";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import monitorGet from "./fixtures/tinyfish/monitor-get.json";
import monitorTopicCreate from "./fixtures/tinyfish/monitor-topic-create.json";
import mptsSearch from "./fixtures/tinyfish/mpts-search.json";
import chSearchMarkdown from "./fixtures/registries/ch-search.md?raw";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const RUNS_API = "https://agent.tinyfish.ai/v1/runs";
const BROWSER_API = "https://api.browser.tinyfish.ai";
const SEARCH_API = "https://api.search.tinyfish.ai/";

const GMC_RECORD_URL = "https://www.gmc-uk.org/registrants/9360749";
const CALLBACK_URL = "https://standing.test/hooks/agent/s3cret";
const WATCH_PURPOSE = "A registration status, licence condition or fitness-to-practise entry was added, removed or changed.";

const START_PARAMS = {
  url: gmc.searchUrl,
  goal: "Search the register for Christopher Wickfold and return the fields.",
  outputSchema: gmc.outputSchema,
  browserProfile: "lite" as const,
  callbackUrl: CALLBACK_URL,
};
const RATE_LIMITED = {
  status: 429,
  json: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many concurrent runs" } },
};

type SpendRow = { kind: string; amount_usd: number; ref: string };

async function spendRows(): Promise<SpendRow[]> {
  const { results } = await env.DB.prepare("SELECT kind, amount_usd, ref FROM spend ORDER BY at, rowid").all<SpendRow>();
  return results;
}

function callsTo(method: string, url: string) {
  return fetchMock.calls.filter((c) => c.method === method && c.url === new URL(url).href);
}

beforeEach(async () => {
  fetchMock.activate();
  await env.DB.prepare("DELETE FROM spend").run();
});
afterEach(() => {
  vi.useRealTimers();
  fetchMock.reset();
});

// ---------------------------------------------------------------------------
// client.ts
// ---------------------------------------------------------------------------

describe("tinyfishFetch", () => {
  it("sends the key and JSON content type, merges caller headers, and records spend on a 2xx", async () => {
    fetchMock.intercept({
      method: "POST",
      url: BROWSER_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        expect(req.headers.get("Content-Type")).toBe("application/json");
        expect(req.headers.get("X-Caller")).toBe("kept");
        return Response.json({ ok: true });
      },
    });
    const res = await tinyfishFetch(env, BROWSER_API, {
      method: "POST",
      headers: { "X-Caller": "kept" },
      body: JSON.stringify({ url: GMC_RECORD_URL }),
      spend: { kind: "screenshot", amountUsd: 0.002, ref: GMC_RECORD_URL },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await spendRows()).toEqual([{ kind: "screenshot", amount_usd: 0.002, ref: GMC_RECORD_URL }]);
  });

  it("returns the response and logs, instead of throwing, when the spend write fails after a 2xx", async () => {
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: { session: "made" } } });
    const brokenDb = {
      prepare() {
        throw new Error("D1 is down");
      },
    } as unknown as D1Database;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await tinyfishFetch({ ...env, DB: brokenDb, TINYFISH_API_KEY: env.TINYFISH_API_KEY }, BROWSER_API, {
        method: "POST",
        body: "{}",
        spend: { kind: "screenshot", amountUsd: 0.002, ref: GMC_RECORD_URL },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ session: "made" });
      expect(logged).toHaveBeenCalledWith("spend write failed", "screenshot");
      // The log line names the kind only: no key, url or error text.
      expect(JSON.stringify(logged.mock.calls)).not.toContain("test-tinyfish-key");
    } finally {
      logged.mockRestore();
    }
  });

  it("maps a 402 to TinyFishError INSUFFICIENT_CREDITS and records no spend", async () => {
    fetchMock.intercept({
      method: "POST",
      url: BROWSER_API,
      reply: { status: 402, json: { error: { code: "INSUFFICIENT_CREDITS", message: "Top up your account" } } },
    });
    const err = await tinyfishFetch(env, BROWSER_API, {
      method: "POST",
      body: "{}",
      spend: { kind: "screenshot", amountUsd: 0.002, ref: GMC_RECORD_URL },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ status: 402, code: "INSUFFICIENT_CREDITS" });
    // The message holds the status and the code only: no text from the response body.
    expect((err as Error).message).toBe("TinyFish HTTP 402 INSUFFICIENT_CREDITS");
    expect((err as Error).message).not.toContain("Top up your account");
    expect((err as Error).message).not.toContain("test-tinyfish-key");
    expect(await spendRows()).toEqual([]);
  });

  it("keeps whatever the response echoes (a rejected webhook url with its secret) out of the error message", async () => {
    const webhook = `https://standing.test/hooks/agent/${env.WEBHOOK_SECRET}`;
    const echoes = [
      { status: 400, json: { error: { code: "INVALID_WEBHOOK_URL", message: `webhook_url ${webhook} is not allowed` } } },
      { status: 400, json: { code: "BAD_INPUT", message: `rejected ${webhook}` } },
      { status: 400, json: { error: `rejected ${webhook}` } },
      { status: 502, body: `<html>upstream saw ${webhook}</html>` },
    ];
    const messages: string[] = [];
    for (const reply of echoes) {
      fetchMock.intercept({ method: "POST", url: BROWSER_API, reply });
      const err = await tinyfishFetch(env, BROWSER_API, { method: "POST", body: JSON.stringify({ webhook_url: webhook }) }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TinyFishError);
      messages.push((err as Error).message);
    }
    expect(messages).toEqual([
      "TinyFish HTTP 400 INVALID_WEBHOOK_URL",
      "TinyFish HTTP 400 BAD_INPUT",
      "TinyFish HTTP 400 http_400",
      "TinyFish HTTP 502 http_502",
    ]);
    expect(messages.join("\n")).not.toContain(env.WEBHOOK_SECRET);
  });

  it("does not trust a code that is not a short token: a sentence that echoes a secret URL reaches neither code nor message", async () => {
    const webhook = `https://standing.test/hooks/monitor/${env.WEBHOOK_SECRET}`;
    const sentence = `webhook_url ${webhook} is not allowed`;
    const replies = [
      { status: 400, json: { error: { code: sentence, message: "no" } } },
      { status: 400, json: { code: sentence } },
      { status: 400, json: { error: { code: webhook } } },
      { status: 400, json: { error: { code: "A".repeat(65) } } },
      { status: 400, json: { error: { code: "has space" } } },
    ];
    for (const reply of replies) {
      fetchMock.intercept({ method: "POST", url: BROWSER_API, reply });
      const err = await tinyfishFetch(env, BROWSER_API, { method: "POST", body: JSON.stringify({ webhook_url: webhook }) }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TinyFishError);
      expect(err).toMatchObject({ status: 400, code: "http_400" });
      expect((err as Error).message).toBe("TinyFish HTTP 400 http_400");
      expect(`${(err as TinyFishError).code} ${(err as Error).message}`).not.toContain(env.WEBHOOK_SECRET);
    }

    // The longest accepted token is 64 characters.
    const longest = "B".repeat(64);
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { status: 400, json: { error: { code: longest } } } });
    await expect(tinyfishFetch(env, BROWSER_API, { method: "POST" })).rejects.toMatchObject({ code: longest });
  });

  it("falls back to body.code, then to http_<status> for a body that is not JSON", async () => {
    fetchMock.intercept({ url: BROWSER_API, reply: { status: 400, json: { code: "BAD_INPUT", message: "no" } } });
    fetchMock.intercept({ url: BROWSER_API, reply: { status: 502, body: "<html>Bad gateway</html>" } });
    const first = await tinyfishFetch(env, BROWSER_API, { method: "POST" }).catch((e: unknown) => e);
    expect(first).toMatchObject({ status: 400, code: "BAD_INPUT" });
    expect((first as Error).message).toBe("TinyFish HTTP 400 BAD_INPUT");
    const second = await tinyfishFetch(env, BROWSER_API, { method: "POST" }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(TinyFishError);
    expect(second).toMatchObject({ status: 502, code: "http_502" });
    expect((second as Error).message).toBe("TinyFish HTTP 502 http_502");
    expect((second as Error).message).not.toContain("test-tinyfish-key");
  });
});

describe("tinyfishFetch rate-limit retry (opt-in)", () => {
  it("does not retry unless the caller asks: a 429 RATE_LIMIT_EXCEEDED is thrown at once", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED });
    const err = await tinyfishFetch(env, RUN_ASYNC_API, { method: "POST", body: "{}", sleep }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMIT_EXCEEDED" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits 60 s and retries on a 429 RATE_LIMIT_EXCEEDED; only the 2xx records spend", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED, times: 2 });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "r1" } } });
    const res = await tinyfishFetch(env, RUN_ASYNC_API, {
      method: "POST",
      body: JSON.stringify({ url: GMC_RECORD_URL }),
      retryRateLimit: true,
      sleep,
      spend: { kind: "agent_step", amountUsd: 0.016, ref: "run-1" },
    });
    expect(await res.json()).toEqual({ run_id: "r1" });
    expect(sleep.mock.calls).toEqual([[60_000], [60_000]]);
    // Every attempt re-sends the same body.
    expect(callsTo("POST", RUN_ASYNC_API).map((c) => c.body)).toEqual([
      { url: GMC_RECORD_URL },
      { url: GMC_RECORD_URL },
      { url: GMC_RECORD_URL },
    ]);
    expect(await spendRows()).toEqual([{ kind: "agent_step", amount_usd: 0.016, ref: "run-1" }]);
  });

  it("gives up after 3 retries with code busy: four 429s make four calls and three waits", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED, times: 4 });
    const err = await tinyfishFetch(env, RUN_ASYNC_API, { method: "POST", body: "{}", retryRateLimit: true, sleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ status: 429, code: "busy" });
    expect((err as Error).message).toBe("TinyFish HTTP 429 busy");
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(await spendRows()).toEqual([]);
  });

  it("retries any 429, with or without the RATE_LIMIT_EXCEEDED code", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const anyLimit = [
      { status: 429, json: { error: { code: "QUOTA_EXCEEDED" } } },
      { status: 429, body: "slow down" },
      { status: 429, json: { error: "Too many requests" } },
    ];
    for (const limited of anyLimit) {
      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: limited });
      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "r2" } } });
      const res = await tinyfishFetch(env, RUN_ASYNC_API, { method: "POST", body: "{}", retryRateLimit: true, sleep });
      expect(await res.json()).toEqual({ run_id: "r2" });
    }
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(anyLimit.length * 2);
    expect(sleep.mock.calls).toEqual(anyLimit.map(() => [60_000]));
  });

  it("ends in busy after four 429s of any code: three waits, four calls", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const anyLimit = [
      { status: 429, json: { error: { code: "QUOTA_EXCEEDED" } } },
      { status: 429, body: "slow down" },
    ];
    for (const limited of anyLimit) {
      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: limited, times: 4 });
      const err = await tinyfishFetch(env, RUN_ASYNC_API, { method: "POST", body: "{}", retryRateLimit: true, sleep }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ status: 429, code: "busy" });
    }
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(anyLimit.length * 4);
    expect(sleep).toHaveBeenCalledTimes(anyLimit.length * 3);
  });

  it("does not retry a 400 or a 500, even with the option on", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const cases = [
      { reply: { status: 400, json: { error: { code: "INVALID_INPUT" } } }, code: "INVALID_INPUT", status: 400 },
      { reply: { status: 400, json: { error: { code: "RATE_LIMIT_EXCEEDED" } } }, code: "RATE_LIMIT_EXCEEDED", status: 400 },
      { reply: { status: 500, body: "boom" }, code: "http_500", status: 500 },
    ];
    for (const c of cases) {
      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: c.reply });
      const err = await tinyfishFetch(env, RUN_ASYNC_API, { method: "POST", body: "{}", retryRateLimit: true, sleep }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ status: c.status, code: c.code });
    }
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(cases.length);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fetch.ts
// ---------------------------------------------------------------------------

describe("fetchPage", () => {
  it("sends the base body, with no include_selectors key unless the caller names selectors", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(fetchGmcRecord);
      },
      times: 3,
    });
    await fetchPage(env, GMC_RECORD_URL, "markdown");
    await fetchPage(env, GMC_RECORD_URL, "markdown", {});
    await fetchPage(env, GMC_RECORD_URL, "html", { include_selectors: [] });
    const [plain, emptyOpts, emptySelectors] = callsTo("POST", FETCH_API).map((c) => c.body);
    const base = { urls: [GMC_RECORD_URL], ttl: 0, include_etag_and_last_modified: true, per_url_timeout_ms: 45000 };
    expect(plain).toEqual({ ...base, format: "markdown" });
    expect(emptyOpts).toEqual({ ...base, format: "markdown" });
    expect(emptySelectors).toEqual({ ...base, format: "html" });
  });

  it("sends include_selectors in the body and returns the text of a selector-scoped read", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchGmcRecord } });
    const out = await fetchPage(env, GMC_RECORD_URL, "markdown", gmc.recordFetchOptions);
    expect(callsTo("POST", FETCH_API)[0]!.body).toEqual({
      urls: [GMC_RECORD_URL],
      format: "markdown",
      ttl: 0,
      include_etag_and_last_modified: true,
      per_url_timeout_ms: 45000,
      include_selectors: ["[role='main']"],
    });
    expect(out).toMatchObject({ ok: true, title: "Registrants details page", finalUrl: GMC_RECORD_URL });
    expect(out.ok && out.text).toBe(fetchGmcRecord.results[0]!.text);
    expect(await spendRows()).toEqual([{ kind: "fetch", amount_usd: 0, ref: GMC_RECORD_URL }]);
  });

  it("answers an unmatched selector with ok:false and the error code selector_not_matched", async () => {
    // The real response: no results, and a per-URL error with the selectors tried and the candidates.
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchSelectorNotMatched } });
    const out = await fetchPage(env, "https://www.gmc-uk.org/registrants/9662428", "html", { include_selectors: ["main"] });
    expect(out).toEqual({ ok: false, error: "selector_not_matched" });
    expect(callsTo("POST", FETCH_API)[0]!.body).toMatchObject({ include_selectors: ["main"] });
  });

  it("returns an error code for a per-URL error, with a string or an object error", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [], errors: [{ url: GMC_RECORD_URL, error: "bot_blocked" }] } },
    });
    expect(await fetchPage(env, GMC_RECORD_URL, "html")).toEqual({ ok: false, error: "bot_blocked" });
    expect(callsTo("POST", FETCH_API)[0]!.body).toMatchObject({ format: "html" });

    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [], errors: [{ url: GMC_RECORD_URL, error: { code: "target_unreachable" } }] } },
    });
    expect(await fetchPage(env, GMC_RECORD_URL, "markdown")).toEqual({ ok: false, error: "target_unreachable" });
  });

  it("does not carry upstream text in a per-URL error: only a short token is kept, anything else is fetch_error", async () => {
    const sentence = `could not fetch ${GMC_RECORD_URL}?token=${env.WEBHOOK_SECRET}: refused`;
    const bodies = [
      { results: [], errors: [{ url: GMC_RECORD_URL, error: sentence }] },
      { results: [], errors: [{ url: GMC_RECORD_URL, error: { code: sentence } }] },
      { results: [], errors: [{ url: GMC_RECORD_URL, error: "A".repeat(65) }] },
    ];
    for (const json of bodies) {
      fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json } });
      expect(await fetchPage(env, GMC_RECORD_URL, "markdown")).toEqual({ ok: false, error: "fetch_error" });
    }
  });

  it("returns no_result when there is neither a result nor an error, and the HTTP code on a failed call", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: { results: [], errors: [] } } });
    expect(await fetchPage(env, GMC_RECORD_URL, "markdown")).toEqual({ ok: false, error: "no_result" });

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { status: 500, json: { error: { code: "INTERNAL" } } } });
    expect(await fetchPage(env, GMC_RECORD_URL, "markdown")).toEqual({ ok: false, error: "INTERNAL", status: 500 });

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { status: 503, body: "down" } });
    expect(await fetchPage(env, GMC_RECORD_URL, "markdown")).toEqual({ ok: false, error: "http_503", status: 503 });
  });
});

// ---------------------------------------------------------------------------
// monitor.ts
// ---------------------------------------------------------------------------

describe("monitors", () => {
  const params = {
    url: GMC_RECORD_URL,
    name: "Standing GMC 9360749",
    scheduleCron: "7 1,13 * * *",
    purpose: WATCH_PURPOSE,
    webhookUrl: "https://standing.test/hooks/monitor/s3cret",
  };

  it("createMonitor returns monitorId and the baseline text from the 201 body, and records one monitor_check", async () => {
    fetchMock.intercept({
      method: "POST",
      url: MONITORS_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(monitorCreate, { status: 201 });
      },
    });
    const out = await createMonitor(env, params);
    expect(out.monitorId).toBe(monitorCreate.monitor.id);
    expect(out.baselineRunId).toBe(monitorCreate.run.id);
    expect(out.baselineText).toBe(monitorCreate.run.results[0]!.text);
    expect(callsTo("POST", MONITORS_API)[0]!.body).toEqual({
      type: "fetch",
      name: "Standing GMC 9360749",
      config: { url: GMC_RECORD_URL, format: "markdown" },
      schedule_cron: "7 1,13 * * *",
      purpose: WATCH_PURPOSE,
      webhook_url: "https://standing.test/hooks/monitor/s3cret",
    });
    expect(await spendRows()).toEqual([{ kind: "monitor_check", amount_usd: 0.005, ref: GMC_RECORD_URL }]);
  });

  it("createMonitor deletes the new monitor and throws baseline_failed when the baseline has no text", async () => {
    const id = monitorCreate.monitor.id;
    const failed = { ...monitorCreate, run: { ...monitorCreate.run, results: [], errors: [{ url: GMC_RECORD_URL, error: "bot_blocked" }] } };
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: failed } });
    fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/${id}`, reply: { status: 200, json: {} } });
    const err = await createMonitor(env, params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: "baseline_failed" });
    expect(callsTo("DELETE", `${MONITORS_API}/${id}`)).toHaveLength(1);
  });

  it("createMonitor still throws baseline_failed when the cleanup delete itself fails", async () => {
    const id = monitorCreate.monitor.id;
    const empty = { ...monitorCreate, run: { ...monitorCreate.run, results: [{ ...monitorCreate.run.results[0], text: "" }] } };
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: empty } });
    fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/${id}`, reply: { status: 500, body: "boom" } });
    const err = await createMonitor(env, params).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "baseline_failed" });
    expect(callsTo("DELETE", `${MONITORS_API}/${id}`)).toHaveLength(1);
  });

  describe("createTopicMonitor", () => {
    const topic = {
      query: '"Christopher Wickfold" GMC tribunal OR sanction OR suspended',
      name: "Standing topic gmc-w1",
      scheduleCron: "41 5,17 * * *",
      purpose: "A new public notice about this registrant's fitness to practise",
      webhookUrl: "https://standing.test/hooks/monitor/s3cret",
    };

    it("sends a search monitor with the default recency and result limit, and returns the id", async () => {
      fetchMock.intercept({
        method: "POST",
        url: MONITORS_API,
        reply: (req) => {
          expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
          return Response.json(monitorTopicCreate, { status: 201 });
        },
      });
      const out = await createTopicMonitor(env, topic);
      expect(out).toEqual({ monitorId: monitorTopicCreate.monitor.id });
      expect(callsTo("POST", MONITORS_API)[0]!.body).toEqual({
        type: "search",
        name: "Standing topic gmc-w1",
        config: { query: topic.query, recency_minutes: 1440, result_limit: 5 },
        schedule_cron: "41 5,17 * * *",
        purpose: topic.purpose,
        webhook_url: "https://standing.test/hooks/monitor/s3cret",
      });
    });

    it("sends the caller's recencyMinutes and resultLimit", async () => {
      fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: monitorTopicCreate } });
      await createTopicMonitor(env, { ...topic, recencyMinutes: 60, resultLimit: 3 });
      expect(callsTo("POST", MONITORS_API)[0]!.body).toMatchObject({
        config: { query: topic.query, recency_minutes: 60, result_limit: 3 },
      });
    });

    it("records one monitor_check for the baseline, keeps a baseline with no results, and deletes nothing", async () => {
      // The real 201 has result_count 0 and results []: a healthy first run for a topic.
      expect(monitorTopicCreate.run.results).toEqual([]);
      fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: monitorTopicCreate } });
      await createTopicMonitor(env, topic);
      expect(await spendRows()).toEqual([{ kind: "monitor_check", amount_usd: 0.005, ref: "Standing topic gmc-w1" }]);
      expect(fetchMock.calls).toHaveLength(1);
    });

    it("throws no_monitor_id when the 201 body has no monitor id", async () => {
      fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: { run: { id: "r" } } } });
      const err = await createTopicMonitor(env, topic).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TinyFishError);
      expect(err).toMatchObject({ code: "no_monitor_id" });
    });
  });

  it("setMonitorStatus sends {status} alone and updateMonitor always includes schedule_cron", async () => {
    const id = monitorGet.id;
    const url = `${MONITORS_API}/${id}`;
    fetchMock.intercept({ method: "PATCH", url, reply: { json: monitorGet }, times: 5 });

    await setMonitorStatus(env, id, "paused");
    await updateMonitor(env, id, { scheduleCron: "0 */6 * * *" });
    await updateMonitor(env, id, {
      scheduleCron: "5 1,13 * * *",
      name: "New name",
      purpose: "New purpose",
      webhookUrl: "https://standing.test/hooks/monitor/new",
    });
    await updateMonitor(env, id, { scheduleCron: "5 1,13 * * *", webhookUrl: null });
    await setMonitorStatus(env, id, "active");

    const bodies = callsTo("PATCH", url).map((c) => c.body);
    expect(bodies).toEqual([
      { status: "paused" },
      { schedule_cron: "0 */6 * * *" },
      { schedule_cron: "5 1,13 * * *", name: "New name", purpose: "New purpose", webhook_url: "https://standing.test/hooks/monitor/new" },
      { schedule_cron: "5 1,13 * * *", webhook_url: null },
      { status: "active" },
    ]);
    expect(await spendRows()).toEqual([]);
  });

  it("deleteMonitor treats a 404 as already deleted and surfaces other failures", async () => {
    const url = `${MONITORS_API}/gone`;
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 404, json: { error: { code: "NOT_FOUND" } } } });
    await expect(deleteMonitor(env, "gone")).resolves.toBeUndefined();
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 500, body: "boom" } });
    await expect(deleteMonitor(env, "gone")).rejects.toMatchObject({ status: 500 });
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 204 } });
    await expect(deleteMonitor(env, "gone")).resolves.toBeUndefined();
    expect(await spendRows()).toEqual([]);
  });

  it("listMonitors maps the account's monitors to id, status, name and type (fetch, search, or null)", async () => {
    fetchMock.intercept({
      method: "GET",
      url: MONITORS_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json({
          monitors: [
            monitorGet,
            monitorTopicCreate.monitor,
            { id: "m3", status: "paused", name: null, config: {} },
            { id: "m4", status: "active", type: "something-new" },
            { status: "active", name: "no id" },
          ],
        });
      },
    });
    expect(await listMonitors(env)).toEqual([
      { id: monitorGet.id, status: "active", name: "spike-fineprint", type: "fetch" },
      { id: monitorTopicCreate.monitor.id, status: "active", name: "spike-standing-topic", type: "search" },
      { id: "m3", status: "paused", name: null, type: null },
      { id: "m4", status: "active", name: null, type: null },
    ]);
    expect(await spendRows()).toEqual([]);
  });

  it("listMonitors accepts a bare array and returns [] for anything else", async () => {
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: [monitorGet] } });
    expect(await listMonitors(env)).toEqual([{ id: monitorGet.id, status: "active", name: "spike-fineprint", type: "fetch" }]);
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { monitors: "none" } } });
    expect(await listMonitors(env)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// agent.ts
// ---------------------------------------------------------------------------

describe("agent: startRun", () => {
  it("posts the run with the schema, profile, caps and callback, and returns the run id with no spend row", async () => {
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json({ run_id: "run-1" });
      },
    });
    expect(await startRun(env, START_PARAMS)).toEqual({ runId: "run-1" });
    expect(AGENT_MAX_STEPS).toBe(12);
    expect(callsTo("POST", RUN_ASYNC_API)[0]!.body).toEqual({
      url: gmc.searchUrl,
      goal: START_PARAMS.goal,
      browser_profile: "lite",
      agent_config: { max_steps: AGENT_MAX_STEPS, max_duration_seconds: AGENT_MAX_DURATION_SECONDS },
      output_schema: gmc.outputSchema,
      webhook_url: CALLBACK_URL,
    });
    // Agent steps are billed when the run finishes, by the caller.
    expect(await spendRows()).toEqual([]);
  });

  it("sends the lite profile when asked", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "run-2" } } });
    await startRun(env, { ...START_PARAMS, browserProfile: "lite" });
    expect(callsTo("POST", RUN_ASYNC_API)[0]!.body).toMatchObject({ browser_profile: "lite" });
  });

  it("throws no_run_id when the answer has no run_id", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: {} } });
    const err = await startRun(env, START_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: "no_run_id" });
  });

  it("429 then 201: one run id, one 60 s wait (fake timers drive the default wait)", async () => {
    vi.useFakeTimers();
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 201, json: { run_id: "run-3" } } });

    let settled = false;
    const started = startRun(env, START_PARAMS).then((out) => {
      settled = true;
      return out;
    });
    // The first call is answered 429 and the wait begins; nothing is retried before 60 s have passed.
    await vi.waitFor(() => expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await started).toEqual({ runId: "run-3" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(2);
    expect(await spendRows()).toEqual([]);
  });

  it("two 429s then a 200 return the run id after 3 calls and two 60 s waits", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED, times: 2 });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "run-4" } } });
    expect(await startRun(env, START_PARAMS, { sleep })).toEqual({ runId: "run-4" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(3);
    expect(sleep.mock.calls).toEqual([[60_000], [60_000]]);
  });

  it("four 429s fail with code busy after three waits", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED, times: 4 });
    const err = await startRun(env, START_PARAMS, { sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: "busy" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("retries a 429 with another code too, and ends in busy after three waits", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: { status: 429, json: { error: { code: "QUOTA_EXCEEDED" } } },
      times: 4,
    });
    const err = await startRun(env, START_PARAMS, { sleep }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: "busy" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(4);
    expect(sleep.mock.calls).toEqual([[60_000], [60_000], [60_000]]);
  });

  it("does not retry a 400 or a 500", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 400, json: { error: { code: "INVALID_INPUT" } } } });
    expect(await startRun(env, START_PARAMS, { sleep }).catch((e: unknown) => e)).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 500, body: "boom" } });
    expect(await startRun(env, START_PARAMS, { sleep }).catch((e: unknown) => e)).toMatchObject({ status: 500, code: "http_500" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps the callback url (it holds the webhook secret) out of the error when a start is rejected", async () => {
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: { status: 400, json: { error: { code: "INVALID_WEBHOOK_URL", message: `bad ${CALLBACK_URL}` } } },
    });
    const err = await startRun(env, START_PARAMS).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INVALID_WEBHOOK_URL" });
    expect((err as Error).message).not.toContain("s3cret");
  });
});

describe("agent: getRun", () => {
  const runUrl = (id: string, screenshots: string) => `${RUNS_API}/${id}?screenshots=${screenshots}&html=none`;

  it("asks for screenshot urls and returns status, result, step count, finish time, error and steps", async () => {
    const id = gmcAgentRun.run_id;
    fetchMock.intercept({
      method: "GET",
      url: runUrl(id, "url"),
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(gmcAgentRun);
      },
    });
    const run = await getRun(env, id, "url");
    expect(run).toMatchObject({
      status: "COMPLETED",
      result: gmcAgentRun.result,
      num_of_steps: 8,
      finished_at: "2026-11-03T09:22:34Z",
      error: null,
    });
    expect(run.steps).toHaveLength(gmcAgentRun.steps.length);
    expect(run.steps[3]).toEqual({
      id: "c71884cb-5170-45d7-8b66-ffe351ba59e8",
      action: "Open first matching entry for Christopher Wickfold",
      screenshot:
        "https://agent.tinyfish.ai/runs/f8907a4d-0c6c-4806-8b52-6d9838c85f03/steps/c71884cb-5170-45d7-8b66-ffe351ba59e8/screenshot",
    });
    expect(run.steps.at(-1)).toEqual({ id: "d0eba84b-04fe-4a20-a8ba-09716b2def89", action: "Task completed", screenshot: null });
    expect(await spendRows()).toEqual([]);
  });

  it("asks for no screenshots with 'none' and reads a run recorded that way", async () => {
    const id = gmcConditionsRun.run_id;
    fetchMock.intercept({ method: "GET", url: runUrl(id, "none"), reply: { json: gmcConditionsRun } });
    const run = await getRun(env, id, "none");
    expect(run.status).toBe("COMPLETED");
    expect(run.num_of_steps).toBe(11);
    expect(run.steps.length).toBeGreaterThan(0);
    expect(run.steps.every((s) => s.screenshot === null)).toBe(true);
  });

  it("tolerates a bare running run, and drops steps without an id", async () => {
    fetchMock.intercept({ method: "GET", url: runUrl("r2", "none"), reply: { json: { run_id: "r2", status: "RUNNING" } } });
    expect(await getRun(env, "r2", "none")).toEqual({
      status: "RUNNING",
      result: null,
      num_of_steps: null,
      started_at: null,
      finished_at: null,
      error: null,
      steps: [],
    });

    fetchMock.intercept({
      method: "GET",
      url: runUrl("r3", "url"),
      reply: { json: { status: "RUNNING", steps: [null, { action: "no id" }, { id: "s1", action: 5, screenshot: 7 }, { id: "s2" }] } },
    });
    const run = await getRun(env, "r3", "url");
    expect(run.steps).toEqual([
      { id: "s1", action: null, screenshot: null },
      { id: "s2", action: null, screenshot: null },
    ]);
  });

  it("reads a failed run's error as text, from a string or an object", async () => {
    fetchMock.intercept({ method: "GET", url: runUrl("f1", "none"), reply: { json: { status: "FAILED", error: "Target blocked" } } });
    expect((await getRun(env, "f1", "none")).error).toBe("Target blocked");
    fetchMock.intercept({
      method: "GET",
      url: runUrl("f2", "none"),
      reply: { json: { status: "FAILED", error: { code: "TARGET_BLOCKED", message: "Blocked by the site" } } },
    });
    expect((await getRun(env, "f2", "none")).error).toBe("Blocked by the site");
    fetchMock.intercept({ method: "GET", url: runUrl("f3", "none"), reply: { json: { status: "FAILED", error: { code: "TIMEOUT" } } } });
    expect((await getRun(env, "f3", "none")).error).toBe("TIMEOUT");
    fetchMock.intercept({ method: "GET", url: runUrl("f4", "none"), reply: { json: { status: "FAILED", error: { odd: true } } } });
    expect((await getRun(env, "f4", "none")).error).toBe("agent_error");
  });

  it("puts the run id in the path encoded", async () => {
    fetchMock.intercept({ method: "GET", url: /^https:\/\/agent\.tinyfish\.ai\/v1\/runs\/a%2Fb\?/, reply: { json: { status: "RUNNING" } } });
    await getRun(env, "a/b", "none");
    expect(fetchMock.calls[0]!.url).toContain("/v1/runs/a%2Fb?screenshots=none&html=none");
  });
});

describe("agent: downloadStepScreenshot", () => {
  // The first bytes of a JPEG; the content is not decoded anywhere.
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const stepUrl = (runId: string, stepId: string) => `${RUNS_API}/${runId}/steps/${stepId}/screenshot`;

  it("GETs the API-key binary endpoint (with the /v1 prefix) and returns the image bytes", async () => {
    const runId = gmcAgentRun.run_id;
    const stepId = "76536869-6e99-452d-8f9d-ff34fc28ca3e";
    fetchMock.intercept({
      method: "GET",
      url: stepUrl(runId, stepId),
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
      },
    });
    const bytes = await downloadStepScreenshot(env, runId, stepId);
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(bytes))).toEqual(Array.from(JPEG));
    expect(fetchMock.calls[0]!.url).toBe(`https://agent.tinyfish.ai/v1/runs/${runId}/steps/${stepId}/screenshot`);
    // The step is already paid for in the run's steps: no spend row.
    expect(await spendRows()).toEqual([]);
  });

  it("throws when the answer is not an image, or is empty", async () => {
    fetchMock.intercept({
      method: "GET",
      url: stepUrl("r", "s"),
      reply: { status: 200, headers: { "content-type": "text/html" }, body: "<html>Sign in</html>" },
    });
    const notImage = await downloadStepScreenshot(env, "r", "s").catch((e: unknown) => e);
    expect(notImage).toBeInstanceOf(TinyFishError);
    expect(notImage).toMatchObject({ code: "not_an_image" });
    expect((notImage as Error).message).not.toContain("Sign in");

    fetchMock.intercept({
      method: "GET",
      url: stepUrl("r", "s"),
      reply: { status: 200, headers: { "content-type": "application/json" }, json: { error: "x" } },
    });
    await expect(downloadStepScreenshot(env, "r", "s")).rejects.toMatchObject({ code: "not_an_image" });

    fetchMock.intercept({
      method: "GET",
      url: stepUrl("r", "s"),
      reply: { status: 200, headers: { "content-type": "image/jpeg" }, body: "" },
    });
    await expect(downloadStepScreenshot(env, "r", "s")).rejects.toMatchObject({ code: "empty_image" });
  });

  it("surfaces an HTTP error as a TinyFishError", async () => {
    fetchMock.intercept({ method: "GET", url: stepUrl("r", "s"), reply: { status: 404, json: { error: { code: "NOT_FOUND" } } } });
    await expect(downloadStepScreenshot(env, "r", "s")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("agent: pickEvidenceStep", () => {
  const STEP_5 = "76536869-6e99-452d-8f9d-ff34fc28ca3e"; // "Check for fitness-to-practise history on doctor details page"
  const stepIdByAction = (prefix: string) => gmcAgentRun.steps.find((s) => s.action.startsWith(prefix))!.id;

  it("picks the details-page step of the real GMC run (step 5), not the results list the run ends on", () => {
    expect(pickEvidenceStep(gmcAgentRun)).toBe(STEP_5);
  });

  it("never picks a step that goes back to, returns, or counts the search results", () => {
    const picked = pickEvidenceStep(gmcAgentRun);
    expect(picked).not.toBe(stepIdByAction("Go back to search results"));
    expect(picked).not.toBe(stepIdByAction("Get number of search results"));
    expect(picked).not.toBe(stepIdByAction("Return search results"));
    // The plan's literal rule ("last step mentioning the entry") would have picked the Return step.
    expect(gmcAgentRun.steps.find((s) => s.id === picked)!.action).toMatch(/details page/);
  });

  it("falls back to the last step with a screenshot when no action names the record", () => {
    const steps = [
      { id: "a", action: "Navigate to the register", screenshot: "https://x/a" },
      { id: "b", action: "Enter the name", screenshot: "https://x/b" },
      { id: "c", action: "Press search", screenshot: "https://x/c" },
      { id: "d", action: "Task completed", screenshot: null },
    ];
    expect(pickEvidenceStep({ steps })).toBe("c");
  });

  it("falls back the same way when the only steps naming a record go back or return", () => {
    const steps = [
      { id: "a", action: "Open the entry", screenshot: null },
      { id: "b", action: "Go back to search results page to count results", screenshot: "https://x/b" },
      { id: "c", action: "Return search results and entry details", screenshot: "https://x/c" },
    ];
    expect(pickEvidenceStep({ steps })).toBe("c");
  });

  it("skips a step that names the record but has no screenshot, and takes the last one that does", () => {
    const steps = [
      { id: "a", action: "Open first matching entry", screenshot: "https://x/a" },
      { id: "b", action: "Read the registrant record page", screenshot: "https://x/b" },
      { id: "c", action: "Read the status on the record page", screenshot: null },
      { id: "d", action: "Navigate onward", screenshot: "https://x/d" },
    ];
    expect(pickEvidenceStep({ steps })).toBe("b");
  });

  it("reads the plurals records and registrants as naming the record page too", () => {
    const records = [
      { id: "a", action: "Open the records page", screenshot: "https://x/a" },
      { id: "b", action: "Navigate onward", screenshot: "https://x/b" },
    ];
    expect(pickEvidenceStep({ steps: records })).toBe("a");
    const registrants = [
      { id: "a", action: "Read the registrants details", screenshot: "https://x/a" },
      { id: "b", action: "Press search", screenshot: "https://x/b" },
    ];
    expect(pickEvidenceStep({ steps: registrants })).toBe("a");
    // Still excluded when it goes back to the list.
    const back = [
      { id: "a", action: "Go back to the registrants list", screenshot: "https://x/a" },
      { id: "b", action: "Navigate onward", screenshot: "https://x/b" },
    ];
    expect(pickEvidenceStep({ steps: back })).toBe("b");
  });

  it("is null when no step has a screenshot (the run was read with screenshots=none), or there are no steps", () => {
    expect(pickEvidenceStep(gmcConditionsRun)).toBeNull();
    expect(pickEvidenceStep({ steps: [] })).toBeNull();
    expect(pickEvidenceStep({ steps: [{ id: "a", action: null, screenshot: null }] })).toBeNull();
  });

  it("reads a step with no action text as having a screenshot only", () => {
    const steps = [
      { id: "a", action: "Open entry", screenshot: "https://x/a" },
      { id: "b", action: null, screenshot: "https://x/b" },
    ];
    expect(pickEvidenceStep({ steps })).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// search.ts
// ---------------------------------------------------------------------------

describe("searchWeb", () => {
  it("sends the query, domain and recency as a GET with the key, and returns url, title and snippet", async () => {
    fetchMock.intercept({
      method: "GET",
      url: /^https:\/\/api\.search\.tinyfish\.ai\/\?/,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(mptsSearch);
      },
    });
    const out = await searchWeb(env, mptsSearch.query, { includeDomains: "mpts-uk.org", recencyMinutes: 43200 });

    const sent = new URL(fetchMock.calls[0]!.url);
    expect(`${sent.origin}${sent.pathname}`).toBe(SEARCH_API);
    expect(sent.searchParams.get("query")).toBe(mptsSearch.query);
    expect(sent.searchParams.get("include_domains")).toBe("mpts-uk.org");
    expect(sent.searchParams.get("recency_minutes")).toBe("43200");
    expect(sent.searchParams.get("purpose")).not.toBeNull();

    expect(out).toHaveLength(mptsSearch.results.length);
    expect(out[0]).toEqual({
      url: "https://www.mpts-uk.org/-/media/mpts-rod-files/dr-a-dunmoor-25-september-2026.pdf",
      title: "PUBLIC RECORD",
      snippet: mptsSearch.results[0]!.snippet,
    });
    expect(out.map((r) => r.url)).toEqual(mptsSearch.results.map((r) => r.url));
  });

  it("sends neither include_domains nor recency_minutes when they are not given", async () => {
    fetchMock.intercept({ method: "GET", url: /^https:\/\/api\.search\.tinyfish\.ai\/\?/, reply: { json: mptsSearch } });
    await searchWeb(env, "Christopher Wickfold GMC");
    const sent = new URL(fetchMock.calls[0]!.url);
    expect(sent.searchParams.get("query")).toBe("Christopher Wickfold GMC");
    expect(sent.searchParams.has("include_domains")).toBe(false);
    expect(sent.searchParams.has("recency_minutes")).toBe(false);
  });

  it("records one search row at $0 whose ref is the domain or 'web', never the query", async () => {
    fetchMock.intercept({ method: "GET", url: /^https:\/\/api\.search\.tinyfish\.ai\/\?/, reply: { json: mptsSearch }, times: 2 });
    await searchWeb(env, "Christopher Wickfold GMC", { includeDomains: "mpts-uk.org" });
    await searchWeb(env, "Christopher Wickfold GMC");
    expect(await spendRows()).toEqual([
      { kind: "search", amount_usd: 0, ref: "mpts-uk.org" },
      { kind: "search", amount_usd: 0, ref: "web" },
    ]);
  });

  it("skips results without a url and tolerates missing title and snippet", async () => {
    fetchMock.intercept({
      method: "GET",
      url: /^https:\/\/api\.search\.tinyfish\.ai\/\?/,
      reply: {
        json: {
          results: [
            { url: "https://a.test/one" },
            { title: "no url", snippet: "x" },
            null,
            "text",
            { url: "" },
            { url: "https://b.test/two", title: 5, snippet: null },
            { url: "https://c.test/three", title: "Three", snippet: "Snippet three" },
          ],
        },
      },
    });
    expect(await searchWeb(env, "q")).toEqual([
      { url: "https://a.test/one", title: "", snippet: "" },
      { url: "https://b.test/two", title: "", snippet: "" },
      { url: "https://c.test/three", title: "Three", snippet: "Snippet three" },
    ]);
  });

  it("returns [] when the answer has no results list, and throws a TinyFishError on an HTTP error", async () => {
    fetchMock.intercept({ method: "GET", url: /^https:\/\/api\.search\.tinyfish\.ai\/\?/, reply: { json: { query: "q" } } });
    expect(await searchWeb(env, "q")).toEqual([]);
    fetchMock.intercept({
      method: "GET",
      url: /^https:\/\/api\.search\.tinyfish\.ai\/\?/,
      reply: { status: 500, json: { error: { code: "INTERNAL" } } },
    });
    await expect(searchWeb(env, "q")).rejects.toMatchObject({ status: 500, code: "INTERNAL" });
  });
});

// ---------------------------------------------------------------------------
// browser.ts
// ---------------------------------------------------------------------------

describe("screenshotFullPage", () => {
  it("records a screenshot spend row at session creation and throws a clear error when there is no cdp_url", async () => {
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: { session_id: "tf-1" } } });
    await expect(screenshotFullPage(env, GMC_RECORD_URL)).rejects.toThrow(/cdp_url/);
    expect(callsTo("POST", BROWSER_API)[0]!.body).toEqual({ url: GMC_RECORD_URL });
    expect(await spendRows()).toEqual([{ kind: "screenshot", amount_usd: 0.002, ref: GMC_RECORD_URL }]);
  });

  it("opens the CDP socket without the API key and throws a clear error when the upgrade is refused", async () => {
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: browserCreate } });
    fetchMock.intercept({
      method: "GET",
      url: browserCreate.base_url,
      reply: (req) => {
        expect(req.headers.get("Upgrade")).toBe("websocket");
        expect(req.headers.get("X-API-Key")).toBeNull();
        return new Response("not a websocket", { status: 200 });
      },
    });
    await expect(screenshotFullPage(env, GMC_RECORD_URL)).rejects.toThrow(/websocket/i);
  });
  it("declines only a plain cookie banner: its 'no' and 'hide' buttons, never an accept or anything else", () => {
    // The real labels of Companies House's and the GMC's banners (9 Nov 2026), and their confirmation.
    for (const label of ["Reject analytics cookies", "Reject cookies", "Reject all", "Use necessary cookies only", "Decline"]) {
      expect(isConsentButton(label, "decline"), label).toBe(true);
    }
    expect(isConsentButton("Hide this message", "hide")).toBe(true);
    for (const label of ["Accept analytics cookies", "Accept all cookies", "Set cookie preferences", "View cookies", "I am not a robot", "Verify you are human", "Continue"]) {
      expect(isConsentButton(label, "decline"), label).toBe(false);
    }
    expect(isConsentButton("Hide this message", "decline")).toBe(false);
 

    // The script sent to the page normalizes whitespace with a real \s (a lost backslash once made it
    // strip every letter s, so "Reject analytics cookies" never matched), and carries the same pattern.
    const script = consentScript(DECLINE_LABEL);
    expect(script).toContain(String.raw`.replace(/\s+/g, " ")`);
    expect(script).toContain(DECLINE_LABEL.toString());
  });
});

// ---------------------------------------------------------------------------
// A 2xx answer that is not JSON
// ---------------------------------------------------------------------------

describe("a 2xx answer that is not JSON", () => {
  const html = { status: 200, headers: { "content-type": "text/html" }, body: "<html>Maintenance</html>" };

  it("becomes a TinyFishError with code bad_json (not a bare SyntaxError) in every client that reads JSON", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: html });
    fetchMock.intercept({ method: "GET", url: `${RUNS_API}/r1?screenshots=none&html=none`, reply: html });
    fetchMock.intercept({ method: "GET", url: /^https:\/\/api\.search\.tinyfish\.ai\/\?/, reply: html });
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: html, times: 2 });
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: html });

    const settled = await Promise.allSettled([
      startRun(env, START_PARAMS),
      getRun(env, "r1", "none"),
      searchWeb(env, "q"),
      createMonitor(env, { url: GMC_RECORD_URL, name: "n", scheduleCron: "7 1,13 * * *", purpose: WATCH_PURPOSE, webhookUrl: CALLBACK_URL }),
      createTopicMonitor(env, { query: "q", name: "n", scheduleCron: "41 5,17 * * *", purpose: WATCH_PURPOSE, webhookUrl: CALLBACK_URL }),
      listMonitors(env),
    ]);
    expect(settled).toHaveLength(6);
    for (const outcome of settled) {
      expect(outcome.status).toBe("rejected");
      const err = (outcome as PromiseRejectedResult).reason as unknown;
      expect(err).toBeInstanceOf(TinyFishError);
      expect(err).toMatchObject({ status: 200, code: "bad_json" });
      expect((err as Error).message).toBe("TinyFish HTTP 200 bad_json");
    }
  });

  it("fetchPage reports it as ok:false bad_json, like any other failed read", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: html });
    expect(await fetchPage(env, GMC_RECORD_URL, "markdown")).toEqual({ ok: false, error: "bad_json", status: 200 });
  });
});

// ---------------------------------------------------------------------------
// companies-house.ts: fetchSearch (wired here because it reads through fetchPage)
// ---------------------------------------------------------------------------

describe("companiesHouse.fetchSearch", () => {
  const searchUrl = (q: string) => companiesHouse.searchQueryUrl(q);

  it("reads the search page with the #results selector and returns the parsed rows", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchChSearch } });
    const rows = await companiesHouse.fetchSearch(env, "greggs");
    expect(callsTo("POST", FETCH_API)[0]!.body).toEqual({
      urls: [searchUrl("greggs")],
      format: "markdown",
      ttl: 0,
      include_etag_and_last_modified: true,
      per_url_timeout_ms: 45000,
      include_selectors: ["#results"],
    });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows).toEqual(companiesHouse.parseSearch(chSearchMarkdown));
    expect(rows.every((r) => r.name !== "")).toBe(true);
    expect(await spendRows()).toEqual([{ kind: "fetch", amount_usd: 0, ref: searchUrl("greggs") }]);
  });

  it("encodes the query in the URL it reads", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchChSearch } });
    await companiesHouse.fetchSearch(env, "Marks & Spencer");
    expect((callsTo("POST", FETCH_API)[0]!.body as { urls: string[] }).urls).toEqual([
      "https://find-and-update.company-information.service.gov.uk/search/companies?q=Marks%20%26%20Spencer",
    ]);
  });

  it("returns [] for a successful page with no result rows", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: {
        json: {
          results: [{ url: searchUrl("zzzz"), final_url: searchUrl("zzzz"), title: "Company search results", text: "No results found for zzzz." }],
          errors: [],
        },
      },
    });
    expect(await companiesHouse.fetchSearch(env, "zzzz")).toEqual([]);
  });

  it("throws an error naming selector_not_matched, instead of returning an empty list that would read as no_match", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchSelectorNotMatched } });
    const err = await companiesHouse.fetchSearch(env, "greggs").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("selector_not_matched");
    expect(err).toMatchObject({ code: "selector_not_matched" });
  });

  it("never carries upstream text in the error: a per-URL error that is a sentence is named fetch_error", async () => {
    const sentence = `refused ${searchUrl("greggs")}?token=${env.WEBHOOK_SECRET}`;
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [], errors: [{ url: searchUrl("greggs"), error: sentence }] } },
    });
    const err = await companiesHouse.fetchSearch(env, "greggs").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "fetch_error" });
    expect((err as Error).message).toBe("Companies House search could not be read: fetch_error");
    expect((err as Error).message).not.toContain(env.WEBHOOK_SECRET);
  });

  it("throws naming the code for any other Fetch error: a per-URL error, an HTTP error, or no result", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [], errors: [{ url: searchUrl("greggs"), error: "bot_blocked" }] } },
    });
    await expect(companiesHouse.fetchSearch(env, "greggs")).rejects.toThrow(/bot_blocked/);

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { status: 503, body: "down" } });
    const http = await companiesHouse.fetchSearch(env, "greggs").catch((e: unknown) => e);
    expect((http as Error).message).toContain("http_503");
    expect(http).toMatchObject({ status: 503, code: "http_503" });

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: { results: [], errors: [] } } });
    await expect(companiesHouse.fetchSearch(env, "greggs")).rejects.toThrow(/no_result/);
  });
});
