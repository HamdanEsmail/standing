// The API page: each public endpoint with one curl example, the record every answer uses, and the
// outcomes as they really come back, taken from stored checks.
import type { RecordResult } from "../../core/schema";
import type { Stats } from "../../handlers/stats";
import { Layout } from "../layout";
import { PUBLIC_CHECKS_PER_IP_PER_DAY } from "../../core/limits";

export interface ApiSamples {
  match: RecordResult | null;
  ambiguous: RecordResult | null;
  no_match: RecordResult | null;
}

interface Endpoint {
  method: "GET" | "POST" | "DELETE";
  path: string;
  what: string;
  curl: (base: string) => string;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/api/checks",
    what: `Check a name or a number on one register. Answers 202 with the check id, whether it is done, and the estimated cost. ${PUBLIC_CHECKS_PER_IP_PER_DAY} a day per visitor; a repeat within 24 hours is served from the stored result.`,
    curl: (b) => `curl -X POST ${b}/api/checks -H 'content-type: application/json' -d '{"query":"Greggs PLC","record_type":"company","jurisdiction":"GB"}'`,
  },
  { method: "GET", path: "/api/checks/:id", what: "The result: the record below, or {status: \"pending\"} while the register is being read.", curl: (b) => `curl ${b}/api/checks/<check_id>` },
  { method: "GET", path: "/api/records/:id", what: "A stored record as it stands now, with its watch.", curl: (b) => `curl ${b}/api/records/<record_id>` },
  { method: "GET", path: "/api/records/:id/history", what: "Every event Monitor caught on a record, newest first.", curl: (b) => `curl ${b}/api/records/<record_id>/history` },
  {
    method: "POST",
    path: "/api/records/:id/watch",
    what: "Watch a record with a TinyFish Monitor (a public watch lasts 7 days). An optional https callback_url is sent each event.",
    curl: (b) => `curl -X POST ${b}/api/records/<record_id>/watch -H 'content-type: application/json' -d '{"callback_url":"https://example.org/hook"}'`,
  },
  { method: "DELETE", path: "/api/records/:id/watch", what: "Stop a public watch you started.", curl: (b) => `curl -X DELETE ${b}/api/records/<record_id>/watch` },
  { method: "GET", path: "/api/events", what: "Events on watched records, newest first: ?since=<ISO time>, ?limit=1..200, ?kind=status_change|notice|recheck.", curl: (b) => `curl '${b}/api/events?kind=status_change&limit=20'` },
  { method: "GET", path: "/api/export.json", what: "Every watched or curated record with its history.", curl: (b) => `curl ${b}/api/export.json` },
  { method: "GET", path: "/api/registries", what: "The coverage table as data, supported and not.", curl: (b) => `curl ${b}/api/registries` },
  { method: "GET", path: "/api/stats", what: "Counts and the TinyFish spend ledger by service.", curl: (b) => `curl ${b}/api/stats` },
  { method: "GET", path: "/evidence/:check_id.jpg", what: "The screenshot of the register page a check read.", curl: (b) => `curl -O ${b}/evidence/<check_id>.jpg` },
];

const FIELDS: [string, string][] = [
  ["outcome", "match, ambiguous, no_match, unsupported or error"],
  ["status", "Only on a match: active, conditions, suspended, removed, not_licensed, expired, dissolved, insolvency or unknown"],
  ["status_raw", "Only on a match: the register's own words"],
  ["flags", "proposal_to_strike_off, interim_order, under_review, name_changed"],
  ["registry, registry_name, country, record_type", "Which register answered, and for what"],
  ["full_name, licence_number", "As the register prints them"],
  ["registered_since, expiry_date", "ISO dates, when the register shows them"],
  ["disciplinary_actions, restrictions, specialties", "Lists, in the register's own wording"],
  ["raw_fields", "Everything else the register shows, keyed by field"],
  ["source_url", "The record page for a match, else the register's search page"],
  ["evidence_screenshot_url", "The page as it was read"],
  ["checked_at, cached, method", "When the register was read, whether this answer is a stored copy, and agent or fetch"],
  [
    "live_read_failed",
    "Only when a live read was tried and the register could not be read, so the answer is the last stored result (cached is true): { error, attempted_at }, the failed read's code and when it was tried",
  ],
  ["candidates, candidates_total, how_to_resolve", "Only on ambiguous: the rows to choose from, never a status"],
  ["variants_tried, suggestions", "What was searched, and what to try next"],
  ["record_id, check_id, watch, spend_usd", "Ids to follow up with, the watch, and what the check cost"],
];

/** A stored answer as JSON, with long candidate lists shortened to two. */
function sampleJson(r: RecordResult): { json: string; note: string | null } {
  if (r.candidates.length <= 2) return { json: JSON.stringify(r, null, 2), note: null };
  return {
    json: JSON.stringify({ ...r, candidates: r.candidates.slice(0, 2) }, null, 2),
    note: `candidates shortened here to 2 of the ${r.candidates.length} the answer carries.`,
  };
}

function Sample(props: { title: string; outcome: string; sample: RecordResult | null }) {
  if (props.sample === null) {
    return (
      <div class="sample">
        <h3>{props.title}</h3>
        <p class="empty">No stored {props.outcome.replace("_", " ")} yet.</p>
      </div>
    );
  }
  const { json, note } = sampleJson(props.sample);
  return (
    <div class="sample">
      <h3>{props.title}</h3>
      <pre>
        <code>{json}</code>
      </pre>
      {note ? <p class="note">{note}</p> : null}
    </div>
  );
}

export function ApiPage(props: { stats: Stats; paused: boolean; baseUrl: string; samples: ApiSamples }) {
  const base = props.baseUrl.replace(/\/+$/, "");
  return (
    <Layout
      title="API · Standing"
      description="Standing's JSON API: check a register, read stored records, follow watched records."
      active="api"
      stats={props.stats}
      paused={props.paused}
    >
      <section class="page-head">
        <h1>API</h1>
        <p class="sub">
          JSON over HTTPS, no key needed. Every answer is one record shape. A status is given only when exactly one record matches; anything else
          says why not.
        </p>
      </section>
      <section class="band-tight">
        <h2>Endpoints</h2>
        <ul class="endpoints">
          {ENDPOINTS.map((e) => (
            <li>
              <p class="ep">
                <span class="method">{e.method}</span> <code>{e.path}</code>
              </p>
              <p class="what">{e.what}</p>
              <pre>
                <code>{e.curl(base)}</code>
              </pre>
            </li>
          ))}
        </ul>
      </section>
      <section class="band-tight">
        <h2>The record</h2>
        <table class="table schema">
          <tbody>
            {FIELDS.map(([k, v]) => (
              <tr>
                <th scope="row">
                  <code>{k}</code>
                </th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section class="band-tight">
        <h2>The outcomes, as stored</h2>
        <p class="sub">Real answers from Standing's own checks, read from the database when this page was built.</p>
        <div class="samples">
          <Sample title="A match" outcome="match" sample={props.samples.match} />
          <Sample title="Several matches" outcome="ambiguous" sample={props.samples.ambiguous} />
          <Sample title="No match" outcome="no_match" sample={props.samples.no_match} />
        </div>
      </section>
    </Layout>
  );
}
