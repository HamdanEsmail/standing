// The watchlist: every watched or curated record, curated first, with what Monitor last did and how
// many public watch slots are left. Each record is its own verdict slab: the status word large on its
// colour, as on a result.
import type { WatchlistRow } from "../../db/watches";
import type { Stats } from "../../handlers/stats";
import { getAdapterById } from "../../registries/index";
import { toneOf, WATCH_KIND } from "../components";
import type { Flag, Status } from "../../core/status";
import { FLAG_TEXT, formatUtc, isPersonType, listingName, slotsFullLine, slotsLine, STATUS_WORD } from "../format";
import { Layout } from "../layout";
import { PUBLIC_WATCH_SLOTS, PUBLIC_WATCH_TTL_DAYS } from "../../core/limits";

/** A record's stored flags (why a company with a strike-off proposal is watched), known ones only. */
function flagsOf(json: string): Flag[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((f): f is Flag => typeof f === "string" && Object.hasOwn(FLAG_TEXT, f)) : [];
  } catch {
    return [];
  }
}

const EVENT_TEXT = { status_change: "Status change", notice: "Notice", recheck: "Re-read, no change" } as const;

function watchText(r: WatchlistRow): string {
  if (r.curated) return "Curated";
  if (r.watch_added_by === "public" && r.watch_expires_at) return `Until ${formatUtc(r.watch_expires_at)}`;
  if (r.watch_added_by === "admin") return "No expiry";
  return r.watch_kind === null ? "Watch ended; history kept" : "Watched";
}

export function Watchlist(props: { stats: Stats; paused: boolean; rows: WatchlistRow[]; slots: { used: number; nextFreesAt: string | null } }) {
  const { rows, slots } = props;
  return (
    <Layout
      title="Watchlist · Standing"
      description="The records Standing watches with TinyFish Monitor, and what each Monitor last caught."
      active="watchlist"
      stats={props.stats}
      paused={props.paused}
    >
      <section class="page-head">
        <h1>Watchlist</h1>
        <p class="sub">
          Records Standing re-reads whenever TinyFish Monitor reports a change on the register. Curated records are watched for the length of the
          review; a visitor's watch lasts {PUBLIC_WATCH_TTL_DAYS} days.
        </p>
        <p class="label slots">
          {slots.used >= PUBLIC_WATCH_SLOTS ? slotsFullLine(slots.nextFreesAt) : slotsLine(slots.used)}
        </p>
      </section>
      {rows.length === 0 ? (
        <p class="empty">No record is watched yet. Check a record, then choose "Watch this record" on its result.</p>
      ) : (
        <ul class="watch-grid" role="list">
          {rows.map((r) => {
            const word = r.status !== null && Object.hasOwn(STATUS_WORD, r.status) ? STATUS_WORD[r.status as Status] : "Unknown";
            const flags = flagsOf(r.flags);
            return (
              <li class="watched">
                <a class={`record tone-${toneOf(r.status)} listed`} href={`/records/${r.id}`} style={`--chars: ${word.length}`}>
                  <p class="where">
                    <b>{(r.registry !== null && getAdapterById(r.registry)?.name) || r.registry || ""}</b>
                    <span>
                      {watchText(r)}
                      {r.watch_kind ? ` · ${WATCH_KIND[r.watch_kind]}` : ""}
                    </span>
                  </p>
                  <div class={`status-word ${r.status ?? "unknown"}`}>{word}</div>
                  <p class="who">
                    {listingName(r)}
                    {r.licence_number && !isPersonType(r.record_type) ? <span class="mono">{r.licence_number}</span> : null}
                  </p>
                  {flags.length > 0 ? (
                    <div class="marks">
                      {flags.map((f) => (
                        <span class={`chip ${f === "interim_order" ? "bad" : "warn"}`}>{FLAG_TEXT[f]}</span>
                      ))}
                    </div>
                  ) : null}
                  <p class="acts">
                    <span>{r.last_checked_at ? `Last read ${formatUtc(r.last_checked_at)}` : "Not read yet"}</span>
                    <span>
                      {r.last_event_at && r.last_event_kind ? `${EVENT_TEXT[r.last_event_kind]} ${formatUtc(r.last_event_at)}` : "No change yet"}
                    </span>
                  </p>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Layout>
  );
}
