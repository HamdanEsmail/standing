// The home's opening (the approved comp): kicker, headline, lede, the check form, three
// examples, the live line, and one real verified record beside them.
import type { MatchResult, RecordResult } from "../../core/schema";
import type { FeedChange } from "../../db/events";
import type { CheckRow } from "../../db/types";
import type { Stats } from "../../handlers/stats";
import { DCA_LICENCE_CODES } from "../../registries/ca-dca";
import { listAdapters, SUPPORTED } from "../../registries/index";
import { RecordCard, PostButton, type CardCheck } from "../components";
import { countryOf, FORM_NOTE, PLACE_TEXT, RECORD_TYPE_TEXT } from "../format";
import { Layout } from "../layout";
import { AmbiguityBlock, BountyProof, ChangesFeed, HowItWorks, RegistersGrid } from "./homeSections";

/** The three examples under the form. Each posts preset values to /check and opens a stored result while it is fresh. */
export const EXAMPLES: { text: string; fields: Record<string, string> }[] = [
  { text: "a doctor, by GMC number", fields: { number: "3545939", record_type: "doctor", place: "GB" } },
  { text: "Greggs PLC", fields: { q: "Greggs PLC", record_type: "company", place: "GB" } },
  { text: "a Florida company", fields: { q: "Publix Asset Management Company", record_type: "company", place: "US-FL" } },
];

/** Registers and countries, counted from the adapters: "US-CA" and "US-FL" are one country. */
export function coverageCounts(): { registers: number; countries: number } {
  const adapters = listAdapters();
  return { registers: adapters.length, countries: new Set(adapters.map((a) => countryOf(a.country))).size };
}

const unique = <T,>(items: T[]): T[] => [...new Set(items)];

/** What a refused form post shows: the values as sent, the field the error belongs to, a refusal line. */
export interface FormState {
  values: Record<string, string>;
  error?: { field: "q" | "number" | "profession"; text: string };
  notice?: string;
}

export interface HomeProps {
  stats: Stats;
  paused: boolean;
  form?: FormState;
  /** The newest curated or watched record with a match, or null on a fresh deploy. */
  card: { record: MatchResult; check: CardCheck } | null;
  /** A stored ambiguous result that does not expire, or null (the block is then left out). */
  ambiguous: { check: CheckRow; record: RecordResult } | null;
  /** A stored no-match that does not expire, or null. */
  noMatchId: string | null;
  /** The newest status changes on watched or curated records. */
  changes: FeedChange[];
  /** Records watched now. */
  watched: number;
}

function FieldError(props: { form?: FormState; field: "q" | "number" | "profession" }) {
  const e = props.form?.error;
  return e && e.field === props.field ? (
    <p class="field-error" id={`${props.field}-error`}>
      {e.text}
    </p>
  ) : null;
}

function CheckForm(props: { form?: FormState }) {
  const types = unique(SUPPORTED.map((s) => s.record_type));
  const places = unique(SUPPORTED.map((s) => s.jurisdiction));
  const v = props.form?.values ?? {};
  const err = (field: string) => (props.form?.error?.field === field ? { "aria-invalid": "true", "aria-describedby": `${field}-error` } : {});
  const recordType = v.record_type ?? "company";
  const place = v.place ?? "GB";
  return (
    <form class="form" method="post" action="/check">
      {props.form?.notice ? (
        <p class="form-notice" role="status">
          {props.form.notice}
        </p>
      ) : null}
      <label class="label" for="q">
        Name
      </label>
      <input class="input" id="q" name="q" type="text" placeholder="Greggs PLC" autocomplete="off" maxlength={200} value={v.q ?? ""} {...err("q")} />
      <FieldError form={props.form} field="q" />
      <div class="row">
        <div>
          <label class="label" for="record_type">
            Record type
          </label>
          <select class="input select" id="record_type" name="record_type">
            {types.map((t) => (
              <option value={t} selected={t === recordType}>
                {RECORD_TYPE_TEXT[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label class="label" for="place">
            Place
          </label>
          <select class="input select" id="place" name="place">
            {places.map((p) => (
              <option value={p} selected={p === place}>
                {PLACE_TEXT[p] ?? p}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div class="row">
        <div>
          <label class="label" for="number">
            Registration number <span class="optional">(optional)</span>
          </label>
          <input class="input" id="number" name="number" type="text" autocomplete="off" maxlength={40} value={v.number ?? ""} {...err("number")} />
          <FieldError form={props.form} field="number" />
        </div>
        <div>
          <label class="label" for="profession">
            Licence type <span class="optional">(California only)</span>
          </label>
          <select class="input select" id="profession" name="profession" aria-describedby="profession-hint" {...err("profession")}>
            <option value=""></option>
            {Object.keys(DCA_LICENCE_CODES).map((p) => (
              <option value={p} selected={p === v.profession}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
          <FieldError form={props.form} field="profession" />
        </div>
      </div>
      <p class="hint" id="profession-hint">
        A number skips the name search. A California licence number also needs its licence type.
      </p>
      <div class="go">
        <span class="note">{FORM_NOTE}</span>
        <button class="btn" type="submit">
          Check the register
        </button>
      </div>
    </form>
  );
}

export function Home(props: HomeProps) {
  const { stats, card } = props;
  const counts = coverageCounts();
  return (
    <Layout
      title="Standing: the register's own answer"
      description="Standing looks up a person or a business on the official register, live, and returns one verified record with the page it came from."
      active="check"
      stats={stats}
      paused={props.paused}
    >
      <div class={card ? "opening" : "opening single"}>
        <div class="say">
          <div class="eyebrow">Licence and registry checks</div>
          <h1 class="big">
            The register's <br />
            own answer, <br />
            <em>read a minute ago.</em>
          </h1>
          <p class="lede">
            Standing looks up a person or a business on the official register, live, and returns one verified record: status, number, dates and
            history, with the page it came from pinned beside it.
          </p>
          <CheckForm form={props.form} />
          <div class="examples">
            <span>Try one:</span>
            {EXAMPLES.map((e) => (
              <PostButton action="/check" fields={e.fields} class="linkbtn">
                {e.text}
              </PostButton>
            ))}
          </div>
        </div>
        {card ? <RecordCard record={card.record} check={card.check} overview /> : null}
        <div class="counts">
          <div>
            <b>{counts.registers}</b> <span>registers</span>
          </div>
          <div>
            <b>{counts.countries}</b> <span>countries</span>
          </div>
          <div>
            <b>{stats.checks}</b> <span>checks run</span>
          </div>
          <div>
            <b>{props.watched}</b> <span>records watched</span>
          </div>
        </div>
      </div>
      {props.ambiguous ? <AmbiguityBlock check={props.ambiguous.check} record={props.ambiguous.record} /> : null}
      <HowItWorks />
      <ChangesFeed changes={props.changes} watched={props.watched} />
      <RegistersGrid />
      <BountyProof
        stats={stats}
        registers={counts.registers}
        countries={counts.countries}
        card={card}
        ambiguousId={props.ambiguous?.check.id ?? null}
        noMatchId={props.noMatchId}
      />
    </Layout>
  );
}
