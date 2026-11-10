// The pieces every screen is built from: the status word, the evidence line, the field sheet and the
// record card. Everything read from a register is passed as text, so JSX escapes it; nothing from a
// register is ever emitted as markup.
import type { Child } from "hono/jsx";
import { estimateUsd } from "../core/limits";
import type { MatchResult, PublicCandidate, RecordResult } from "../core/schema";
import type { Outcome, Status } from "../core/status";
import { firstMethod } from "../checks/plan";
import { getAdapterById } from "../registries/index";
import type { RegistryAdapter } from "../registries/types";
import { FLAG_TEXT, formatDate, isPersonType, listingName, formatDay, formatUtc, money, OUTCOME_WORD, SCREENSHOT_MISSING, STATUS_WORD } from "./format";

/**
 * How the record on a card was read. `live` is true only when the answer was read from the register
 * for the check this screen shows; a cached copy, and any record shown on a screen that did not run a
 * check (the home), says "stored result" with its real read time.
 */
export interface CardCheck {
  live: boolean;
  matchedBy: "number" | "name";
}

/**
 * The first thing on a result. A status colour only on a match: every other outcome is a word set in
 * the neutral colour, and an ambiguous result never shows a status.
 */
export function StatusWord(props: { outcome: Outcome; status?: Status | null; class?: string }) {
  const extra = props.class ? ` ${props.class}` : "";
  if (props.outcome !== "match") return <div class={`status-word${extra}`}>{OUTCOME_WORD[props.outcome]}</div>;
  const status = props.status ?? "unknown";
  return <div class={`status-word ${status}${extra}`}>{STATUS_WORD[status]}</div>;
}

/** "Agent run" or "Fetch": how the register was read. */
const methodText = (method: "agent" | "fetch" | null): string | null => (method === "agent" ? "Agent run" : method === "fetch" ? "Fetch" : null);

/**
 * The last line of every record: `General Medical Council · read 5 Nov 2026, 09:22 UTC · Agent run ·
 * live · source ↗`.
 */
export function EvidenceLine(props: { record: RecordResult; check: Pick<CardCheck, "live"> }) {
  const { record } = props;
  const parts: Child[] = [record.registry_name ?? record.registry ?? "Register"];
  if (record.checked_at) parts.push(<>read <time datetime={record.checked_at}>{formatUtc(record.checked_at)}</time></>);
  const method = methodText(record.method);
  if (method) parts.push(method);
  parts.push(props.check.live ? "live" : "stored result");
  if (record.source_url) parts.push(<a href={record.source_url} rel="noopener noreferrer">source ↗</a>);
  return (
    <p class="evidence">
      {parts.map((p, i) => (
        <>
          {i > 0 ? " · " : null}
          <span>{p}</span>
        </>
      ))}
    </p>
  );
}

/** The screenshot's path on this site: evidence is linked by path, never by the absolute URL the JSON carries. */
export function evidencePath(url: string | null): string | null {
  if (url === null) return null;
  try {
    const path = new URL(url).pathname;
    return /^\/evidence\/[0-9a-f-]{36}\.jpg$/.test(path) ? path : null;
  } catch {
    return null;
  }
}

// --- The field sheet --------------------------------------------------------------------------

