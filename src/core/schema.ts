// The public record: the one JSON shape every registry and every outcome answers with (spec
// 4.3), built from the stored check, record and candidate rows.
//
// The contract this file protects: an ambiguous result never carries a top-level `status` (nor
// `status_raw`, which is a status too), and neither does no_match, unsupported or error. Only a
// match has them, so the types below make the keys absent, not just undefined.
import type { CandidateRow, CheckRow, DisciplinaryAction, RecordFields, RecordRow } from "../db/types";
import { REGISTRY_META, type RegistryId } from "../registries/meta";
import type { Jurisdiction, RecordType } from "../registries/types";
import type { Flag, Outcome, Status } from "./status";

/** One row of an ambiguous result, as the registry shows it. */
export interface PublicCandidate {
  licence_number: string | null;
  full_name: string | null;
  status_raw: string | null;
  /** The distinguishing field the registry shows: location, specialty, register part. */
  detail: string | null;
  source_url: string | null;
}

export interface RecordWatch {
  watch_id: string;
  kind: "page" | "topic";
}

/** Keys every result has. `registry`, `registry_name` and `country` are null only for an
 *  `unsupported` (or old) row whose registry this build does not know. */
interface RecordResultBase {
  check_id: string;
  /** The stored record a match read (the id GET /api/records/:id and POST /api/records/:id/watch take); null otherwise. */
  record_id: string | null;
  registry: string | null;
  registry_name: string | null;
  country: Jurisdiction | null;
  record_type: RecordType | null;
  profession: string | null;
  flags: Flag[];
  full_name: string | null;
  licence_number: string | null;
  registered_since: string | null;
  expiry_date: string | null;
  disciplinary_actions: DisciplinaryAction[];
  restrictions: string[];
  specialties: string[];
  raw_fields: Record<string, unknown>;
  /** The record page for a match, otherwise the registry's search page; null only without a known registry. */
  source_url: string | null;
  evidence_screenshot_url: string | null;
  checked_at: string | null;
  cached: boolean;
  method: "agent" | "fetch" | null;
  /** Only an ambiguous result lists candidates. */
  candidates: PublicCandidate[];
  /** The registry's full row count for an ambiguous result (candidates are capped); 0 otherwise. */
  candidates_total: number;
  variants_tried: string[];
  suggestions: string[];
  watch: RecordWatch | null;
  spend_usd: number;
  /** Present only when a live read was tried and the register could not be read, so this is the last
   *  stored result (`cached` is true, `checked_at` its real read time): the failed read's code and when
   *  it was tried. */
  live_read_failed?: LiveReadFailed;
}

export interface LiveReadFailed {
  error: string;
  attempted_at: string;
}

/** The failed live read behind a stored answer: a finished, non-error copy that keeps an error code. */
export function liveReadFailed(check: Pick<CheckRow, "outcome" | "error" | "cached_from_check_id" | "started_at">): LiveReadFailed | null {
  if (check.outcome === null || check.outcome === "error" || check.error === null || check.cached_from_check_id === null || check.started_at === null) return null;
  return { error: check.error, attempted_at: check.started_at };
}

export type MatchResult = RecordResultBase & {
  outcome: "match";
  status: Status;
  status_raw: string | null;
  how_to_resolve?: never;
  error?: never;
};

export type AmbiguousResult = RecordResultBase & {
  outcome: "ambiguous";
  how_to_resolve: string;
  status?: never;
  status_raw?: never;
  error?: never;
};

export type ErrorResult = RecordResultBase & {
  outcome: "error";
  error: string;
  status?: never;
  status_raw?: never;
  how_to_resolve?: never;
};

export type EmptyResult = RecordResultBase & {
  outcome: "no_match" | "unsupported";
  status?: never;
  status_raw?: never;
  how_to_resolve?: never;
  error?: never;
};

export type RecordResult = MatchResult | AmbiguousResult | ErrorResult | EmptyResult;

const FLAGS: readonly string[] = ["proposal_to_strike_off", "interim_order", "under_review", "name_changed"];

/** Spec 4.5: the text of `how_to_resolve`. */
const HOW_TO_RESOLVE = "Repeat the check with number=<…>";

// Stored JSON is parsed defensively: bad, missing or wrong-shaped JSON gives the empty value.

