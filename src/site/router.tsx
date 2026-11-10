// The site: server-rendered screens over the same read functions as the JSON API. Mounted last in
// src/index.ts, so every API, hook and evidence route keeps its own answer. Behind SITE_ENABLED:
// switched off, every site path answers exactly as the Worker did before the site existed.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isAdmin, visitorHash } from "../auth";
import { spendPaused } from "../checks/queue";
import { CheckRejected, startCheck, type CheckInput } from "../checks/run";
import { latestMatchCheck, sampleCheck } from "../db/checks";
import { listEventsForRecord, statusChangeFeed } from "../db/events";
import { getRecord, homeRecord } from "../db/records";
import { activeWatchForRecord, latestPublicWatch, publicSlots, watchlistRows } from "../db/watches";
import type { Env } from "../env";
import { readCheck } from "../handlers/checks";
import { readCoverage } from "../handlers/registries";
import { readStats } from "../handlers/stats";
import { publicRecord } from "../checks/view";
import { recordView } from "../monitoring/events";
import { createWatch, nextRun, staggeredCron, WatchRefused, watchKindFor } from "../monitoring/watch";
import { getAdapterById } from "../registries/index";
import type { RecordResult } from "../core/schema";
import { cacheKey, CHECK_ID_SHAPE, plainUrl, readCached, storeFresh } from "./htmlCache";
import { PageContext } from "./layout";
import { AGENT_CAP_LINE, DAILY_LIMIT_LINE, MONITOR_FAILED_LINE, NOT_WATCHABLE_LINE, slotsFullLine, SPEND_PAUSED_LINE, WATCH_DAILY_LIMIT_LINE } from "./format";
import { CheckPage, MAX_WAITS, Receipt, type CheckScreen } from "./views/check";
import { Home, type FormState, type HomeProps } from "./views/home";
import { AboutPage } from "./views/about";
import { ApiPage, type ApiSamples } from "./views/api";
import { CoveragePage } from "./views/coverage";
import { NotFound, ServerError } from "./views/notFound";
import { RecordPage, type RecordPageProps } from "./views/record";
import { Watchlist } from "./views/watchlist";

type AppContext = Context<{ Bindings: Env }>;

/** Sent with every HTML response (the site plan's Global Constraints). */
export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
} as const;

export const siteEnabled = (env: Env): boolean => env.SITE_ENABLED === "1";

const render = (c: AppContext, page: Child, status: ContentfulStatusCode = 200): Response | Promise<Response> =>
  c.html(
    (
      <PageContext.Provider value={{ base: c.env.PUBLIC_BASE_URL.replace(/\/+$/, ""), path: c.req.path }}>{page}</PageContext.Provider>
    ) as unknown as string | Promise<string>,
    status,
    { ...SECURITY_HEADERS, "cache-control": "max-age=0, no-store" },
  );

/** Paths that are never a screen: the API, the hooks and the evidence files answer as they always did. */
const notAScreen = (path: string): boolean => /^\/(?:api|hooks|evidence)(?:\/|$)/.test(path);

/**
 * The Worker's 404 (src/index.ts `app.notFound`). With the site off, and for the API, the hooks and
 * the evidence files, it is Hono's own plain "404 Not Found", as before the site existed; any other
 * path gets the site's 404 page.
 */
export function notFound(c: AppContext): Response | Promise<Response> {
  if (!siteEnabled(c.env) || notAScreen(c.req.path)) return c.text("404 Not Found", 404);
  return render(c, <NotFound />, 404);
}

export const siteRouter = new Hono<{ Bindings: Env }>();

/** Hands work to the request's waitUntil (a context-less call just runs it). */
const schedule =
  (c: AppContext) =>
  (work: Promise<unknown>): void => {
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      // no execution context
    }
  };

/**
 * A screen that may be served from its stored copy: `key` names it, and a URL with a query string is
 * never stored. Otherwise rendered fresh, sent, and stored after the response.
 */
async function screen(c: AppContext, key: string | null, build: () => Promise<Response>): Promise<Response> {
  if (key === null || !plainUrl(c.req.url)) return build();
  const hit = await readCached(c.env, key);
  if (hit !== null) return hit;
  return storeFresh(c.env, schedule(c), key, build());
}

/**
 * A check's screen (its page or its receipt): served from the stored copy when there is one, otherwise
 * rendered, and stored only once the check is done. Never stored or served stored: a pending check, a
 * URL with a query string, an id Standing would not make, and what an admin sees.
 */
