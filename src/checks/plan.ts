// What a check searches for, worked out the same way when it is asked (POST /api/checks), when
// its queued run starts, and when the run's result is read: from the registry, the record type
// and the stored query or number. Nothing about the plan needs storing beyond the check row.
import {
  businessNamesEqual,
  normalizeBusiness,
  normalizePerson,
  personNamesEqual,
  variantsFor,
  type NormalizedPerson,
} from "../core/names";
import type { RecordType, RegistryAdapter } from "../registries/types";

const MAX_QUERY_CHARS = 200;
const MAX_NUMBER_CHARS = 40;

/** Who a record type names. Companies and contractors are businesses, matched with the business
 *  rule (suffixes normalized); every other record type names a person. */
export type Subject = "person" | "business";

export function subjectOf(recordType: RecordType): Subject {
  return recordType === "company" || recordType === "contractor" ? "business" : "person";
}

/**
 * How a check starts: a number with a record page, or a name on a registry with a Fetch search, is
 * read with Fetch; anything else goes to the Agent. POST /api/checks and the site's prices both ask
 * this, so the price a screen shows is the path the check takes. (A Fetch read that cannot be used
 * may still fall back to one Agent run; the estimate stays the first method's.)
 */
export function firstMethod(adapter: Pick<RegistryAdapter, "fetchSearch">, by: "number" | "name", recordUrl: string | null): "agent" | "fetch" {
  if (by === "number" && recordUrl !== null) return "fetch";
  if (by === "name" && adapter.fetchSearch) return "fetch";
  return "agent";
}

export type SearchPlan =
  | { by: "number"; number: string; variants: string[] }
  | { by: "name"; subject: "person"; query: string; normalized: NormalizedPerson; display: string; variants: string[] }
  | { by: "name"; subject: "business"; query: string; normalized: string; display: string; variants: string[] };

/**
 * The search for a check: by number when one is given (the number skips the name search, spec 4.2),
 * else by name. A person's variants come from `variantsFor` in the registry's order; a business is
 * searched by the name as given. Returns `{ invalid }` (a sentence for `detail`) when there is nothing
 * to search: no query and no number, a name that normalizes to nothing, or a person's name with no
 * variant the registry can take (one word where the registry has no surname-only search). Who the
 * name is (person or business) follows the record type, unless the adapter decides it per check
 * (`subjectOf`: California DCA holds both, told apart by the profession and the name's suffix).
 */
export function planSearch(
  adapter: Pick<RegistryAdapter, "allowSurnameOnly" | "subjectOf">,
  recordType: RecordType,
  query: string | null | undefined,
  number: string | null | undefined,
  profession?: string | null,
): SearchPlan | { invalid: string } {
  const n = (number ?? "").trim();
  if (n !== "") {
    if (n.length > MAX_NUMBER_CHARS) return { invalid: `number is longer than ${MAX_NUMBER_CHARS} characters` };
    return { by: "number", number: n, variants: [] };
  }
  const q = (query ?? "").replace(/\s+/g, " ").trim();
  if (q === "") return { invalid: "query or number is required" };
  if (q.length > MAX_QUERY_CHARS) return { invalid: `query is longer than ${MAX_QUERY_CHARS} characters` };

  const subject = adapter.subjectOf?.(q, profession ?? undefined) ?? subjectOf(recordType);
  if (subject === "business") {
    const normalized = normalizeBusiness(q);
    if (normalized === "") return { invalid: "query has no name to search" };
    return { by: "name", subject: "business", query: q, normalized, display: normalized, variants: [q] };
  }
  const normalized = normalizePerson(q);
  const variants = variantsFor(normalized, adapter.allowSurnameOnly);
  if (variants.length === 0) {
    return {
      invalid:
        normalized.surname === ""
          ? "query has no name to search"
          : "this register cannot search a surname alone: give a first name and surname, or the registration number",
    };
  }
  return { by: "name", subject: "person", query: q, normalized, display: normalized.display, variants };
}

/** Whether a registry's name for a row passes the match rule against a name search's query. */
export function nameMatches(plan: Extract<SearchPlan, { by: "name" }>, name: string): boolean {
  return plan.subject === "person" ? personNamesEqual(plan.normalized, name) : businessNamesEqual(plan.normalized, name);
}

/** The Agent goal for a plan. */
export function goalFor(adapter: RegistryAdapter, plan: SearchPlan, profession: string | null): string {
  return adapter.goal({
    variants: plan.variants,
    ...(plan.by === "number" ? { number: plan.number } : {}),
    ...(profession ? { profession } : {}),
  });
}