function parseJson(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function jsonStrings(text: string | null | undefined): string[] {
  return strings(parseJson(text));
}

function jsonFlags(text: string | null | undefined): Flag[] {
  return jsonStrings(text).filter((f): f is Flag => FLAGS.includes(f));
}

function jsonDisciplinary(text: string | null | undefined): DisciplinaryAction[] {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return [];
  const actions: DisciplinaryAction[] = [];
  for (const entry of parsed) {
    if (isObject(entry) && typeof entry.summary === "string") {
      actions.push({ date: stringOrNull(entry.date), summary: entry.summary, source_url: stringOrNull(entry.source_url) });
    }
  }
  return actions;
}

function jsonFields(text: string | null | undefined): RecordFields {
  const parsed = parseJson(text);
  const f = isObject(parsed) ? parsed : {};
  return {
    registered_since: stringOrNull(f.registered_since),
    expiry_date: stringOrNull(f.expiry_date),
    specialties: strings(f.specialties),
    restrictions: strings(f.restrictions),
    raw: isObject(f.raw) ? f.raw : {},
  };
}

function metaFor(registry: string | null): (typeof REGISTRY_META)[RegistryId] | null {
  return registry !== null && Object.hasOwn(REGISTRY_META, registry) ? REGISTRY_META[registry as RegistryId] : null;
}

/** `evidence/<check id>.jpg` to an absolute URL; any other kind of key is not a screenshot. */
function evidenceUrl(baseUrl: string, key: string | null): string | null {
  if (key === null || !key.endsWith(".jpg")) return null;
  return `${baseUrl.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

/**
 * Build the public record for a finished check.
 *
 * Only a `match` carries `status` (the status the check found) and `status_raw`, and only a
 * match shows the record's fields and flags; the other outcomes show them empty. Only an
 * ambiguous result lists `candidates` (by position) and `how_to_resolve`; only an error has
 * `error`. Every result links its source: the record page for a match, otherwise the
 * registry's search page.
 */
export function toPublicRecord(
  check: CheckRow,
  record: RecordRow | null,
  candidates: CandidateRow[],
  baseUrl: string,
  watch: RecordWatch | null = null,
): RecordResult {
  // A check that is not finished has no outcome. Present it as an error rather than guess.
  const outcome: Outcome = check.outcome ?? "error";
  const meta = metaFor(check.registry);
  const rec = outcome === "match" ? record : null;
  const fields = jsonFields(rec?.fields);

  const shown: PublicCandidate[] =
    outcome === "ambiguous"
      ? [...candidates]
          .sort((a, b) => a.position - b.position)
          .map((c) => ({
            licence_number: c.licence_number,
            full_name: c.full_name,
            status_raw: c.status_raw,
            detail: c.detail,
            source_url: c.source_url,
          }))
      : [];

  const head = {
    check_id: check.id,
    record_id: outcome === "match" ? (rec?.id ?? check.record_id) : null,
    registry: check.registry,
    registry_name: meta?.name ?? null,
    country: meta?.country ?? check.jurisdiction,
    record_type: check.record_type ?? record?.record_type ?? null,
    profession: check.profession,
  };
  const tail = {
    flags: jsonFlags(rec?.flags),
    full_name: rec?.full_name ?? null,
    licence_number: rec?.licence_number ?? null,
    registered_since: fields.registered_since,
    expiry_date: fields.expiry_date,
    disciplinary_actions: jsonDisciplinary(rec?.disciplinary),
    restrictions: fields.restrictions,
    specialties: fields.specialties,
    raw_fields: fields.raw,
    source_url: rec?.source_url ?? meta?.searchUrl ?? null,
    evidence_screenshot_url: evidenceUrl(baseUrl, check.evidence_key),
    checked_at: check.checked_at,
    cached: check.cached_from_check_id !== null,
    method: check.method,
    candidates: shown,
    candidates_total: outcome === "ambiguous" ? (check.candidates_total ?? shown.length) : 0,
    variants_tried: jsonStrings(check.variants_tried),
    suggestions: jsonStrings(check.suggestions),
    watch,
    spend_usd: check.spend_usd ?? 0,
  };
  const failed = liveReadFailed(check);
  if (failed !== null) Object.assign(tail, { live_read_failed: failed });

  switch (outcome) {
    case "match":
      return { ...head, outcome, status: check.status ?? rec?.status ?? "unknown", status_raw: rec?.status_raw ?? null, ...tail };
    case "ambiguous":
      return { ...head, outcome, how_to_resolve: HOW_TO_RESOLVE, ...tail };
    case "error":
      return {
        ...head,
        outcome,
        error: check.error ?? (check.outcome === null ? "check not finished" : "unknown error"),
        ...tail,
      };
    case "no_match":
    case "unsupported":
      return { ...head, outcome, ...tail };
  }
}
