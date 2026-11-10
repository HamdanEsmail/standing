// Turns the rows a registry search returned into an outcome (spec 4.5).
import type { RegistryRow } from "../registries/types";
import { CANDIDATES_MAX } from "./limits";
import { businessNamesEqual, personNamesEqual, type NormalizedPerson } from "./names";

export type Classified =
  | { outcome: "match"; row: RegistryRow }
  | { outcome: "ambiguous"; candidates: RegistryRow[]; total: number }
  | { outcome: "no_match" };

/**
 * Zero rows: no_match. Otherwise a row is a match only when its name passes the match rule
 * against the query (personNamesEqual / businessNamesEqual), and only when exactly one row does.
 * That holds for a single returned row too, whichever search variant produced it: the registry
 * narrowing a search to one row is not evidence that it is the person.
 * So "Christopher Wickfold" with the single row "Christine WICKFOLD" is ambiguous with that one
 * candidate and `total: 1`. A blank or unparseable query equals nothing and never matches.
 *
 * Anything else is ambiguous, and every row is a candidate: the rows whose name equals the
 * query's first (in registry order), then the rest (in registry order), capped at
 * CANDIDATES_MAX; `total` keeps the full count. Two rows with the same normalized name are
 * ambiguous even if one looks more likely: the result never carries a status, so a licence on
 * one row cannot decide anything.
 */
export function classifyRows(
  rows: RegistryRow[],
  query: { kind: "person" | "business"; normalized: string | NormalizedPerson },
): Classified {
  if (rows.length === 0) return { outcome: "no_match" };

  const q = query.normalized;
  const equals: (name: string) => boolean =
    query.kind === "person"
      ? (name) => personNamesEqual(q, name)
      : (name) => businessNamesEqual(typeof q === "string" ? q : q.display, name);

  const isExact = rows.map((row) => equals(row.name));
  const exact = rows.filter((_, i) => isExact[i]);
  if (exact.length === 1) return { outcome: "match", row: exact[0]! };

  // The rows that caused the ambiguity go first, so the cap can never cut them off: a
  // Companies House page has 20 rows and two equal names may sit at positions 11 and 12.
  const others = rows.filter((_, i) => !isExact[i]);
  return { outcome: "ambiguous", candidates: [...exact, ...others].slice(0, CANDIDATES_MAX), total: rows.length };
}