async function checkScreen(c: AppContext, key: (id: string) => string, build: () => Promise<{ page: Response | Promise<Response>; done: boolean }>): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const storable = CHECK_ID_SHAPE.test(id) && plainUrl(c.req.url) && !isAdmin(c);
  if (storable) {
    const hit = await readCached(c.env, key(id));
    if (hit !== null) return hit;
  }
  const { page, done } = await build();
  return storable && done ? storeFresh(c.env, schedule(c), key(id), page) : page;
}

siteRouter.onError((err, c) => {
  console.error("site handler failed", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  return render(c, <ServerError />, 500);
});

/** The home's record card: the newest curated or watched record with a match, as GET /api/records/:id shows it. */
async function homeCard(env: Env): Promise<HomeProps["card"]> {
  const record = await homeRecord(env.DB);
  if (record === null) return null;
  const [check, watch] = await Promise.all([latestMatchCheck(env.DB, record.id), activeWatchForRecord(env.DB, record.id)]);
  if (check === null) return null;
  const view = recordView(env, record, check, watch);
  if (view.outcome !== "match") return null;
  // Nothing on the home was read for this request, so the card is a stored result with its read time.
  return { record: view, check: { live: false, matchedBy: check.number !== null ? "number" : "name" } };
}

/** How many status changes the home lists. */
const FEED_SIZE = 6;

/** Everything the home shows, each part read the way its JSON route reads it. */
async function homeProps(env: Env): Promise<HomeProps> {
  const [stats, paused, card, amb, noMatch, changes] = await Promise.all([
    readStats(env.DB),
    spendPaused(env.DB),
    homeCard(env),
    sampleCheck(env.DB, "ambiguous", true),
    sampleCheck(env.DB, "no_match"),
    statusChangeFeed(env.DB, FEED_SIZE),
  ]);
  const ambiguous = amb === null ? null : { check: amb, record: await publicRecord(env, amb) };
  return { stats, paused, card, ambiguous, noMatchId: noMatch?.id ?? null, changes, watched: stats.monitors.active };
}

siteRouter.get("/", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  return screen(c, cacheKey.home(), async () => render(c, <Home {...await homeProps(c.env)} />));
});

/** The home with the form as it was sent: a field error or a refusal line, and its HTTP status. */
async function homeAgain(c: AppContext, form: FormState, status: ContentfulStatusCode): Promise<Response> {
  return render(c, <Home {...await homeProps(c.env)} form={form} />, status);
}

/** A form post replayed within this many seconds (a reload, a double click) opens the check it started. */
const REPLAY_SECONDS = 120;

const FORM_FIELDS = ["q", "number", "record_type", "place", "profession", "force"] as const;

/** The form's fields as the checks API reads them. The licence type is sent only for California. */
function formInput(v: Record<string, string>): CheckInput {
  return {
    query: v.q || undefined,
    number: v.number || undefined,
    record_type: v.record_type ?? "",
    jurisdiction: v.place ?? "",
    profession: v.place === "US-CA" && v.profession ? v.profession : undefined,
    fresh: v.force === "1",
  };
}

/** The field a refused query belongs to, and its sentence in the form's words. */
function fieldError(v: Record<string, string>, detail: string): NonNullable<FormState["error"]> {
  const text = detail.replace("send the company name as query instead of a number", "enter the company name instead of a number");
  if (/profession/i.test(detail) && v.number) return { field: "profession", text: text.replace(/\bprofession\b/g, "licence type") };
  return { field: v.number ? "number" : "q", text: text.charAt(0).toUpperCase() + text.slice(1) };
}

