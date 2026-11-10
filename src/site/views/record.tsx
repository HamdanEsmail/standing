// The record page: the record as it stands, how it is watched, and everything Monitor caught on it,
// newest first, each row with the two read times it compares.
import { estimateUsd } from "../../core/limits";
import type { MatchResult } from "../../core/schema";
import type { EventRow, WatchRow } from "../../db/types";
import type { Stats } from "../../handlers/stats";
import { eventJson } from "../../monitoring/events";
import { freshCheck, PostButton, RecordCard, StatusChip, WATCH_KIND, type CardCheck } from "../components";
import { formatUtc, listingName, money, NOT_WATCHABLE_LINE, publicWatchLine, slotsFullLine } from "../format";
import { Layout } from "../layout";
import { PUBLIC_WATCH_SLOTS } from "../../core/limits";

export interface RecordPageProps {
  stats: Stats;
  paused: boolean;
  record: MatchResult;
  check: CardCheck;
  /** The record's active watch, or null. */
  watch: WatchRow | null;
  /** The record's latest public watch, active or expired: its expiry is shown. */
  publicWatch: WatchRow | null;
  /** How the record would be watched (null: it cannot be). */
  kind: "page" | "topic" | null;
  /** When the active watch's Monitor next runs (ISO), or null. */
  nextCheck: string | null;
  events: EventRow[];
  /** When the register was first read for this record: the "before" time of the oldest event. */
  firstReadAt: string | null;
  slots: { used: number; nextFreesAt: string | null };
  /** The visitor may take a public slot (admins are not limited by them). */
  admin: boolean;
  /** A refused watch: the line that says why. */
  notice?: string;
}

const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;

interface Comparable {
  status?: string | null;
  status_raw?: string | null;
  recheck_outcome?: string | null;
}

const asComparable = (v: unknown): Comparable => (v !== null && typeof v === "object" ? (v as Comparable) : {});

/** One reading: when, the status chip and the register's own words. */
function Reading(props: { at: string | null; view: Comparable }) {
  return (
    <span class="reading">
      <time class="when" datetime={props.at ?? undefined}>
        {props.at ? formatUtc(props.at) : "first reading"}
      </time>
      {props.view.status !== undefined ? (
        <span class="said">
          <StatusChip status={props.view.status ?? null} />
          {props.view.status_raw ? <small>{props.view.status_raw}</small> : null}
        </span>
      ) : null}
    </span>
  );
}

function HistoryRow(props: { event: EventRow; previousAt: string | null; via: string }) {
  const e = eventJson(props.event);
  const before = asComparable(e.before);
  const after = asComparable(e.after);
  if (e.kind === "status_change") {
    return (
      <li class="change status-change">
        <Reading at={props.previousAt} view={before} />
        <span class="arrow" aria-label="changed to">
          →
        </span>
        <Reading at={e.at} view={after} />
        <span class="via">
          {props.via}
          {e.source_url ? (
            <>
              {" · "}
              <a href={e.source_url} rel="noopener noreferrer">
                source ↗
              </a>
            </>
          ) : null}
        </span>
      </li>
    );
  }
  if (e.kind === "recheck") {
    return (
      <li class="change recheck">
        <Reading at={props.previousAt} view={{}} />
        <span class="arrow">→</span>
        <span class="reading">
          <time class="when" datetime={e.at ?? undefined}>
            {e.at ? formatUtc(e.at) : ""}
          </time>
          <span class="said">No change {after.status !== undefined ? <StatusChip status={after.status ?? null} /> : null}</span>
        </span>
        <span class="via">Re-read</span>
      </li>
    );
  }
  return (
    <li class="change notice">
      <Reading at={props.previousAt} view={{}} />
      <span class="arrow">→</span>
      <span class="reading">
        <time class="when" datetime={e.at ?? undefined}>
          {e.at ? formatUtc(e.at) : ""}
        </time>
        <span class="said">
          A public notice was found{after.recheck_outcome ? `; the re-check answered ${after.recheck_outcome.replace("_", " ")}` : ""}.
        </span>
      </span>
      <span class="via">
        Notice
        {e.source_url ? (
          <>
            {" · "}
            <a href={e.source_url} rel="noopener noreferrer">
              source ↗
            </a>
          </>
        ) : null}
      </span>
    </li>
  );
}

function WatchBlock(props: RecordPageProps) {
  const { record, watch, publicWatch, kind, slots } = props;
  const fresh = freshCheck(record);
  const expiry = publicWatch?.expires_at ? <p class="watch-note">{publicWatchLine(publicWatch.expires_at)}</p> : null;
  const full = !props.admin && slots.used >= PUBLIC_WATCH_SLOTS;
  return (
    <div class="watch-block">
      {props.notice ? (
        <p class="form-notice" role="status">
          {props.notice}
        </p>
      ) : null}
      <div class="watch-row">
        {watch !== null && (watch.kind === "page" || watch.kind === "topic") ? (
          <p class="watch-line">
            Watching · {WATCH_KIND[watch.kind]}
            {props.nextCheck ? ` · next ${watch.kind === "page" ? "check" : "search"} ${hhmm(props.nextCheck)}` : ""}
          </p>
        ) : kind === null ? (
          <p class="watch-note">{NOT_WATCHABLE_LINE}</p>
        ) : full ? (
          <p class="watch-note">{slotsFullLine(slots.nextFreesAt)}</p>
        ) : (
          <div class="watch-offer">
            <PostButton action={`/records/${record.record_id}/watch`} fields={{}} class="btn small secondary">
              Watch this record
            </PostButton>
            <span class="watch-note">
              {kind === "page"
                ? "A Page monitor re-reads the record page twice a day. A change becomes a row below."
                : "A Topic monitor searches for new public notices about this record twice a day. A notice triggers one re-check."}{" "}
              A visitor's watch lasts 7 days.
            </span>
          </div>
        )}
        <span class="actions">
          {fresh ? (
            <PostButton action="/check" fields={fresh.fields} class="linkish">
              Fresh check ({money(estimateUsd(fresh.method))})
            </PostButton>
          ) : null}
          {record.record_id ? (
            <a class="linkish" href={`/api/records/${record.record_id}/history`}>
              JSON
            </a>
          ) : null}
        </span>
      </div>
      {expiry}
    </div>
  );
}

export function RecordPage(props: RecordPageProps) {
  const { record, events } = props;
  const via = props.watch?.kind === "topic" ? "Topic monitor" : "Page monitor";
  return (
    <Layout
      title={`${listingName(record)}: ${record.status} · Standing`}
      noindex
      description={`${record.registry_name ?? "Register"} record, as Standing last read it, with every change Monitor caught.`}
      active="watchlist"
      stats={props.stats}
      paused={props.paused}
    >
      <section class="record-page">
        <p class="label crumbs">
          <a href="/watchlist">Watchlist</a> · {record.registry_name}
        </p>
        <RecordCard record={record} check={props.check} compact />
        <WatchBlock {...props} />
        <h2 class="history-title">History</h2>
        <p class="sub">Every reading Monitor caught, newest first. Each row compares two readings of the register.</p>
        {events.length === 0 ? (
          <p class="empty">No change recorded{props.firstReadAt ? ` since the first reading on ${formatUtc(props.firstReadAt)}` : ""}.</p>
        ) : (
          <ol class="history">
            {events.map((e, i) => (
              <HistoryRow event={e} previousAt={events[i + 1]?.at ?? props.firstReadAt} via={via} />
            ))}
          </ol>
        )}
      </section>
    </Layout>
  );
}
