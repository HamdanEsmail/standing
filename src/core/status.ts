// The public status vocabulary. One fixed set for people and businesses; new cases
// map to the nearest value with `status_raw` kept. `applyStatusMap` turns a registry's own
// status text into it.

/** `active` registered and allowed to practise or trade; `conditions` active with
 *  conditions, undertakings or restrictions; `removed` struck off, erased, revoked,
 *  cancelled; `not_licensed` registered without a licence, retired, lapsed;
 *  `insolvency` liquidation, administration, receivership. */
export type Status =
  | "active"
  | "conditions"
  | "suspended"
  | "removed"
  | "not_licensed"
  | "expired"
  | "dissolved"
  | "insolvency"
  | "unknown";

/** Secondary facts that are not a status. */
export type Flag = "proposal_to_strike_off" | "interim_order" | "under_review" | "name_changed";

export type Outcome = "match" | "ambiguous" | "no_match" | "unsupported" | "error";

/** One row of a registry's status table: its raw text pattern, the status it means, and the
 *  secondary facts it carries. Patterns are matched against tidied text (see `applyStatusMap`)
 *  and should be anchored (`^...$`), case-insensitive, and never use the `g` or `y` flag. */
export type StatusMap = { pattern: RegExp; status: Status; flags?: Flag[] }[];

/** What the record page showed beyond the status line. */
export interface StatusHints {
  /** The page listed conditions, undertakings or restrictions: `active` becomes `conditions`. */
  hasConditions?: boolean;
  /** The page showed an interim order: adds the `interim_order` flag. */
  hasInterimOrder?: boolean;
}

// Every dash a registry or a copy-paste might use: hyphen, non-breaking hyphen, figure dash,
// en dash, em dash, horizontal bar, minus sign.
const DASHES = /[\u2010-\u2015\u2212]/g;

/** Trim, collapse whitespace (non-breaking spaces included) and fold every dash to "-". */
function tidy(raw: string): string {
  return raw.replace(DASHES, "-").replace(/\s+/g, " ").trim();
}

/**
 * Map a registry's raw status text to the fixed status set. The first matching pattern wins;
 * a null or unmatched `raw` is `unknown` (the caller keeps `status_raw`). `hasConditions`
 * upgrades `active`, and only `active`, to `conditions`. `hasInterimOrder` adds the
 * `interim_order` flag whatever the status, even when `raw` is null. Flags are deduplicated.
 */
export function applyStatusMap(
  map: StatusMap,
  raw: string | null,
  hints: StatusHints = {},
): { status: Status; flags: Flag[] } {
  let status: Status = "unknown";
  const flags: Flag[] = [];

  const text = raw === null ? "" : tidy(raw);
  if (text !== "") {
    for (const entry of map) {
      entry.pattern.lastIndex = 0; // a stray /g or /y regex must not remember the last call
      if (entry.pattern.test(text)) {
        status = entry.status;
        flags.push(...(entry.flags ?? []));
        break;
      }
    }
  }

  if (hints.hasConditions && status === "active") status = "conditions";
  if (hints.hasInterimOrder) flags.push("interim_order");
  return { status, flags: [...new Set(flags)] };
}
