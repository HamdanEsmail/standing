// The check flow's screens: the result for every outcome, the pending page that refreshes itself, a
// refusal (not supported), and the verification receipt for a match.
import type { Child } from "hono/jsx";
import type { PendingView } from "../../checks/view";
import { estimateUsd } from "../../core/limits";
import type { MatchResult, RecordResult } from "../../core/schema";
import type { Outcome, Status } from "../../core/status";
import type { CheckRow } from "../../db/types";
import type { Stats } from "../../handlers/stats";
import { SUPPORTED, UNSUPPORTED, getAdapterById } from "../../registries/index";
import { REGISTRY_META, type RegistryId } from "../../registries/meta";
import type { RecordType } from "../../registries/types";
import { EvidenceLine, EvidencePanel, FieldSheet, freshCheck, Marks, PostButton, StatusWord, toneOf, verifyFields, WATCH_KIND, type CardCheck } from "../components";
import {
  AGENT_CAP_LINE,
  ambiguousLine,
  blockedLine,
  failedLine,
  formatUtc,
  listingName,
  money,
  noMatchLine,
  readFailedLine,
  OUTCOME_WORD,
  PLACE_TEXT,
  RECORD_TYPE_TEXT,
  receiptLine,
  runningLine,
  STATUS_WORD,
  STILL_WAITING,
  waitClock,
  WAITING_FOR_SLOT,
} from "../format";
import { Layout } from "../layout";

/** A pending page reloads itself this often, up to MAX_WAITS times (3 minutes), then stops and says so. */
export const REFRESH_SECONDS = 3;
export const MAX_WAITS = 60;

const registryName = (r: { registry: string | null; registry_name?: string | null }): string =>
  r.registry_name ?? (r.registry !== null && Object.hasOwn(REGISTRY_META, r.registry) ? REGISTRY_META[r.registry as RegistryId].name : "the register");

/** The query as the visitor typed it, else the number. */
const asked = (check: CheckRow): string => check.query_raw?.trim() || check.number || "";