// POST /check: the same function as POST /api/checks, then 303 to the check's page.
siteRouter.post("/check", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  const body = await c.req.parseBody();
  const values: Record<string, string> = {};
  for (const key of FORM_FIELDS) {
    const value = body[key];
    if (typeof value === "string") values[key] = value.trim().slice(0, 1000);
  }
  const who = { admin: isAdmin(c), ipHash: await visitorHash(c.env, c.req.header("CF-Connecting-IP")) };
  try {
    const started = await startCheck(c.env, formInput(values), who, (work) => c.executionCtx.waitUntil(work), { replaySeconds: REPLAY_SECONDS });
    return c.redirect(`/checks/${started.checkId}`, 303);
  } catch (err) {
    if (!(err instanceof CheckRejected)) throw err;
    const { error } = err.body;
    const detail = typeof err.body.detail === "string" ? err.body.detail : "Enter a name or a registration number.";
    if (error === "unsupported") {
      const [stats, paused] = await Promise.all([readStats(c.env.DB), spendPaused(c.env.DB)]);
      const screen: CheckScreen = { kind: "unsupported", recordType: values.record_type ?? "", place: values.place ?? "" };
      return render(c, <CheckPage screen={screen} stats={stats} paused={paused} />, 400);
    }
    if (error === "spend_paused") return homeAgain(c, { values }, 503);
    if (error === "daily_limit") return homeAgain(c, { values, notice: DAILY_LIMIT_LINE }, 429);
    if (error === "daily_agent_checks_used") return homeAgain(c, { values, notice: AGENT_CAP_LINE }, 429);
    return homeAgain(c, { values, error: fieldError(values, detail) }, err.status);
  }
});

/** The pending page's counter: how many times it has reloaded itself (0 to MAX_WAITS). */
function waits(raw: string | undefined): number {
  const n = raw !== undefined && /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  return Math.min(n, MAX_WAITS);
}

/** A match's current watch (the check's JSON has none: the watch belongs to the record, not the check). */
async function withWatch<T extends RecordResult>(env: Env, record: T): Promise<T> {
  if (record.outcome !== "match" || record.record_id === null) return record;
  const watch = await activeWatchForRecord(env.DB, record.record_id);
  return watch !== null && (watch.kind === "page" || watch.kind === "topic") ? { ...record, watch: { watch_id: watch.id, kind: watch.kind } } : record;
}

// GET /checks/:id: the result for every outcome, or the pending page that refreshes itself.
siteRouter.get("/checks/:id", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  return checkScreen(c, cacheKey.check, async () => {
    const read = await readCheck(c.env, c.req.param("id"), (work) => c.executionCtx.waitUntil(work));
    if (read === null) return { page: render(c, <NotFound />, 404), done: false };
    const [stats, paused] = await Promise.all([readStats(c.env.DB), spendPaused(c.env.DB)]);
    const screen: CheckScreen = read.pending
      ? { kind: "pending", check: read.check, pending: read.pending, wait: waits(c.req.query("w")) }
      : { kind: "result", check: read.check, record: await withWatch(c.env, read.record) };
    return { page: render(c, <CheckPage screen={screen} stats={stats} paused={paused} />), done: !read.pending };
  });
});

// GET /checks/:id/receipt: the printable receipt of a match; any other outcome has none.
siteRouter.get("/checks/:id/receipt", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  return checkScreen(c, cacheKey.receipt, async () => {
    const read = await readCheck(c.env, c.req.param("id"), (work) => c.executionCtx.waitUntil(work));
    if (read === null || read.record === undefined || read.record.outcome !== "match") return { page: render(c, <NotFound />, 404), done: false };
    const stats = await readStats(c.env.DB);
    const page = render(c, <Receipt check={read.check} record={await withWatch(c.env, read.record)} baseUrl={c.env.PUBLIC_BASE_URL} stats={stats} />);
    return { page, done: true };
  });
});

/** Everything the record page shows, read the same way GET /api/records/:id and its history are. */
async function recordPage(c: AppContext, recordId: string, notice?: string): Promise<RecordPageProps | null> {
  const env = c.env;
  const row = await getRecord(env.DB, recordId);
  if (row === null) return null;
  const [check, watch, publicWatch, events, slots, stats, paused] = await Promise.all([
    latestMatchCheck(env.DB, row.id),
    activeWatchForRecord(env.DB, row.id),
    latestPublicWatch(env.DB, row.id),
    listEventsForRecord(env.DB, row.id),
    publicSlots(env.DB),
    readStats(env.DB),
    spendPaused(env.DB),
  ]);
  const record = recordView(env, row, check, watch);
  if (record.outcome !== "match") return null;
  const adapter = row.registry === null ? null : getAdapterById(row.registry);
  const schedule = staggeredCron(row.id);
  return {
    stats,
    paused,
    record,
    // Nothing on this page was read for this request: the record is a stored result with its read time.
    check: { live: false, matchedBy: check?.number ? "number" : "name" },
    watch,
    publicWatch,
    kind: adapter === null ? null : watchKindFor(adapter, row),
    nextCheck: watch === null ? null : nextRun(schedule.minute, schedule.hour),
    events,
    firstReadAt: row.first_seen_at,
    slots,
    admin: isAdmin(c),
    ...(notice === undefined ? {} : { notice }),
  };
}