interface SheetRow {
  label: string;
  value: Child;
  mono?: boolean;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const day = (v: unknown): string | null => (text(v) === null ? null : formatDay(v as string));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Up to `shown` items, then "and n more". */
function some(items: string[], shown = 1): Child {
  if (items.length <= shown) return items.join(", ");
  return (
    <>
      {items.slice(0, shown).join(", ")}
      <br />
      <small>and {items.length - shown} more</small>
    </>
  );
}

/** A registry's own rows, in the order the register shows them. */
function registryRows(r: MatchResult): (SheetRow | null)[] {
  const raw = r.raw_fields;
  const row = (label: string, value: Child | null, mono = false): SheetRow | null => (value === null || value === "" ? null : { label, value, mono });
  switch (r.registry) {
    case "companies-house": {
      const sic = list(raw.sic_codes)
        .map((s) => (s && typeof s === "object" ? [text((s as Record<string, unknown>).code), text((s as Record<string, unknown>).description)].filter(Boolean).join(" ") : null))
        .filter((s): s is string => !!s);
      const previous = list(raw.previous_names)
        .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : null))
        .filter((p): p is Record<string, unknown> => p !== null && text(p.name) !== null);
      return [
        row("Company type", text(raw.company_type)),
        row("Incorporated on", day(r.registered_since), true),
        row("Dissolved on", day(raw.dissolved_on), true),
        row("Registered office", text(raw.address)),
        row("Nature of business", sic.length === 0 ? null : some(sic)),
        row(
          "Previous names",
          previous.length === 0
            ? null
            : previous.map((p, i) => (
                <>
                  {i > 0 ? <br /> : null}
                  {p.name as string}{" "}
                  {text(p.from) || text(p.to) ? (
                    <small>
                      {[text(p.from)?.slice(0, 4), text(p.to)?.slice(0, 4)].filter(Boolean).join(" to ")}
                    </small>
                  ) : null}
                </>
              )),
        ),
      ];
    }
    case "fl-sunbiz": {
      const report = raw.last_annual_report as { year?: unknown; filed?: unknown } | null | undefined;
      const year = report && typeof report.year === "number" ? report.year : null;
      return [
        row("Entity type", text(raw.entity_type)),
        row("Date filed", day(r.registered_since), true),
        row("State", text(raw.state), true),
        row("Principal address", text(raw.principal_address)),
        row("Last event", text(raw.last_event)),
        row("Last annual report", year === null ? null : `${year}${day(report?.filed) ? `, filed ${day(report?.filed)}` : ""}`),
      ];
    }
    case "gmc":
      return [
        row("Registered since", day(r.registered_since), true),
        row("Specialties", r.specialties.length === 0 ? null : r.specialties.join(", ")),
        row("GP Register", raw.gp_register === true ? `Yes${day(raw.gp_register_from) ? `, from ${day(raw.gp_register_from)}` : ""}` : raw.gp_register === false ? "No" : null),
      ];
    case "nmc":
      return [row("Register", text(raw.register_part)), row("Location", text(raw.location))];
    case "sra":
      return [row("Admitted", day(raw.admission_date), true), row("Firm", text(raw.firm))];
    case "ca-dca":
      return [
        row("Board", text(raw.board)),
        row("Licence type", text(raw.licence_type)),
        row("Issued", day(r.registered_since), true),
        row("Address", text(raw.address)),
      ];
    default:
      return [row("Registered since", day(r.registered_since), true)];
  }
}

/** Every row of a match's field sheet: the registry's own, then expiry, restrictions and history. */
export function sheetRows(r: MatchResult): SheetRow[] {
  const rows = registryRows(r);
  if (r.expiry_date) rows.push({ label: "Expires", value: formatDay(r.expiry_date), mono: true });
  if (r.registry !== "gmc" && r.specialties.length > 0) rows.push({ label: "Specialties", value: r.specialties.join(", ") });
  if (r.restrictions.length > 0) rows.push({ label: r.registry === "gmc" ? "Conditions" : "Restrictions", value: some(r.restrictions, 2) });
  if (r.disciplinary_actions.length > 0) {
    rows.push({
      label: "Disciplinary history",
      value: r.disciplinary_actions.map((a, i) => (
        <>
          {i > 0 ? <br /> : null}
          {a.date ? <small>{formatDay(a.date)} </small> : null}
          {a.summary}
          {a.source_url ? (
            <>
              {" "}
              <a href={a.source_url} rel="noopener noreferrer">
                source ↗
              </a>
            </>
          ) : null}
        </>
      )),
    });
  }
  return rows.filter((x): x is SheetRow => x !== null);
}

/** Why a match has no field sheet: an Agent match on a register with record pages whose page read after
 *  the run did not succeed, or a register that shows nothing more. */
function emptySheetLine(r: MatchResult): string {
  const adapter = r.registry === null ? null : getAdapterById(r.registry);
  if (r.method === "agent" && adapter?.recordUrl) {
    return "The register's record page could not be read again for the details. The status above comes from the search itself.";
  }
  return "The register shows no further fields for this record.";
}

export function FieldSheet(props: { record: MatchResult }) {
  const rows = sheetRows(props.record);
  if (rows.length === 0) return <p class="sheet-empty">{emptySheetLine(props.record)}</p>;
  return (
    <table class="sheet">
      {rows.map((r) => (
        <tr>
          <th scope="row">{r.label}</th>
          <td class={r.mono ? "mono" : undefined}>{r.value}</td>
        </tr>
      ))}
    </table>
  );
}

// --- The evidence panel and the card ------------------------------------------------------------