/** The slab's top line: register and place on the left, the read time and whether it is live on the right. */
function Where(props: { registry: string; country: string | null; at?: string | null; live?: boolean | null }) {
  return (
    <div class="where">
      <span>
        <b>{props.registry}</b>
        {props.country ? ` · ${PLACE_TEXT[props.country] ?? props.country}` : ""}
      </span>
      {props.at ? (
        <span>
          Read {formatUtc(props.at)}
          {props.live === null || props.live === undefined ? "" : props.live ? " · live" : " · stored result"}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The verdict slab: the answer in its status colour with one very large word. `chars` is the word's
 * length, so the size steps down for a long word instead of breaking it (see site.css).
 */
function Slab(props: { tone: "go" | "wait" | "stop" | "hold"; chars: number; where: Child; word: Child; children?: Child; foot?: Child }) {
  return (
    <div class={`verdict tone-${props.tone}`} style={`--chars: ${props.chars}`}>
      {props.where}
      {props.word}
      {props.children}
      {props.foot ? <div class="acts">{props.foot}</div> : null}
    </div>
  );
}

const wordLength = (outcome: Outcome, status?: Status | null): number =>
  (outcome === "match" ? STATUS_WORD[status ?? "unknown"] : OUTCOME_WORD[outcome]).length;

const WORDS_PLURAL: Record<RecordType, string> = {
  doctor: "doctors",
  nurse: "nurses or midwives",
  solicitor: "solicitors",
  company: "companies",
  contractor: "contractors",
  professional: "licensed professionals",
};

/**
 * Why a (record type, place) pair is not supported: the coverage table's reason where a register was
 * tried and found unreadable (California contractors), otherwise a plain sentence naming what Standing
 * does read in that place.
 */
export function unsupportedReason(recordType: string, place: string): string {
  if (recordType === "contractor" && place === "US-CA") {
    const cslb = UNSUPPORTED.find((u) => u.registry === "CA Contractors State License Board");
    if (cslb) return `CA Contractors State License Board: ${cslb.reason}.`;
  }
  const types = Object.hasOwn(WORDS_PLURAL, recordType) ? WORDS_PLURAL[recordType as RecordType] : "that record type";
  const where = PLACE_TEXT[place] ?? place;
  const here = SUPPORTED.filter((s) => s.jurisdiction === place);
  const instead =
    here.length === 0
      ? ""
      : ` In ${where} it reads: ${here.map((s) => `${getAdapterById(s.registry)?.name ?? s.registry} (${WORDS_PLURAL[s.record_type]})`).join(", ")}.`;
  return `Standing reads no register for ${types} in ${where}.${instead}`;
}

// --- Result screens --------------------------------------------------------------------------

/** The line a stored answer carries when it stands in for a live read that failed; nothing otherwise. */
function ReadFailed(props: { record: RecordResult }) {
  const failed = props.record.live_read_failed;
  return failed ? <p class="read-failed">{readFailedLine(registryName(props.record), failed.attempted_at)}</p> : null;
}

function MatchView(props: { check: CheckRow; record: MatchResult }) {
  const { check, record } = props;
  const card: CardCheck = { live: check.cached_from_check_id === null, matchedBy: check.number !== null ? "number" : "name" };
  const fresh = freshCheck(record);
  return (
    <section class="result">
      <Slab
        tone={toneOf(record.status)}
        chars={wordLength("match", record.status)}
        where={<Where registry={registryName(record)} country={record.country} at={record.checked_at} live={card.live} />}
        word={<StatusWord outcome="match" status={record.status} />}
        foot={
          <>
            <span class="links">
              <a class="linkish" href={`/checks/${check.id}/receipt`}>
                Receipt (print or save as PDF)
              </a>
              {fresh ? (
                <PostButton action="/check" fields={fresh.fields} class="linkish">
                  Fresh check ({money(estimateUsd(fresh.method))})
                </PostButton>
              ) : null}
              <a class="linkish" href={`/api/checks/${check.id}`}>
                JSON
              </a>
            </span>
            <span class="watch">
              {record.watch ? (
                `Watching · ${WATCH_KIND[record.watch.kind]}`
              ) : record.record_id ? (
                <PostButton action={`/records/${record.record_id}/watch`} fields={{}} class="btn secondary">
                  Watch this record
                </PostButton>
              ) : null}
            </span>
          </>
        }
      >
        <ReadFailed record={record} />
        {record.status_raw ? <p class="status-raw">The register says: “{record.status_raw}”</p> : null}
        <h1 class="who">
          {record.full_name ?? "Name not shown"} {record.licence_number ? <span class="mono">{record.licence_number}</span> : null}
        </h1>
        <Marks record={record} check={card} />
      </Slab>
      <div class="result-grid">
        <div class="sheet-col">
          <FieldSheet record={record} />
        </div>
        <EvidencePanel record={record} check={card} />
      </div>
    </section>
  );
}

/** The slab of an answer that is not a match: slate, its word, the query as typed and one line. */
function HoldSlab(props: { outcome: Exclude<Outcome, "match">; record: RecordResult; check: CheckRow; line: string }) {
  const { record, check } = props;
  const q = asked(check);
  return (
    <Slab
      tone="hold"
      chars={wordLength(props.outcome)}
      where={<Where registry={registryName(record)} country={record.country} at={record.checked_at} live={record.checked_at ? check.cached_from_check_id === null : null} />}
      word={<StatusWord outcome={props.outcome} />}
    >
      {q ? <h1 class="who">“{q}”</h1> : null}
      <p class="result-line">{props.line}</p>
      <ReadFailed record={record} />
    </Slab>
  );
}

function AmbiguousView(props: { check: CheckRow; record: RecordResult }) {
  const { check, record } = props;
  const total = record.candidates_total || record.candidates.length;
  return (
    <section class="result">
      <HoldSlab outcome="ambiguous" record={record} check={check} line={ambiguousLine(total, asked(check))} />
      <div class="below">
        <ul class="cand-list" role="list">
          {record.candidates.map((c) => {
            const verify = verifyFields(record, c);
            const shows = [c.status_raw, c.detail].filter((x) => x !== null && x !== "").join(" · ");
            return (
              <li class="cand">
                <h3>
                  {c.full_name || "Name not shown"} {c.licence_number ? <span class="mono">{c.licence_number}</span> : null}
                </h3>
                {shows ? <p>{shows}</p> : null}
                <div class="act">
                  {verify ? (
                    <PostButton action="/check" fields={verify} class="pick">
                      Verify this one
                    </PostButton>
                  ) : c.source_url ? (
                    <a class="linkish" href={c.source_url} rel="noopener noreferrer">
                      On the register ↗
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <p class="result-note">
          {record.candidates.length < total ? `Showing ${record.candidates.length} of ${total}. ` : ""}
          Repeat the check with a registration number to go straight to one record.
        </p>
        <EvidenceLine record={record} check={{ live: check.cached_from_check_id === null }} />
      </div>
    </section>
  );
}

function NoMatchView(props: { check: CheckRow; record: RecordResult }) {
  const { check, record } = props;
  const q = asked(check);
  const tried = record.variants_tried.length > 0 ? record.variants_tried : q ? [q] : [];
  return (
    <section class="result">
      <HoldSlab outcome="no_match" record={record} check={check} line={noMatchLine(registryName(record), q, tried)} />
      <div class="below">
        {record.suggestions.length > 0 ? (
          <>
            <h2 class="below-title">What to try</h2>
            <ul class="suggestions">
              {record.suggestions.map((s) => (
                <li>{s}</li>
              ))}
            </ul>
          </>
        ) : null}
        <p class="result-note">
          <a href="/">Check again</a>
        </p>
        <EvidenceLine record={record} check={{ live: check.cached_from_check_id === null }} />
      </div>
    </section>
  );
}

function ErrorView(props: { check: CheckRow; record: RecordResult & { error: string } }) {
  const { record } = props;
  const name = registryName(record);
  const line = record.error.startsWith("blocked") ? blockedLine(name) : record.error === "daily_agent_checks_used" ? AGENT_CAP_LINE : failedLine(name);
  return (
    <section class="result">
      <HoldSlab outcome="error" record={record} check={props.check} line={line} />
      <div class="below">
        <p class="result-note">
          <span class="mono">Error code: {record.error.split(":")[0]}</span> · <a href="/">Check again</a>
          {record.source_url ? (
            <>
              {" "}
              ·{" "}
              <a href={record.source_url} rel="noopener noreferrer">
                Search the register yourself ↗
              </a>
            </>
          ) : null}
        </p>
      </div>
    </section>
  );
}

const WAIT_STEPS = ["Wait for a free browser", "Read the register", "Show its answer"] as const;

/**
 * What a visitor watches while a check runs: the three steps with the one it is on, a bar that keeps
 * moving, and a clock. The bar has no length to show (a register answers when it answers), so it only
 * says "working"; the clock and the usual time say how long.
 */
function Waiting(props: { queued: boolean; startedAt: string | null }) {
  const at = props.queued ? 0 : 1;
  const clock = waitClock(props.startedAt, new Date());
  return (
    <div class="waiting">
      <ol class="steps" aria-label="Progress">
        {WAIT_STEPS.map((step, i) => (
          <li class={i < at ? "done" : undefined} aria-current={i === at ? "step" : undefined}>
            {step}
          </li>
        ))}
      </ol>
      <div class="bar" role="progressbar" aria-label={props.queued ? "Waiting for a free browser" : "Reading the register"}></div>
      {clock !== null && props.startedAt !== null ? (
        <p class="wait-clock">
          <span class="clock" data-since={props.startedAt}>
            {clock}
          </span>{" "}
          so far. A real browser usually takes 1 to 2 minutes.
        </p>
      ) : null}
    </div>
  );
}

function PendingViewScreen(props: { check: CheckRow; pending: PendingView; wait: number }) {
  const { check, pending, wait } = props;
  const name = registryName(check);
  const stopped = wait >= MAX_WAITS;
  return (
    <section class="result pending" aria-live="polite">
      <Slab
        tone="hold"
        chars={8}
        where={<Where registry={name} country={check.jurisdiction} />}
        word={
          <div class="status-word">
            Checking{stopped ? null : <span class="pulse" aria-hidden="true"></span>}
          </div>
        }
      >
        <h1 class="who">“{asked(check)}”</h1>
        {stopped ? (
          <p class="result-line">
            {STILL_WAITING} <a href={`/checks/${check.id}`}>Look again</a>
          </p>
        ) : (
          <>
            <p class="result-line">{pending.queued ? WAITING_FOR_SLOT : runningLine(check.method)}</p>
            <Waiting queued={pending.queued} startedAt={check.started_at} />
          </>
        )}
      </Slab>
      <div class="below">
        <p class="result-note mono">
          {check.started_at ? <>Started {formatUtc(check.started_at)}</> : null}
          {check.method === "agent" ? " · Agent run in a real browser" : check.method === "fetch" ? " · Fetch" : null}
        </p>
      </div>
    </section>
  );
}

export type CheckScreen =
  | { kind: "result"; check: CheckRow; record: RecordResult }
  | { kind: "pending"; check: CheckRow; pending: PendingView; wait: number }
  | { kind: "unsupported"; recordType: string; place: string };

function titleOf(screen: CheckScreen): string {
  if (screen.kind === "unsupported") return "Not supported · Standing";
  if (screen.kind === "pending") return `Checking ${asked(screen.check)} · Standing`;
  const r = screen.record;
  if (r.outcome === "match") return `${listingName(r)}: ${r.status} · Standing`;
  return `${asked(screen.check)}: ${r.outcome.replace("_", " ")} · Standing`;
}

export function CheckPage(props: { screen: CheckScreen; stats: Stats; paused: boolean }) {
  const { screen } = props;
  let body: Child;
  let refresh: string | undefined;
  if (screen.kind === "unsupported") {
    body = (
      <section class="result">
        <Slab tone="hold" chars={13} where={<div class="where"><span><b>{PLACE_TEXT[screen.place] ?? screen.place}</b></span></div>} word={<StatusWord outcome="unsupported" />}>
          <h1 class="sr-only">Not supported</h1>
          <p class="result-line">{unsupportedReason(screen.recordType, screen.place)}</p>
        </Slab>
        <div class="below">
          <p class="result-note">
            <a href="/">Check another</a> · <a href="/coverage">Every register, supported and not</a>
          </p>
        </div>
      </section>
    );
  } else if (screen.kind === "pending") {
    body = <PendingViewScreen check={screen.check} pending={screen.pending} wait={screen.wait} />;
    if (screen.wait < MAX_WAITS) refresh = `${REFRESH_SECONDS}; url=/checks/${screen.check.id}?w=${screen.wait + 1}`;
  } else {
    const r = screen.record;
    body =
      r.outcome === "match" ? (
        <MatchView check={screen.check} record={r} />
      ) : r.outcome === "ambiguous" ? (
        <AmbiguousView check={screen.check} record={r} />
      ) : r.outcome === "no_match" ? (
        <NoMatchView check={screen.check} record={r} />
      ) : r.outcome === "error" ? (
        <ErrorView check={screen.check} record={r} />
      ) : (
        <NoMatchView check={screen.check} record={r} />
      );
  }
  return (
    <Layout title={titleOf(screen)} description="A check of an official register, read by Standing." active="check" stats={props.stats} paused={props.paused} refresh={refresh} noindex>
      {body}
    </Layout>
  );
}

// --- The receipt -------------------------------------------------------------------------------

/** The verification receipt: one printable white sheet for a match, with a strip in the status colour. */
export function Receipt(props: { check: CheckRow; record: MatchResult; baseUrl: string; stats: Stats }) {
  const { check, record } = props;
  const card: CardCheck = { live: check.cached_from_check_id === null, matchedBy: check.number !== null ? "number" : "name" };
  const name = registryName(record);
  const address = `${props.baseUrl.replace(/\/+$/, "")}/checks/${check.id}`;
  return (
    <Layout
      title={`Verification receipt: ${listingName(record)} · Standing`}
      description={`What ${name} said about this record when Standing read it.`}
      active={null}
      stats={props.stats}
      bodyClass="receipt-page"
      noindex
    >
      <p class="receipt-tools no-print">
        <a href={`/checks/${check.id}`}>Back to the result</a> · Print this page, or save it as a PDF, from your browser's print menu.
      </p>
      <article class={`receipt tone-${toneOf(record.status)}`} aria-label="Verification receipt">
        <header class="receipt-strip" style={`--chars: ${STATUS_WORD[record.status].length}`}>
          <StatusWord outcome="match" status={record.status} />
          <div class="receipt-title">
            <h1>Verification receipt</h1>
            <p class="mono">{record.checked_at ? formatUtc(record.checked_at) : ""}</p>
          </div>
        </header>
        <div class="receipt-body">
          <p class="receipt-where">
            <span class="wordmark">
              <i class="light" aria-hidden="true"></i>Standing
            </span>
            <span>
              {name}
              {record.country ? ` · ${PLACE_TEXT[record.country] ?? record.country}` : ""}
            </span>
          </p>
          <ReadFailed record={record} />
          {record.status_raw ? <p class="status-raw">The register says: “{record.status_raw}”</p> : null}
          <h2 class="who">
            {record.full_name ?? "Name not shown"} {record.licence_number ? <span class="mono">{record.licence_number}</span> : null}
          </h2>
          <Marks record={record} check={card} />
          <div class="receipt-grid">
            <FieldSheet record={record} />
            <EvidencePanel record={record} check={card} />
          </div>
          <div class="receipt-foot">
            <p class="receipt-line">{record.checked_at ? receiptLine(name, record.checked_at) : null}</p>
            <dl class="receipt-meta">
              <div>
                <dt class="label">Check</dt>
                <dd class="mono">{check.id}</dd>
              </div>
              <div>
                <dt class="label">Live result</dt>
                <dd class="mono">
                  <a href={`/checks/${check.id}`}>{address}</a>
                </dd>
              </div>
              <div>
                <dt class="label">Kept</dt>
                <dd>
                  {check.expires_at
                    ? `This receipt stays available until ${formatUtc(check.expires_at)}, when the check expires.`
                    : "This check is kept with its record and has no expiry date."}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </article>
    </Layout>
  );
}
