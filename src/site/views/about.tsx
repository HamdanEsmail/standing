// About: how a check works, the match rule, the status words, what is watched and kept, the limits,
// and what each TinyFish service does here with its spend from the ledger.
import {
  AGENT_MAX_DURATION_SECONDS,
  AGENT_MAX_STEPS,
  CACHE_HOURS,
  PUBLIC_AGENT_CHECKS_PER_DAY,
  PUBLIC_CHECKS_PER_IP_PER_DAY,
  PUBLIC_RECORD_TTL_HOURS,
  PUBLIC_WATCH_SLOTS,
  PUBLIC_WATCH_TTL_DAYS,
  PUBLIC_WATCHES_PER_IP,
  SPEND_PAUSE_USD,
} from "../../core/limits";
import type { Stats } from "../../handlers/stats";
import type { Status } from "../../core/status";
import { chipClass } from "../components";
import { money, plural } from "../format";
import { Layout } from "../layout";

const STATUSES: [Status, string, string][] = [
  ["active", "Active", "On the register and allowed to practise or trade."],
  ["conditions", "Conditions", "Registered, with conditions, undertakings or restrictions in force."],
  ["suspended", "Suspended", "Registered, but not allowed to practise for now."],
  ["removed", "Removed", "Taken off the register: struck off, erased or revoked."],
  ["not_licensed", "Not licensed", "Not on the register, or registered without a licence to practise."],
  ["expired", "Expired", "The registration or licence has lapsed."],
  ["dissolved", "Dissolved", "A company that no longer exists."],
  ["insolvency", "Insolvency", "A company in liquidation, administration or receivership."],
  ["unknown", "Unknown", "The register's wording does not map safely to any of the above; its own words are shown."],
];

export function AboutPage(props: { stats: Stats; paused: boolean; repoUrl: string | null }) {
  const { stats } = props;
  const spend = stats.spend_by_kind as Record<string, number | undefined>;
  const calls = stats.tinyfish_calls;
  const services: { name: string; does: string; calls: number; spend: number }[] = [
    {
      name: "Agent",
      does: `Searches the registers that need a real browser (GMC, NMC, SRA, and California DCA by name), at most ${AGENT_MAX_STEPS} steps and ${AGENT_MAX_DURATION_SECONDS} seconds a run, one run at a time.`,
      calls: calls.agent,
      spend: spend.agent_step ?? 0,
    },
    {
      name: "Fetch",
      does: "Reads record pages and search pages as text: Companies House, Florida, and GMC and DCA record pages by number.",
      calls: calls.fetch,
      spend: spend.fetch ?? 0,
    },
    {
      name: "Browser",
      does: "Takes the full-page screenshot kept as evidence for every Fetch read.",
      calls: calls.browser,
      spend: spend.screenshot ?? 0,
    },
    {
      name: "Monitor",
      does: "Re-reads each watched record page twice a day (Page) or searches for new public notices (Topic). It is the only thing that triggers a re-check.",
      calls: calls.monitor,
      spend: spend.monitor_check ?? 0,
    },
    {
      name: "Search",
      does: "Found the public notices behind the curated watches, from a script run outside the Worker, so its calls are not in this ledger.",
      calls: calls.search,
      spend: spend.search ?? 0,
    },
  ];
  return (
    <Layout
      title="About · Standing"
      description="How Standing checks an official register, the rules it never breaks, its limits, and how it uses TinyFish."
      active="about"
      stats={stats}
      paused={props.paused}
    >
      <section class="page-head prose">
        <h1>About Standing</h1>
        <p class="sub">
          Standing answers one question: what does the official register say about this person or business, right now? It reads the register's own
          page, gives one status from a fixed set, keeps the register's wording and a screenshot beside it, and never guesses.
        </p>
        {props.repoUrl ? (
          <p class="sub">
            <a href={props.repoUrl} rel="noopener noreferrer">
              Source code ↗
            </a>
          </p>
        ) : null}
      </section>

      <section class="band-tight prose">
        <h2>How a check works</h2>
        <ol class="steps-list">
          <li>
            <b>Find.</b> The register is searched by name or by number. Registers with a search address are read with Fetch; the rest are searched
            the way a person would, by the TinyFish Agent in a real browser.
          </li>
          <li>
            <b>Match.</b> A name matches only when it is the same name: the same given name and surname, any middle names in the same order, no
            initials stretched into names. One row that fails this, or two that pass it, is "ambiguous", with the rows to choose from. A number
            goes straight to its record.
          </li>
          <li>
            <b>Read.</b> The status comes from the record page itself, never from a line in the search results, and is put into the fixed set
            below. The register's own words stay beside it, with a screenshot of the page.
          </li>
          <li>
            <b>Watch.</b> A watched record is re-read when TinyFish Monitor reports a change. A new status becomes an event with before and after.
          </li>
        </ol>
      </section>

      <section class="band-tight prose">
        <h2>The status words</h2>
        <p class="sub">Each word has its colour, and the word is always there too: green for good standing, amber for a caution, red for a stop, slate when Standing is not sure.</p>
        <ul class="status-tiles" role="list">
          {STATUSES.map(([k, w, m]) => (
            <li class={chipClass(k)}>
              <b>{w}</b>
              <span>{m}</span>
            </li>
          ))}
        </ul>
        <p class="note">
          A status is given only for one matching record. "Ambiguous", "no match", "not supported" and "check failed" are not statuses and are
          never coloured as one. A register that shows a robot check is reported as blocked: Standing does not get around it.
        </p>
      </section>

      <section class="band-tight prose">
        <h2>What is kept, and the limits</h2>
        <ul class="facts">
          <li>A public lookup nobody watches is deleted after {PUBLIC_RECORD_TTL_HOURS} hours, with its screenshot.</li>
          <li>The same check within {CACHE_HOURS} hours is served from the stored result, marked "stored result" with its real read time.</li>
          <li>
            When a register cannot be read and Standing holds an earlier result for the same question, it shows that result, marked
            "stored result" with its real read time and a line saying the live read just failed.
          </li>
          <li>
            {PUBLIC_CHECKS_PER_IP_PER_DAY} checks a day per visitor; across all visitors, {PUBLIC_AGENT_CHECKS_PER_DAY} checks a day that need a real
            browser.
          </li>
          <li>
            {PUBLIC_WATCH_SLOTS} public watch slots, {PUBLIC_WATCHES_PER_IP} watches a day per visitor, each kept {PUBLIC_WATCH_TTL_DAYS} days; the
            history stays after that.
          </li>
          <li>When the TinyFish spend reaches ${SPEND_PAUSE_USD}, every live check pauses. Stored results and watched records stay readable.</li>
        </ul>
      </section>

      <section class="band-tight prose">
        <h2>How TinyFish is used</h2>
        <p class="sub">
          Spend so far {money(stats.spend_usd)} over {plural(stats.checks, "check")}, from Standing's own ledger: one row per TinyFish call.
        </p>
        <table class="table services">
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">What it does here</th>
              <th scope="col" class="num">
                Calls
              </th>
              <th scope="col" class="num">
                Spend
              </th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr>
                <th scope="row">{s.name}</th>
                <td>{s.does}</td>
                <td class="num">{s.calls}</td>
                <td class="num">{money(s.spend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Layout>
  );
}