// GET /records/:id: a record with its watch and its history.
siteRouter.get("/records/:id", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  const id = c.req.param("id");
  const row = await getRecord(c.env.DB, id);
  if (row === null) return render(c, <NotFound />, 404);
  // A watched or curated record's page is stored; a one-off lookup's is not, nor what an admin sees.
  const key = row.watched === 1 && !isAdmin(c) ? cacheKey.record(id) : null;
  return screen(c, key, async () => {
    const props = await recordPage(c, id);
    return props === null ? render(c, <NotFound />, 404) : render(c, <RecordPage {...props} />);
  });
});

// POST /records/:id/watch: the same function as POST /api/records/:id/watch, then 303 back to the record.
siteRouter.post("/records/:id/watch", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  const id = c.req.param("id");
  const who = { admin: isAdmin(c), ipHash: await visitorHash(c.env, c.req.header("CF-Connecting-IP")) };
  try {
    await createWatch(c.env, id, { callbackUrl: null }, who);
    return c.redirect(`/records/${id}`, 303);
  } catch (err) {
    if (!(err instanceof WatchRefused)) throw err;
    if (err.status === 404) return render(c, <NotFound />, 404);
    // Sent again after it worked: the record is watched, which is what was asked.
    if (err.body.error === "already_watched") return c.redirect(`/records/${id}`, 303);
    const slots = await publicSlots(c.env.DB);
    const notice =
      err.body.error === "public_slots_full" || err.body.error === "watchlist_full"
        ? slotsFullLine(slots.nextFreesAt)
        : err.body.error === "daily_limit"
          ? WATCH_DAILY_LIMIT_LINE
          : err.body.error === "spend_paused"
            ? SPEND_PAUSED_LINE
            : err.body.error === "not_watchable"
              ? NOT_WATCHABLE_LINE
              : MONITOR_FAILED_LINE;
    const props = await recordPage(c, id, notice);
    if (props === null) return render(c, <NotFound />, 404);
    return render(c, <RecordPage {...props} />, err.status);
  }
});

// GET /watchlist: every watched or curated record, curated first.
siteRouter.get("/watchlist", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  return screen(c, cacheKey.watchlist(), async () => {
    const [rows, slots, stats, paused] = await Promise.all([watchlistRows(c.env.DB), publicSlots(c.env.DB), readStats(c.env.DB), spendPaused(c.env.DB)]);
    return render(c, <Watchlist stats={stats} paused={paused} rows={rows} slots={slots} />);
  });
});

// GET /coverage: the same data as GET /api/registries.
siteRouter.get("/coverage", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  return screen(c, cacheKey.coverage(), async () => {
    const [coverage, stats, paused] = await Promise.all([readCoverage(c.env.DB), readStats(c.env.DB), spendPaused(c.env.DB)]);
    return render(c, <CoveragePage stats={stats} paused={paused} coverage={coverage} />);
  });
});

/** One stored answer of each outcome, as GET /api/checks/:id returns it. */
async function apiSamples(env: Env): Promise<ApiSamples> {
  const read = async (outcome: "match" | "ambiguous" | "no_match") => {
    const check = await sampleCheck(env.DB, outcome);
    return check === null ? null : publicRecord(env, check);
  };
  const [match, ambiguous, no_match] = await Promise.all([read("match"), read("ambiguous"), read("no_match")]);
  return { match, ambiguous, no_match };
}

// GET /api: the API page (every /api/... path below it stays the API's own).
siteRouter.get("/api", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  return screen(c, cacheKey.api(), async () => {
    const [samples, stats, paused] = await Promise.all([apiSamples(c.env), readStats(c.env.DB), spendPaused(c.env.DB)]);
    return render(c, <ApiPage stats={stats} paused={paused} baseUrl={c.env.PUBLIC_BASE_URL} samples={samples} />);
  });
});

// GET /about
siteRouter.get("/about", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  return screen(c, cacheKey.about(), async () => {
    const [stats, paused] = await Promise.all([readStats(c.env.DB), spendPaused(c.env.DB)]);
    return render(c, <AboutPage stats={stats} paused={paused} repoUrl={c.env.REPO_URL?.trim() || null} />);
  });
});