export function EvidencePanel(props: { record: MatchResult; check: CardCheck }) {
  const { record } = props;
  const shot = evidencePath(record.evidence_screenshot_url);
  const registry = record.registry_name ?? "the register";
  const when = record.checked_at ? formatUtc(record.checked_at) : "an unknown time";
  return (
    <div class="shot">
      {shot ? (
        <a class="frame" href={shot}>
          <img src={shot} alt={`The ${registry} page for ${record.full_name ?? "this record"}, read ${when}`} />
        </a>
      ) : (
        <div class="frame missing">
          <p>
            {SCREENSHOT_MISSING}{" "}
            {record.source_url ? (
              <a href={record.source_url} rel="noopener noreferrer">
                Register page
              </a>
            ) : null}
          </p>
        </div>
      )}
      <EvidenceLine record={record} check={props.check} />
    </div>
  );
}

/**
 * Whether a number check works on this registry, and the record page it would read: a registry with
 * record pages needs one for this number (California DCA also needs the licence type); a registry
 * without them searches the number with the Agent, except a Fetch-only one (Sunbiz), looked up by name.
 */
function numberLookup(adapter: RegistryAdapter, number: string, profession: string | null): { ok: boolean; recordUrl: string | null } {
  if (adapter.recordUrl) {
    const recordUrl = adapter.recordUrl(number, profession ?? undefined);
    return { ok: recordUrl !== null, recordUrl };
  }
  return { ok: adapter.coverage.lookup !== "fetch", recordUrl: null };
}

/**
 * What a fresh check of this record would send to /check, and the method it would take: by number
 * where the registry looks numbers up, else by the record's exact name. Null when neither is known.
 */
export function freshCheck(record: MatchResult): { fields: Record<string, string>; method: "agent" | "fetch" } | null {
  const adapter = record.registry === null ? null : getAdapterById(record.registry);
  if (adapter === null || record.country === null || record.record_type === null) return null;
  const number = record.licence_number;
  const lookup = number === null ? { ok: false, recordUrl: null } : numberLookup(adapter, number, record.profession);
  if (!lookup.ok && record.full_name === null) return null;
  const fields: Record<string, string> = { record_type: record.record_type, place: record.country, force: "1" };
  if (lookup.ok) fields.number = number!;
  else fields.q = record.full_name!;
  if (record.profession) fields.profession = record.profession;
  return { fields, method: firstMethod(adapter, lookup.ok ? "number" : "name", lookup.recordUrl) };
}

/**
 * The form a candidate's "Verify this one" posts: the candidate's number, where the registry looks
 * numbers up. Null where it cannot (Sunbiz is looked up by name; a DCA candidate's licence type is not
 * known): the candidate then links to its page on the register instead.
 */
export function verifyFields(result: RecordResult, candidate: PublicCandidate): Record<string, string> | null {
  const adapter = result.registry === null ? null : getAdapterById(result.registry);
  if (adapter === null || candidate.licence_number === null || result.country === null || result.record_type === null) return null;
  if (!numberLookup(adapter, candidate.licence_number, result.profession).ok) return null;
  const fields: Record<string, string> = { number: candidate.licence_number, record_type: result.record_type, place: result.country };
  if (result.profession) fields.profession = result.profession;
  return fields;
}

