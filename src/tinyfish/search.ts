// TinySearch: ranked web results for a query, used for name-variant discovery and to find a
// registry's decision pages. Free (12,000 requests a day), but each call appends a $0 spend row.
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { readJson, tinyfishFetch } from "./client";

const SEARCH_API = "https://api.search.tinyfish.ai";
// Every verified Search call (the spikes, Fineprint) carried a purpose; it costs nothing to send.
const SEARCH_PURPOSE = "find public references and decision pages for a professional or company registry lookup";

export type SearchHit = { url: string; title: string; snippet: string };

/**
 * One search. `includeDomains` restricts it to a domain; `recencyMinutes` to results that new.
 * Results without a url are skipped and a missing title or snippet becomes "". The spend row's
 * ref is the domain (or "web"), never the query: a query can name a person, and the ledger
 * outlives a public check.
 */
export async function searchWeb(
  env: Env,
  query: string,
  opts: { includeDomains?: string; recencyMinutes?: number } = {},
): Promise<SearchHit[]> {
  const u = new URL(SEARCH_API);
  u.searchParams.set("query", query);
  if (opts.includeDomains) u.searchParams.set("include_domains", opts.includeDomains);
  if (opts.recencyMinutes !== undefined) u.searchParams.set("recency_minutes", String(opts.recencyMinutes));
  u.searchParams.set("purpose", SEARCH_PURPOSE);

  const res = await tinyfishFetch(env, u.toString(), {
    method: "GET",
    spend: { kind: "search", amountUsd: PRICES.search, ref: opts.includeDomains || "web" },
  });
  // Shape confirmed live: { query, results: [{ position, site_name, snippet, title, url, date? }], ... }
  const body = await readJson<{ results?: unknown }>(res);
  if (!Array.isArray(body.results)) return [];
  const hits: SearchHit[] = [];
  for (const r of body.results as unknown[]) {
    if (r === null || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.url !== "string" || o.url === "") continue;
    hits.push({
      url: o.url,
      title: typeof o.title === "string" ? o.title : "",
      snippet: typeof o.snippet === "string" ? o.snippet : "",
    });
  }
  return hits;
}
