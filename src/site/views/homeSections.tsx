// The home below its opening, in the comp's order: an ambiguous result Standing really stored, how a check
// works, the status changes Monitor caught, the registers, and the bounty's approval criteria with the
// live proof of each.
import type { RecordResult } from "../../core/schema";
import type { FeedChange } from "../../db/events";
import type { CheckRow } from "../../db/types";
import type { Stats } from "../../handlers/stats";
import { listAdapters } from "../../registries/index";
import type { RecordType } from "../../registries/types";
import { PostButton, StatusChip, StatusWord, verifyFields, type CardCheck } from "../components";
import { formatUtc, listingName, money, noChangeLine, plural } from "../format";
import type { MatchResult } from "../../core/schema";

/** How many candidates the home's ambiguity block shows (the full list is on the result page). */
const SHOWN = 4;

export function AmbiguityBlock(props: { check: CheckRow; record: RecordResult }) {
  const { check, record } = props;
  const q = check.query_raw ?? "";
  const total = record.candidates_total || record.candidates.length;
  return (
    <section class="band-full">
      <div class="split">
        <div class="unsure">
          <div class="eyebrow">When the name is not enough</div>
          <StatusWord outcome="ambiguous" class="tag" />
          <h2>Several matches? It shows them. It never picks one for you.</h2>
          <p class="sub">
            A search for “{q}” on {record.registry_name ?? "the register"} found {plural(total, "row")}. Standing gives no status until exactly one record
            matches the full name, or you choose one.
          </p>
        </div>
        <div class="cand-rows">
          {record.candidates.slice(0, SHOWN).map((c) => {
            const verify = verifyFields(record, c);
            const shows = [c.status_raw, c.detail].filter((x) => x !== null && x !== "").join(" · ");
            return (
              <div class="cand">
                <h3>
                  {c.full_name || "Name not shown"} {c.licence_number ? <span class="mono">{c.licence_number}</span> : null}
                </h3>
                {shows ? <p>{shows}</p> : null}
                <div class="act">
                  {verify ? (
                    <PostButton action="/check" fields={verify} class="pick">
                      Verify this one
                    </PostButton>
                  ) : null}
                </div>
              </div>
            );
          })}
          <p class="more">
            Showing {Math.min(SHOWN, record.candidates.length)} of {total}, read {check.checked_at ? formatUtc(check.checked_at) : ""}.{" "}
            <a href={`/checks/${check.id}`}>The whole result</a>. Repeat the check with a number to go straight to one record.
          </p>
        </div>
      </div>
    </section>
  );
}

