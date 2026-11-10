// Shared helpers for the checks, callback and queue tests: a clean database and bucket per
// test, the browser screenshot and the 60 s rate-limit wait stubbed through `checkDeps`
// (vi.mock does not work in the Workers pool), and small builders for the TinyFish answers.
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi, type MockInstance } from "vitest";
import { checkDeps } from "../../src/checks/deps";
import { callWorker } from "./app";
import { fetchMock } from "./fetch-mock";

export const FETCH_API = "https://api.fetch.tinyfish.ai/";
export const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
export const RUNS_API = "https://agent.tinyfish.ai/v1/runs";
export const AGENT_CALLBACK = "https://standing.test/hooks/agent/test-secret";
export const GMC_URL = "https://www.gmc-uk.org/registrants/9360749";

/** A few bytes that start and end like a JPEG. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

export let shot: MockInstance<typeof checkDeps.screenshotFullPage>;
const realSleep = checkDeps.sleep;

/** A clean database (migrations re-applied, so the agent slot row exists and is free), a clean
 *  bucket, fetch intercepted, the screenshot stubbed and the rate-limit wait instant. */
export async function freshState(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fetchMock.activate();
  checkDeps.sleep = async () => {};
  shot = vi.spyOn(checkDeps, "screenshotFullPage").mockImplementation(async () => ({
    bytes: JPEG.slice().buffer,
    height: 900,
    sessionId: "tf-test-session",
  }));
}

export function restoreState(): void {
  shot.mockRestore();
  checkDeps.sleep = realSleep;
  fetchMock.reset();
  vi.useRealTimers();
}

export function postCheck(body: unknown, opts: { ip?: string; admin?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "CF-Connecting-IP": opts.ip ?? "198.51.100.7",
  };
  if (opts.admin) headers.Authorization = "Bearer test-admin";
  return callWorker("/api/checks", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

export async function getCheckJson(id: string): Promise<Record<string, unknown>> {
  const res = await callWorker(`/api/checks/${id}`);
  return (await res.json()) as Record<string, unknown>;
}

export function agentCallback(payload: unknown, secret = "test-secret"): Promise<Response> {
  return callWorker(`/hooks/agent/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function mockStartRun(runId: string): void {
  fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: runId } } });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** GET /v1/runs/<id>?... answered with `run`. */
export function mockGetRun(runId: string, run: unknown, times = 1): void {
  fetchMock.intercept({ method: "GET", url: new RegExp(`^${escapeRe(RUNS_API)}/${escapeRe(runId)}\\?`), reply: { json: run }, times });
}

/** The API-key screenshot endpoint for one step, answered with JPEG bytes. */
export function mockStepShot(runId: string, stepId: string): void {
  fetchMock.intercept({
    method: "GET",
    url: `${RUNS_API}/${runId}/steps/${stepId}/screenshot`,
    reply: () => new Response(JPEG.slice(), { headers: { "content-type": "image/jpeg" } }),
  });
}

/** TinyFetch's answer for one page read. */
export function pageResponse(url: string, text: string): unknown {
  return { results: [{ url, final_url: url, title: null, text }], errors: [] };
}

/** Answers every TinyFetch call from `pages` by the URL it asks for; any other URL fails the test. */
export function mockFetchPages(pages: Record<string, unknown>): void {
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const url = (body as { urls?: string[] }).urls?.[0] ?? "";
      if (!Object.hasOwn(pages, url)) throw new Error(`unexpected TinyFetch read of ${url}`);
      return Response.json(pages[url]);
    },
  });
}

/** A finished run as GET /v1/runs/<id> returns it. */
export function completedRun(runId: string, result: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: runId,
    status: "COMPLETED",
    started_at: "2026-11-03T09:00:00Z",
    finished_at: "2026-11-03T09:01:30Z",
    num_of_steps: 9,
    result,
    error: null,
    steps: [],
    ...over,
  };
}

export function callsTo(method: string, url: string) {
  return fetchMock.calls.filter((c) => c.method === method && c.url === new URL(url).href);
}

export async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function spendRows(): Promise<{ kind: string; amount_usd: number; ref: string }[]> {
  const { results } = await env.DB.prepare("SELECT kind, amount_usd, ref FROM spend ORDER BY at, rowid").all<{
    kind: string;
    amount_usd: number;
    ref: string;
  }>();
  return results;
}

export async function slotRow(): Promise<{ holder_check_id: string | null; since: string | null }> {
  const row = await env.DB.prepare("SELECT holder_check_id, since FROM agent_slot WHERE id = 1").first<{
    holder_check_id: string | null;
    since: string | null;
  }>();
  if (!row) throw new Error("agent_slot has no row");
  return row;
}

/** Posts a name check that goes to the Agent and returns its id; the run starts as `runId`. A public
 *  visitor's check unless `opts.admin`. */
export async function startAgentCheck(query: string, runId: string, extra: Record<string, unknown> = {}, opts: { admin?: boolean } = {}): Promise<string> {
  mockStartRun(runId);
  const res = await postCheck({ query, record_type: "doctor", jurisdiction: "GB", ...extra }, opts);
  if (res.status !== 202) throw new Error(`POST /api/checks answered ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { check_id: string }).check_id;
}