/** A small form that posts preset values: the examples and the fresh-check link. */
export function PostButton(props: { action: string; fields: Record<string, string>; class: string; children: Child }) {
  return (
    <form class="inline" method="post" action={props.action}>
      {Object.entries(props.fields).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
      <button type="submit" class={props.class}>
        {props.children}
      </button>
    </form>
  );
}

export const WATCH_KIND = { page: "Page monitor", topic: "Topic monitor" } as const;

/** The chip colour for a status: the status word's colour family. Only for a match's statuses. */
export function chipClass(status: string | null): "ok" | "warn" | "bad" | "neutral" {
  if (status === "active") return "ok";
  if (status === "conditions" || status === "expired" || status === "not_licensed") return "warn";
  if (status === "suspended" || status === "removed" || status === "dissolved" || status === "insolvency") return "bad";
  return "neutral";
}

/** A status as a small coloured chip (history rows, the watchlist). */
export function StatusChip(props: { status: string | null }) {
  const word = props.status !== null && Object.hasOwn(STATUS_WORD, props.status) ? STATUS_WORD[props.status as Status] : "Unknown";
  return <span class={`chip ${chipClass(props.status)}`}>{word}</span>;
}

/** The marks under a record's name: its flags as chips, then how it was matched, as plain text. */
export function Marks(props: { record: MatchResult; check: CardCheck }) {
  return (
    <div class="marks">
      {props.record.flags.map((f) => (
        <span class={`chip ${f === "interim_order" ? "bad" : "warn"}`}>{FLAG_TEXT[f]}</span>
      ))}
      <span class="matched">{props.check.matchedBy === "number" ? "Matched by number" : "Exact name match"}</span>
    </div>
  );
}

/** The slab colour of a status: go (active), wait (a caution), stop, or hold (not sure). */
export function toneOf(status: string | null): "go" | "wait" | "stop" | "hold" {
  const c = chipClass(status);
  return c === "ok" ? "go" : c === "warn" ? "wait" : c === "bad" ? "stop" : "hold";
}

/** A place as the slab's top line says it. */
const PLACE_SHORT: Record<string, string> = { GB: "UK", "US-CA": "California", "US-FL": "Florida" };

/**
 * One verified record as a verdict slab in its status colour: register and read time, the status word,
 * the register's own wording, name and number, then a white panel with three facts, the screenshot and
 * the proof line, and the actions in the foot. Only for a match.
 */
export function RecordCard(props: { record: MatchResult; check: CardCheck; compact?: boolean; overview?: boolean }) {
  const { record, check } = props;
  // On a page that lists records, a person is shown by record type and number, and the register's
  // screenshot (which prints the name) stays on the record's own page.
  const hidePerson = props.overview === true && isPersonType(record.record_type);
  const fresh = freshCheck(record);
  const registry = record.registry_name ?? record.registry ?? "Register";
  const shot = evidencePath(record.evidence_screenshot_url);
  const facts = sheetRows(record).slice(0, 3);
  return (
    <article class={`record tone-${toneOf(record.status)}${props.compact ? " compact" : ""}`} style={`--chars: ${STATUS_WORD[record.status].length}`} aria-label={`${registry} record`}>
      <div class="where">
        <span>
          <b>{registry}</b>
          {record.country ? ` · ${PLACE_SHORT[record.country] ?? record.country}` : ""}
        </span>
        <span>
          {record.checked_at ? <>Read {formatUtc(record.checked_at)} · </> : null}
          {check.live ? "live" : "stored result"}
        </span>
      </div>
      <StatusWord outcome="match" status={record.status} />
      {record.status_raw ? <div class="status-raw">The register says: “{record.status_raw}”</div> : null}
      <div class="who">
        {hidePerson ? (
          listingName(record)
        ) : (
          <>
            {record.full_name ?? "Name not shown"} {record.licence_number ? <span class="mono">{record.licence_number}</span> : null}
          </>
        )}
      </div>
      <Marks record={record} check={check} />
      <div class="facts">
        <dl>
          {facts.length === 0 ? (
            <dd>{props.overview ? "The register shows no further fields." : "The register shows no further fields for this record."}</dd>
          ) : (
            facts.map((f) => (
              <>
                <dt>{f.label}</dt>
                <dd class={f.mono ? "num" : undefined}>{f.value}</dd>
              </>
            ))
          )}
        </dl>
        {hidePerson ? (
          <p class="person-note">
            The register's page, with the name, is on <a href={`/records/${record.record_id}`}>the record's own page</a>.
          </p>
        ) : shot ? (
          <a class="frame" href={shot}>
            <img src={shot} alt={`The ${registry} page for ${record.full_name ?? "this record"}, read ${record.checked_at ? formatUtc(record.checked_at) : "at an unknown time"}`} />
          </a>
        ) : (
          <div class="frame missing">
            <p>
              {SCREENSHOT_MISSING}{" "}
              {record.source_url ? (
                <a href={record.source_url} rel="noopener noreferrer">
                  Register page
                </a>
              ) : null}
            </p>
          </div>
        )}
        <EvidenceLine record={record} check={check} />
      </div>
      {props.compact ? null : (
        <div class="acts">
          <span>
            {fresh ? (
              <PostButton action="/check" fields={fresh.fields} class="linkish">
                Fresh check ({money(estimateUsd(fresh.method))})
              </PostButton>
            ) : null}
            {fresh && record.record_id ? <span class="sep">·</span> : null}
            {record.record_id ? (
              <a class="linkish" href={`/api/records/${record.record_id}`}>
                JSON
              </a>
            ) : null}
          </span>
          <span>
            {record.watch ? (
              `Watching · ${WATCH_KIND[record.watch.kind]}`
            ) : record.record_id ? (
              <PostButton action={`/records/${record.record_id}/watch`} fields={{}} class="linkish">
                Watch this record
              </PostButton>
            ) : null}
          </span>
        </div>
      )}
    </article>
  );
}
