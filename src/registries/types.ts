import type { Env } from "../env";
import type { Flag, Status } from "../core/status";

export type Jurisdiction = "GB" | "US-CA" | "US-FL";
export type RecordType = "doctor" | "nurse" | "solicitor" | "company" | "contractor" | "professional";

/** One row of a registry's search results, as the registry prints it. */
export interface RegistryRow {
  /** The registered name exactly as the registry shows it. */
  name: string;
  number: string | null;
  /** The registry's own status text, unmapped. */
  status_raw: string | null;
  /** The distinguishing field the registry shows: location, specialty, register part. */
  detail: string | null;
  /** The record page, when the registry has one. */
  url: string | null;
}

/**
 * What an adapter reads off a record page. `full_name` and `status_raw` are nullable on
 * purpose: a registry page can fail to show them, and the caller must then say so
 * rather than guess. Dates are ISO `YYYY-MM-DD`.
 */
export interface ParsedRecord {
  full_name: string | null;
  licence_number: string | null;
  status_raw: string | null;
  registered_since?: string | null;
  expiry_date?: string | null;
  specialties?: string[];
  conditions?: { from: string; to: string | null; text: string }[];
  flags?: Flag[];
  raw_fields?: Record<string, unknown>;
}

/** The TinyFetch options an adapter needs for a page. */
export interface FetchOptions {
  include_selectors?: string[];
  links?: boolean;
}

/**
 * The entry an Agent run opened (the registrant's own entry on the register), as the run reported
 * it. `raw_fields` carries the registry's distinguishing fields shown on the entry (NMC register
 * part and location, SRA admission date and firm, CSLB classifications and city, DCA board and
 * licence type); only the fields the run reported are present.
 */
export interface AgentEntry {
  full_name: string | null;
  licence_number: string | null;
  status_raw: string | null;
  url: string | null;
  /** Any conditions, undertakings, suspension or warning text shown on the entry. */
  sanctions_text: string | null;
  raw_fields?: Record<string, unknown>;
}

/** One entry of a regulator's decision page (NMC hearings, SRA recent decisions). */
export interface DecisionEntry {
  /** The name as the page prints it. */
  name: string;
  /** The registration number the page prints with the name (NMC PIN, SRA ID). */
  number: string | null;
}

/** How a registry is looked up and watched (spec section 6, the coverage table). */
export interface Coverage {
  lookup: "agent" | "fetch" | "agent+fetch";
  watch: "page" | "topic" | "topic+decisions" | "none";
  notes: string;
}

/**
 * What one Agent run reported, in a form that does not depend on the registry. Each adapter
 * maps its own `output_schema` to this in `parseAgentResult`. Missing or malformed fields
 * are `null` / `[]`; reading an Agent result never throws.
 */
export interface AgentOutcome {
  /** A CAPTCHA or block page stopped the run. */
  blocked: boolean;
  blockMessage: string | null;
  /** The search variants the run reports it tried, in order. */
  variantsTried: string[];
  /** The registry's own total count of result rows, when the run says (not the rows listed). */
  resultsFound: number | null;
  /** The rows the run listed, as reported and uncapped. The GMC goal asks for every row whose name
   *  matches the searched name (even beyond 10) and then the others up to 10 in total, so there can
   *  be more than 10, and fewer than `resultsFound`: a caller must not match from the rows alone
   *  when `resultsFound` exceeds `rows.length` and nothing was opened. */
  rows: RegistryRow[];
  /** The entry the run opened, or null when it opened none. */
  opened: AgentEntry | null;
}

