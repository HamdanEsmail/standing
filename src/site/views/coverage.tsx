// Coverage: every register Standing reads and every one it tried and could not, in one table.
import type { Coverage } from "../../handlers/registries";
import type { Stats } from "../../handlers/stats";
import { formatUtc, PLACE_TEXT, RECORD_TYPE_TEXT } from "../format";
import { Layout } from "../layout";
import type { RecordType } from "../../registries/types";

const LOOKUP: Record<string, string> = {
  agent: "Agent search in a real browser",
  fetch: "Fetch: the register's pages read as text",
  "agent+fetch": "Fetch by number; Agent search by name",
};
const WATCH: Record<string, string> = {
  page: "Page monitor on the record page",
  topic: "Topic monitor on the name",
  "topic+decisions": "Topic monitor on the name, and the register's decisions page",
  none: "Not watched",
};
/** The few unsupported reasons recorded as a TinyFetch error code, in words. */
const REASON: Record<string, string> = {
  target_unreachable: "the site could not be reached by automated reads",
  target_http_error: "the site answers automated reads with an error",
  empty_content: "the search page comes back empty to automated reads",
};

const MORE_PLACES: Record<string, string> = { "US-NY": "New York, US", AE: "Dubai, UAE", NZ: "New Zealand" };
const place = (country: string): string => PLACE_TEXT[country] ?? MORE_PLACES[country] ?? country;

/** One plain sentence per register for this page (GET /api/registries keeps the adapters' full notes). */
const PLAIN_NOTES: Record<string, string> = {
  gmc: "Doctors on the UK medical register. A number reads the doctor's own page; a name is searched in a real browser.",
  nmc: "Nurses, midwives and nursing associates. There is no page per person, so a watch looks for new public notices and reads the monthly hearings page. The search sometimes shows a robot check; Standing then answers blocked.",
  sra: "Solicitors in England and Wales. There is no page per person, so a watch looks for new public notices and reads the recent decisions page.",
  "companies-house": "Any UK company. When an exact name sits at the end of the first page of results, the second page is read too.",
  "ca-dca": "Licences across California's boards. A name search spans every board; a number needs its licence type.",
  "fl-sunbiz": "Florida companies, looked up by name. A former name is listed but never matched.",
};

type Registry = Coverage["registries"][number];

/** Why a register has no known record in the daily reader check. */
const NOT_IN_CHECK: Record<string, string> = {
  gmc: "Not in the reader check: its pages are doctors' own records, and Standing does not choose a person to read.",
  nmc: "Not in the reader check: it is read only by the Agent, which costs money for each read.",
  sra: "Not in the reader check: it is read only by the Agent, which costs money for each read.",
};

/** The panel's reader-check line, and whether the reader did not get its record. */
function readerLine(r: Registry): { text: string; off: boolean } | null {
  const c = r.reader_check;
  if (c === null) return NOT_IN_CHECK[r.id] === undefined ? null : { text: NOT_IN_CHECK[r.id]!, off: false };
  if (c.outcome === null || c.started_at === null) return { text: `Reader check: ${c.record}, not run yet.`, off: false };
  const when = formatUtc(c.started_at);
  switch (c.outcome) {
    case "understood":
      return { text: `Reader check: ${c.record} read and understood, ${when}.`, off: false };
    case "no_answer":
      return { text: `Reader check: ${c.record}: the register did not answer (${c.detail ?? "no answer"}), ${when}.`, off: true };
    case "not_understood":
      return { text: `Reader check: ${c.record} was read, but ${c.detail ?? "it was not understood"}, ${when}.`, off: true };
    case "started":
      return { text: `Reader check: ${c.record}, started ${when} and did not finish.`, off: true };
  }
}

export function CoveragePage(props: { stats: Stats; paused: boolean; coverage: Coverage }) {
  const { registries, unsupported } = props.coverage;
  return (
    <Layout
      title="Coverage · Standing"
      description="The official registers Standing reads, how each is looked up and watched, and the registers it cannot read, with the reason."
      active="coverage"
      stats={props.stats}
      paused={props.paused}
    >
      <section class="page-head">
        <h1>Coverage</h1>
        <p class="sub">
          {registries.length} registers are read live, any name on them, not a fixed list. The registers Standing tried and cannot read are listed too, with
          the reason. A register that shows a robot check is never got around: Standing says it was blocked.
        </p>
      </section>
      <ul class="reg-grid" role="list">
        {registries.map((r) => (
          <li class="reg-panel">
            <p class="place">
              {place(r.country)} · {r.record_types.map((t) => RECORD_TYPE_TEXT[t as RecordType] ?? t).join(", ")}
            </p>
            <h2>{r.name}</h2>
            <dl>
              <div>
                <dt>Looked up</dt>
                <dd>{LOOKUP[r.lookup] ?? r.lookup}</dd>
              </div>
              <div>
                <dt>Watched</dt>
                <dd>{WATCH[r.watch] ?? r.watch}</dd>
              </div>
            </dl>
            <p class="note">{PLAIN_NOTES[r.id] ?? r.notes}</p>
            {r.last_success_at ? <p class="last">Last answered {formatUtc(r.last_success_at)}</p> : null}
            {(() => {
              const line = readerLine(r);
              return line === null ? null : <p class={line.off ? "reader off" : "reader"}>{line.text}</p>;
            })()}
          </li>
        ))}
      </ul>

      <section class="band-tight">
        <h2>The reader check</h2>
        <p class="sub">
          Once a UTC day Standing reads one known business record on each register it reads with Fetch, and checks that its own reader still finds the
          record's number, its name and a status. A register can change its pages without notice; this is how Standing finds out before a lookup does. It
          is a check on Standing, not on anyone: it changes no record, raises no event and touches no watch, and it keeps nothing it reads. A watched record
          is checked again only when its TinyFish Monitor reports a change.
        </p>
      </section>

      <section class="band-tight">
        <h2>Tried, and cannot be read</h2>
        <p class="sub">Each was tried with the same tools. Standing does not get around a robot check, and it does not guess at a page it cannot read.</p>
        <ul class="cannot" role="list">
          {unsupported.map((u) => (
            <li>
              <h3>{u.registry}</h3>
              <span class="where">{place(u.country)}</span>
              <span class="chip neutral">Not supported</span>
              <p>{REASON[u.reason] ? `${REASON[u.reason]} (${u.reason})` : u.reason}</p>
            </li>
          ))}
        </ul>
      </section>
    </Layout>
  );
}
