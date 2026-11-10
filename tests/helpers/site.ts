// Helpers for the site's screens: seed a stored record with its match check, and read an HTML page as
// text the way a person reads it.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { insertCheck } from "../../src/db/checks";
import { upsertRecord } from "../../src/db/records";
import { insertWatch } from "../../src/db/watches";
import type { Env } from "../../src/env";
import worker from "../../src/index";

/** The Worker called in-process with some bindings changed (the site switched off, say). */
export async function callWith(over: Partial<Env>, path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(new URL(path, "https://standing.test").href, init), { ...env, ...over } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** The visible text of an HTML fragment: tags dropped, the entities JSX writes decoded, spaces collapsed. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first element with this class, as HTML (enough for the flat elements the tests look at). */
export function byClass(html: string, cls: string, tag = "[a-z]+"): string | null {
  const m = new RegExp(`<(${tag})\\b[^>]*class="(?:[^"]* )?${cls}(?: [^"]*)?"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return m ? m[0] : null;
}

export const EVIDENCE_CHECK = "0b0c0d0e-1111-4222-8333-444455556666";

/**
 * A curated Companies House record (the shape the live export shows, under an invented name) with
 * its finished match check, a curated Page watch and its evidence key. `cached` adds a later check
 * that is a cached copy of the first, so it is the record's latest match check.
 */
export async function seedCompany(opts: { name?: string; number?: string; cached?: boolean; curated?: boolean; watched?: boolean } = {}): Promise<{ recordId: string; checkId: string }> {
  const number = opts.number ?? "99000001";
  const checkedAt = "2026-11-09T07:55:00.621Z";
  const evidenceKey = `evidence/${EVIDENCE_CHECK}.jpg`; // shared by every seeded record; only the first check has this id
  const recordId = await upsertRecord(env.DB, {
    registry: "companies-house",
    record_type: "company",
    record: {
      full_name: opts.name ?? "ADA FICTITIOUS TRADING LIMITED",
      licence_number: number,
      status_raw: "Active — Active proposal to strike off",
      status: "active",
      flags: ["proposal_to_strike_off"],
      disciplinary: [],
      registered_since: "2016-10-13",
      raw_fields: {
        company_type: "Private limited Company",
        address: "1 Example Road, Enfield, England, EN3 7UL",
        sic_codes: [
          { code: "86101", description: "Hospital activities" },
          { code: "86900", description: "Other human health activities" },
        ],
        previous_names: [],
      },
    },
    source_url: `https://find-and-update.company-information.service.gov.uk/company/${number}`,
    evidence_key: evidenceKey,
    checked_at: checkedAt,
  });
  const base = {
    state: "done" as const,
    registry: "companies-house",
    record_type: "company" as const,
    jurisdiction: "GB" as const,
    number,
    outcome: "match" as const,
    status: "active" as const,
    flags: ["proposal_to_strike_off" as const],
    record_id: recordId,
    method: "fetch" as const,
    evidence_key: evidenceKey,
    added_by: "admin" as const,
    started_at: checkedAt,
    checked_at: checkedAt,
  };
  let checkId = await insertCheck(env.DB, opts.number === undefined ? { ...base, id: EVIDENCE_CHECK } : base);
  if (opts.cached) checkId = await insertCheck(env.DB, { ...base, cached_from_check_id: checkId, started_at: "2026-11-09T09:00:00.000Z" });
  // (a cached copy keeps the original read time, as serveCached does)
  if (opts.watched === false) return { recordId, checkId };
  if (opts.curated !== false) await insertWatch(env.DB, { record_id: recordId, kind: "page", monitor_id: `m-curated-${number}`, added_by: "curated" });
  await env.DB.prepare("UPDATE records SET watched = 1 WHERE id = ?").bind(recordId).run();
  return { recordId, checkId };
}
