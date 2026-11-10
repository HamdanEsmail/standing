// Stored copies of the screens many people open (the home, coverage, API, About, the watchlist, the
// pages of watched or curated records, and finished checks with their receipts), kept in R2 under screens/<stamp>/<key>. The stamp is the Worker
// version's id, so a deploy (or a preview) never serves another version's markup. A copy is dropped when
// an event, a watch change or a new read of a record alters what it shows, and the hourly job drops them
// all (in the same run that deletes expired public checks, so no copy outlives its check); the next visit
// renders the screen again and stores it. A failed read or write is a miss, never an error.
import type { Env } from "../env";

export const CACHE_HEADER = "x-standing-cache";
/** Everything this module keeps lives under this prefix, and it never lists or deletes outside it. */
const ROOT = "screens/";
const STAMP_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
/** A copy older than this is not served (the hourly job drops them sooner; this bounds a missed drop). */
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** The headers a fresh render sends, replayed with the stored copy. */
const KEPT_HEADERS = ["content-type", "content-security-policy", "x-content-type-options", "referrer-policy", "cache-control"];

export const cacheKey = {
  home: () => "home",
  coverage: () => "coverage",
  api: () => "api",
  about: () => "about",
  watchlist: () => "watchlist",
  record: (recordId: string) => `record/${recordId}`,
  check: (checkId: string) => `check/${checkId}`,
  receipt: (checkId: string) => `receipt/${checkId}`,
} as const;

/** A check id as Standing makes them; anything else is never a stored key. */
export const CHECK_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** At most this many of a record's checks have their copies dropped at once (an R2 delete takes 1,000 keys). */
const CHECKS_PER_DROP = 400;

/** "0" turns stored copies off (tests do); anything else, or nothing, leaves them on. */
export const cacheOn = (env: Env): boolean => env.HTML_CACHE !== "0";

/** This version's stamp. */
function stamp(env: Env): string {
  const id = env.CF_VERSION_METADATA?.id ?? "";
  return STAMP_SHAPE.test(id) ? id : "unversioned";
}

const r2Key = (env: Env, key: string): string => `${ROOT}${stamp(env)}/${key}`;

/** True when the URL has no query string: any parameter makes it a screen of its own, never stored. */
export const plainUrl = (url: string): boolean => new URL(url).search === "";

/** The stored copy of `key`, marked `hit`, or null. */
export async function readCached(env: Env, key: string): Promise<Response | null> {
  if (!cacheOn(env)) return null;
  try {
    const object = await env.STORE.get(r2Key(env, key));
    if (object === null) return null;
    const wrote = Number(object.customMetadata?.at) || object.uploaded.getTime();
    if (Date.now() - wrote > MAX_AGE_MS) return null;
    const headers = new Headers(JSON.parse(object.customMetadata?.headers ?? "{}") as Record<string, string>);
    headers.set(CACHE_HEADER, "hit");
    return new Response(object.body, { status: 200, headers });
  } catch {
    console.error("stored screen read failed");
    return null;
  }
}

/** Marks a fresh render `miss` and stores a copy of a 200 after the response is sent (`schedule` is waitUntil). */
export async function storeFresh(env: Env, schedule: (work: Promise<unknown>) => void, key: string, rendered: Response | Promise<Response>): Promise<Response> {
  const res = await rendered;
  if (!cacheOn(env)) return res;
  const out = new Response(res.body, res);
  out.headers.set(CACHE_HEADER, "miss");
  if (out.status !== 200) return out;
  const copy = out.clone();
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = out.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  schedule(
    copy
      .text()
      .then((html) => env.STORE.put(r2Key(env, key), html, { customMetadata: { headers: JSON.stringify(headers), at: String(Date.now()) } }))
      .catch(() => console.error("stored screen write failed")),
  );
  return out;
}

/** Drops the stored copies of these screens under this version's stamp. Never throws. */
export async function dropScreens(env: Env, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await env.STORE.delete(keys.map((k) => r2Key(env, k)));
  } catch {
    console.error("stored screen drop failed");
  }
}

/**
 * What an event, a watch change or a new read of this record alters: the home (its card and feed), the
 * watchlist, the record's page, and the page and receipt of every check that shows it (the newest
 * CHECKS_PER_DROP; the hourly job drops the rest). Never throws.
 */
export async function dropForRecord(env: Env, recordId: string): Promise<void> {
  const keys = [cacheKey.home(), cacheKey.watchlist(), cacheKey.record(recordId)];
  try {
    const { results } = await env.DB.prepare("SELECT id FROM checks WHERE record_id = ? ORDER BY rowid DESC LIMIT ?")
      .bind(recordId, CHECKS_PER_DROP)
      .all<{ id: string }>();
    for (const { id } of results) keys.push(cacheKey.check(id), cacheKey.receipt(id));
  } catch {
    console.error("stored screen drop: checks not read");
  }
  await dropScreens(env, keys);
}

/** The hourly job: every stored screen, of every version, is dropped (the next visit stores it again). Throws when R2 does. */
export async function dropAllScreens(env: Env): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.STORE.list({ prefix: ROOT, cursor });
    const keys = listed.objects.map((o) => o.key).filter((k) => k.startsWith(ROOT));
    if (keys.length > 0) await env.STORE.delete(keys);
    deleted += keys.length;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
}
