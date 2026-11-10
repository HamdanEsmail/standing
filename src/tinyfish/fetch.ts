// TinyFetch: one page as markdown or cleaned HTML. Free (within 1,000 URLs a day),
// but each call still appends a $0 spend row.
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { errorCodeOrNull, readJson, TinyFishError, tinyfishFetch } from "./client";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const PER_URL_TIMEOUT_MS = 45_000;

/** Options a registry adapter declares for reading its pages (`FetchOptions` in registries/types.ts). */
export type FetchPageOptions = {
  /**
   * CSS selectors to keep: TinyFetch returns only the matching parts of the page. When none
   * match, the answer is a per-URL error `selector_not_matched` (see fetchPage).
   */
  include_selectors?: string[];
  /** Also return the page's link addresses, in page order (Sunbiz rows link to their record pages). */
  links?: boolean;
};

export type FetchPageResult =
  | { ok: true; text: string; title: string | null; finalUrl: string; links: string[] }
  | { ok: false; error: string; status?: number };

type FetchBody = {
  results?: { text?: unknown; title?: unknown; final_url?: unknown; links?: unknown }[];
  errors?: { error?: unknown }[];
};

// Only a short token (`bot_blocked`, `selector_not_matched`) is kept. Upstream text of any other
// shape, which could echo the URL or what we sent, becomes `fetch_error`.
function errorText(entry: { error?: unknown } | undefined): string {
  const e = entry?.error;
  if (e !== null && typeof e === "object") return errorCodeOrNull((e as { code?: unknown }).code) ?? "fetch_error";
  return errorCodeOrNull(e) ?? "fetch_error";
}

/**
 * Reads one page. A per-URL failure comes back as `{ ok: false, error }` with TinyFetch's own
 * code (`bot_blocked`, `target_unreachable`, `selector_not_matched`, ...), a failed call as the
 * HTTP error code with its `status`. It does not throw for either, so the caller decides what a
 * failed read means; it must never treat one as an empty page.
 */
export async function fetchPage(
  env: Env,
  url: string,
  format: "markdown" | "html",
  opts: FetchPageOptions = {},
): Promise<FetchPageResult> {
  let body: FetchBody;
  try {
    const res = await tinyfishFetch(env, FETCH_API, {
      method: "POST",
      body: JSON.stringify({
        urls: [url],
        format,
        ttl: 0,
        include_etag_and_last_modified: true,
        per_url_timeout_ms: PER_URL_TIMEOUT_MS,
        ...(opts.include_selectors && opts.include_selectors.length > 0 ? { include_selectors: opts.include_selectors } : {}),
        ...(opts.links ? { links: true } : {}),
      }),
      spend: { kind: "fetch", amountUsd: PRICES.fetch, ref: url },
    });
    body = await readJson<FetchBody>(res);
  } catch (err) {
    if (err instanceof TinyFishError) return { ok: false, error: err.code, status: err.status };
    throw err;
  }

  if (body.errors && body.errors.length > 0) return { ok: false, error: errorText(body.errors[0]) };
  const first = body.results?.[0];
  if (!first || typeof first.text !== "string") return { ok: false, error: "no_result" };
  return {
    ok: true,
    text: first.text,
    title: typeof first.title === "string" ? first.title : null,
    finalUrl: typeof first.final_url === "string" && first.final_url !== "" ? first.final_url : url,
    links: Array.isArray(first.links) ? first.links.filter((l): l is string => typeof l === "string") : [],
  };
}