export interface RegistryAdapter {
  id: string;
  name: string;
  country: Jurisdiction;
  recordTypes: RecordType[];
  /** The page an Agent run starts on. */
  searchUrl: string;
  /** Whether the registry's search accepts a surname on its own (GMC does). */
  allowSurnameOnly: boolean;
  /** Always the standard browser: Standing does not get past robot checks or CAPTCHAs. */
  browserProfile: "lite";
  /** Regulator pages worth one shared Page monitor. */
  decisionPages: { label: string; url: string }[];
  /** Where the first of those pages is at `now`, for a regulator that starts a new page every month
   *  (the NMC). The shared monitor follows it (`rollSharedMonitors`). */
  decisionPageFor?(now: Date): { label: string; url: string };
  /** JSON Schema for the Agent run's `output_schema`. */
  outputSchema: object;
  /** The exact Agent goal text, with the variants to try in order. */
  goal(q: { variants: string[]; number?: string; profession?: string }): string;
  /** Map the registry's status text, plus what the record page showed, to the fixed set. */
  normalizeStatus(
    raw: string | null,
    hints: { hasConditions?: boolean; hasInterimOrder?: boolean },
  ): { status: Status; flags: Flag[] };
  /**
   * The status of a parsed record page, as of `todayIso` (`YYYY-MM-DD`). The one place the
   * hints (conditions, interim orders) are derived from what the page showed; the status text is
   * then mapped with the adapter's own status map. A record whose `status_raw` is null is `unknown`: the status is never
   * inferred from other parts of the page.
   */
  statusFromRecord(parsed: ParsedRecord, todayIso: string): { status: Status; flags: Flag[] };
  /**
   * The status of an entry an Agent run opened, when no record page could be read for it, as of
   * `todayIso`. The status comes from `status_raw` through the adapter's own map; the entry's
   * `sanctions_text` can only add what the register's own wording says is in force (conditions,
   * an interim order). A null `status_raw` is `unknown`: the status is never inferred from the
   * sanctions text.
   */
  statusFromAgentEntry(entry: AgentEntry, todayIso: string): { status: Status; flags: Flag[] };
  /** Read one Agent run's `result` (shaped by this adapter's `outputSchema`). Never throws. */
  parseAgentResult(result: unknown): AgentOutcome;
  /** How many rows a run lists beside the matching ones ("up to 10" in the goal; Companies House
   *  reads a 20-row page). A name match from a full list may have missed rows, so it is ambiguous. */
  agentRowsListed: number;
  /** The registry's row of the coverage table (GET /api/registries). */
  coverage: Coverage;
  /** The record page for a registration number, or null when the registry has no such URL. */
  recordUrl?(number: string, profession?: string): string | null;
  /** Read a record page fetched as markdown. `url` lets the adapter take the number from the
   *  record URL when the page does not show it. */
  parseRecordPage?(markdown: string, url?: string): ParsedRecord | null;
  /** TinyFetch options for reading a record page. The registry's test fixtures are recorded
   *  with these same options. */
  recordFetchOptions?: FetchOptions;
  /** Search results that are a GET page readable by Fetch (Companies House). `page` is 1-based; page 1
   *  when omitted. */
  fetchSearch?(env: Env, query: string, page?: number): Promise<RegistryRow[]>;
  /** How many rows a full search results page holds (Fetch-search registries), so a caller can tell
   *  when a later page may hold more. */
  searchPageRows?: number;
  /** The register's name search lists the nearest (or alphabetically next) names for any query, so a
   *  row is a candidate only when its name holds every significant word of the query (nameHasEveryWord);
   *  with none left the answer is no_match. Companies House and Florida Sunbiz. */
  searchNearest?: boolean;
  parseSearch?(markdown: string): RegistryRow[];
  /** TinyFetch options for reading a search page (Fetch-search registries). */
  searchFetchOptions?: FetchOptions;
  /** The GET URL of a search for `query` (Fetch-search registries), page 1 unless `page` is given.
   *  `searchUrl` stays the plain page a person searches on. */
  searchQueryUrl?(query: string, page?: number): string;
  /** The query for a Topic monitor on this person or company. */
  topicQuery?(fullName: string): string;
  /** Read one of `decisionPages` (fetched as markdown) into its named entries. Never throws. */
  parseDecisionPage?(markdown: string): DecisionEntry[];
  /** What a `no_match` result suggests trying next (stored in `checks.suggestions`). */
  noMatchSuggestions?: string[];
  /** Whether a check's name is a person or a business, when the register holds both (California
   *  DCA); otherwise the record type decides. */
  subjectOf?(query: string, profession?: string): "person" | "business";
  /** What a number lookup needs, said to a caller whose number has no record URL (DCA: which
   *  professions it can look up by number). */
  numberLookupHint?: string;
}