export function HowItWorks() {
  const steps: { n: string; title: string; text: string; uses: string[] }[] = [
    {
      n: "1",
      title: "Search the official register",
      text: "By name or by number. Registers with no search address are searched the way a person would, in a real browser.",
      uses: ["TinyFish Agent", "Fetch"],
    },
    {
      n: "2",
      title: "One record, or an honest “not sure”",
      text: "The status is read from the record page and put into one fixed set of words. The register's own wording stays beside it, with a screenshot.",
      uses: ["TinyFish Fetch", "Browser"],
    },
    {
      n: "3",
      title: "Told when it changes",
      text: "A watched record is re-read whenever TinyFish Monitor reports a change. A new status becomes an event with before and after.",
      uses: ["TinyFish Monitor"],
    },
  ];
  return (
    <section class="home-section split">
      <div class="steps-title">
        <h2>How a check works</h2>
        <p class="sub">Every answer comes from the register's own page, read when you ask. A stored copy is never passed off as live.</p>
      </div>
      <ol class="steps" role="list">
        {steps.map((st) => (
          <li class="step">
            <div class="n" aria-hidden="true">
              {st.n}
            </div>
            <div>
              <h3>{st.title}</h3>
              <p>{st.text}</p>
              <div class="uses">
                with{" "}
                {st.uses.map((u, i) => (
                  <>
                    {i > 0 ? " and " : null}
                    <b>{u}</b>
                  </>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const VIA = { page: "Page monitor", topic: "Topic monitor" } as const;

function statusOf(json: string | null): string | null {
  try {
    const v = JSON.parse(json ?? "null") as { status?: unknown } | null;
    return v && typeof v.status === "string" ? v.status : null;
  } catch {
    return null;
  }
}

export function ChangesFeed(props: { changes: FeedChange[]; watched: number }) {
  return (
    <section class="home-section">
      <h2>Status changes caught</h2>
      <p class="sub">Watched records, newest change first. Each row opens the record with both readings of the register.</p>
      <div class="changes">
        {props.changes.length === 0 ? (
          <p class="change empty-row">{noChangeLine(props.watched)}</p>
        ) : (
          props.changes.map((e) => (
            <div class="change">
              <time datetime={e.at ?? undefined}>{e.at ? formatUtc(e.at) : ""}</time>
              <h3>
                <a href={`/records/${e.record_id}`}>{listingName(e)}</a>
              </h3>
              <div class="move">
                <StatusChip status={statusOf(e.before)} />
                <i aria-label="changed to">→</i>
                <StatusChip status={statusOf(e.after)} />
              </div>
              <div class="via">{e.watch_kind ? VIA[e.watch_kind] : "Monitor"}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

const TYPE_PLURAL: Record<RecordType, string> = {
  doctor: "doctors",
  nurse: "nurses",
  solicitor: "solicitors",
  company: "companies",
  contractor: "contractors",
  professional: "professionals",
};
/** A register's place and what it holds, as the index says it: "UK · doctors". */
const COUNTRY_SHORT: Record<string, string> = { GB: "UK", "US-CA": "US", "US-FL": "US" };

export function RegistersGrid() {
  const adapters = listAdapters();
  return (
    <section class="home-section">
      <h2>{plural(adapters.length, "register")} at launch</h2>
      <p class="sub">
        Any name on these registers, not a fixed list. Registers that cannot be read are listed too, with the reason: <a href="/coverage">Coverage</a>.
      </p>
      <div class="index">
        {adapters.map((a) => (
          <div class="reg">
            <h3>{a.name}</h3>
            <span>
              {COUNTRY_SHORT[a.country] ?? a.country} · {a.recordTypes.map((t) => TYPE_PLURAL[t]).join(", ")}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export interface ProofProps {
  stats: Stats;
  registers: number;
  countries: number;
  card: { record: MatchResult; check: CardCheck } | null;
  ambiguousId: string | null;
  noMatchId: string | null;
}

/** The bounty's approval criteria, one row each, with the live proof of each on this deploy. */
export function BountyProof(props: ProofProps) {
  const { stats, card } = props;
  const monitors = stats.monitors.active + stats.monitors.shared;
  const events = stats.events_by_kind.status_change + stats.events_by_kind.notice + stats.events_by_kind.recheck;
  return (
    <section class="home-section">
      <h2>Built for the TinyFish TinyVerify bounty</h2>
      <p class="sub">Each requirement, and where to see it working on this site now.</p>
      <table class="proof">
        <tbody>
          <tr class="req">
            <th scope="row">Live from the official source, with a link to prove it</th>
            <td>
              {card ? (
                <>
                  {listingName(card.record)} on {card.record.registry_name}, read {card.record.checked_at ? formatUtc(card.record.checked_at) : ""}:{" "}
                  <a href={`/records/${card.record.record_id}`}>the record with its screenshot</a>
                  {card.record.source_url ? (
                    <>
                      {" · "}
                      <a href={card.record.source_url} rel="noopener noreferrer">
                        the register's page ↗
                      </a>
                    </>
                  ) : null}
                  . The register's own words sit beside every status.
                </>
              ) : (
                "No record is stored yet: check one above."
              )}
            </td>
          </tr>
          <tr class="req">
            <th scope="row">No match or several matches, handled without guessing</th>
            <td>
              {props.ambiguousId ? <a href={`/checks/${props.ambiguousId}`}>A stored ambiguous result</a> : "No stored ambiguous result yet"}
              {" · "}
              {props.noMatchId ? <a href={`/checks/${props.noMatchId}`}>a stored no-match, with what was tried</a> : "no stored no-match yet"}
            </td>
          </tr>
          <tr class="req">
            <th scope="row">Different people, businesses and places, not a hardcoded few</th>
            <td>
              {props.registers} registers in {props.countries} countries, people and companies, any name on them; {plural(stats.checks, "check")} run.{" "}
              <a href="/coverage">Coverage</a>
            </td>
          </tr>
          <tr class="req">
            <th scope="row">Status changes flagged by Monitor</th>
            <td>
              {plural(monitors, "Monitor")} active ({stats.monitors.shared} on regulators' decision pages), {plural(events, "event")} recorded.{" "}
              <a href="/watchlist">Watchlist</a>
            </td>
          </tr>
          <tr class="req">
            <th scope="row">Structured output other tools can use</th>
            <td>
              One record shape for every register: <a href="/api/stats">/api/stats</a>, <a href="/api/registries">/api/registries</a>,{" "}
              <a href="/api/export.json">/api/export.json</a>, <a href="/api/events">/api/events</a>. <a href="/api">The API</a>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="costline">
        TinyFish spend so far {money(stats.spend_usd)} over {plural(stats.checks, "check")}
        {stats.cost_per_check > 0 ? `, ${money(stats.cost_per_check)} per fresh check` : ""}, from the ledger: one row per TinyFish call.
      </p>
    </section>
  );
}
