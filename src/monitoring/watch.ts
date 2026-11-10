// Watches (spec 4.6): one TinyFish Monitor per watched record, and the two shared decision-page
// monitors (NMC, SRA). Monitor is the only trigger of a re-check; the Worker never polls a registry.
// Every cap is checked before anything is created, and the watch is reserved in one statement before
// its Monitor is made, so a Monitor is never created and then refused, whatever arrives at once.
import {
  CURATED_WATCH_SLOTS,
  MAX_MONITORS,
  PUBLIC_WATCH_SLOTS,
  PUBLIC_WATCH_TTL_DAYS,
  PUBLIC_WATCHES_PER_IP,
  SHARED_MONITORS,
} from "../core/limits";
import { spendPaused } from "../checks/queue";
import { bump, today } from "../db/publicUse";
import { getRecord, markWatched } from "../db/records";
import type { RecordRow, WatchRow } from "../db/types";
import {
  activateWatch,
  activeWatchForRecord,
  countWatches,
  dropReservation,
  getSharedMonitor,
  heldWatchForRecord,
  listSharedMonitors,
  putSharedMonitor,
  reserveWatch,
  setWatchStatus,
  visitorWatchesToday,
  type WatchAddedBy,
} from "../db/watches";
import type { Env } from "../env";
import { getAdapterById } from "../registries/index";
import type { RegistryAdapter } from "../registries/types";
import { TinyFishError } from "../tinyfish/client";
import { fetchPage } from "../tinyfish/fetch";
import { createMonitor, createTopicMonitor, deleteMonitor } from "../tinyfish/monitor";
import { dropForRecord } from "../site/htmlCache";

/** Spec 4.6, exactly. */
export const PAGE_PURPOSE =
  "The registration or licence status, restrictions, conditions, or disciplinary history of this registrant changed. Ignore timestamps and layout.";
export const TOPIC_PURPOSE = "A new public notice about this registrant's registration, fitness to practise or licence was published.";
export const SHARED_PURPOSE = "A new hearing outcome, sanction, decision or notice was published. Ignore dates and layout.";

/** Where TinyFish reports a Monitor run. It holds the webhook secret, so it is never logged. */
export function monitorWebhookUrl(env: Env): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/hooks/monitor/${env.WEBHOOK_SECRET}`;
}

/** A stable 32-bit hash of a string (FNV-1a), so a record always gets the same schedule. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Every 12 hours, staggered by `key`: minute = hash mod 60, hours h and h+12 with h = hash mod 12. */
export function staggeredCron(key: string): { cron: string; minute: number; hour: number } {
  const h = hash32(key);
  const minute = h % 60;
  const hour = h % 12;
  return { cron: `${minute} ${hour},${hour + 12} * * *`, minute, hour };
}

/** The next UTC time that cron fires after `now`. */
export function nextRun(minute: number, hour: number, now: Date = new Date()): string {
  for (let day = 0; day <= 1; day++) {
    for (const hh of [hour, hour + 12]) {
      const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, hh, minute));
      if (t.getTime() > now.getTime()) return t.toISOString();
    }
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, hour, minute)).toISOString();
}

/** A refusal: the HTTP status and the JSON body the handler answers with. */
export class WatchRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 502 | 503,
    readonly body: { error: string; [key: string]: unknown },
  ) {
    super(body.error);
    this.name = "WatchRefused";
  }
}

/** How a record is watched: a Page monitor on its record page when the registry has one and the record
 *  points at it, else a Topic monitor on its name, else not at all. */
export function watchKindFor(adapter: RegistryAdapter, record: RecordRow): "page" | "topic" | null {
  if ((adapter.recordUrl || adapter.parseRecordPage) && record.source_url && record.source_url !== adapter.searchUrl) return "page";
  if (adapter.topicQuery && record.full_name) return "topic";
  return null;
}

/** A refused Monitor create, with only the shaped error code (never upstream text). */
function createFailed(err: unknown): WatchRefused {
  if (err instanceof TinyFishError) return new WatchRefused(502, { error: "monitor_create_failed", http_status: err.status, code: err.code });
  return new WatchRefused(502, { error: "monitor_create_failed", http_status: null, code: "unknown" });
}

export interface WatchCaller {
  admin: boolean;
  ipHash: string;
}

/**
 * Starts watching a record. Refusals, in order: unknown record 404; `added_by: "curated"` without the
 * admin token 403; already actively watched 409; no way to watch this record 422; the account's Monitor
 * slots (MAX_MONITORS less the SHARED_MONITORS) 409 `watchlist_full`; public slots 409, a public
 * visitor's watches today 429, curated slots 409; spending paused 503; TinyFish refusing the create 502
 * (nothing stored). Then the Monitor, the watch row, `watched = 1` and, for a public watch, its expiry
 * and the visitor's count.
 */
export async function createWatch(
  env: Env,
  recordId: string,
  opts: { callbackUrl: string | null; addedBy?: string },
  who: WatchCaller,
): Promise<{ watch_id: string; kind: "page" | "topic"; next_check: string }> {
  const record = await getRecord(env.DB, recordId);
  if (record === null) throw new WatchRefused(404, { error: "not_found" });
  if (opts.addedBy !== undefined && opts.addedBy !== "curated" && opts.addedBy !== "admin" && opts.addedBy !== "public") {
    throw new WatchRefused(400, { error: "invalid_body", detail: "added_by must be curated, admin or public" });
  }
  if (opts.addedBy === "curated" && !who.admin) throw new WatchRefused(403, { error: "forbidden", detail: "curated watches need the admin token" });
  const addedBy: WatchAddedBy = who.admin ? (opts.addedBy === "curated" ? "curated" : "admin") : "public";

  const adapter = record.registry === null ? null : getAdapterById(record.registry);
  const kind = adapter === null ? null : watchKindFor(adapter, record);
  // The refusals, in their order. They are read here to answer early, and again after a reservation
  // that did not fit, to say which cap it was.
  const refusal = async (): Promise<WatchRefused | null> => {
    const held = await heldWatchForRecord(env.DB, record.id);
    if (held !== null) return new WatchRefused(409, { error: "already_watched", watch_id: held.id });
    if (adapter === null || kind === null) return new WatchRefused(422, { error: "not_watchable" });
    if ((await countWatches(env.DB)) + SHARED_MONITORS >= MAX_MONITORS) return new WatchRefused(409, { error: "watchlist_full" });
    if (addedBy === "public") {
      if ((await countWatches(env.DB, "public")) >= PUBLIC_WATCH_SLOTS) return new WatchRefused(409, { error: "public_slots_full" });
      const used = Math.max((await today(env.DB, who.ipHash)).watches, await visitorWatchesToday(env.DB, who.ipHash));
      if (used >= PUBLIC_WATCHES_PER_IP) return new WatchRefused(429, { error: "daily_limit" });
    }
    if (addedBy === "curated" && (await countWatches(env.DB, "curated")) >= CURATED_WATCH_SLOTS) {
      return new WatchRefused(409, { error: "curated_slots_full" });
    }
    return null;
  };
  const refused = await refusal();
  if (refused !== null) throw refused;
  if (adapter === null || kind === null) throw new WatchRefused(422, { error: "not_watchable" });
  // A Monitor's baseline and every run cost money.
  if (await spendPaused(env.DB)) throw new WatchRefused(503, { error: "spend_paused" });

  // The slot is taken before the Monitor is made. Making one takes seconds, and requests that arrive
  // in that time each passed the reads above; only the reservation, one statement, decides who fits.
  const expiresAt = addedBy === "public" ? new Date(Date.now() + PUBLIC_WATCH_TTL_DAYS * 86_400_000).toISOString() : null;
  const watchId = await reserveWatch(
    env.DB,
    { record_id: record.id, kind, added_by: addedBy, callback_url: opts.callbackUrl, expires_at: expiresAt, ip_hash: addedBy === "public" ? who.ipHash : null },
    {
      all: MAX_MONITORS - SHARED_MONITORS,
      ofKind: addedBy === "public" ? PUBLIC_WATCH_SLOTS : addedBy === "curated" ? CURATED_WATCH_SLOTS : null,
      perVisitor: addedBy === "public" ? PUBLIC_WATCHES_PER_IP : null,
    },
  );
  if (watchId === null) throw (await refusal()) ?? new WatchRefused(409, { error: "watchlist_full" });

  const schedule = staggeredCron(record.id);
  // The monitor's name never holds a person's name: only the registry and a short record id.
  const name = `standing-${adapter.id}-${record.id.slice(0, 8)}`;
  let monitorId: string;
  try {
    if (kind === "page") {
      ({ monitorId } = await createMonitor(env, {
        url: record.source_url!,
        name,
        scheduleCron: schedule.cron,
        purpose: PAGE_PURPOSE,
        webhookUrl: monitorWebhookUrl(env),
      }));
    } else {
      ({ monitorId } = await createTopicMonitor(env, {
        query: adapter.topicQuery!(record.full_name!),
        name,
        scheduleCron: schedule.cron,
        purpose: TOPIC_PURPOSE,
        webhookUrl: monitorWebhookUrl(env),
        recencyMinutes: 1440,
        resultLimit: 5,
      }));
    }
  } catch (err) {
    await dropReservation(env.DB, watchId).catch(() => console.error("watch reservation could not be dropped"));
    throw createFailed(err);
  }

  if (!(await activateWatch(env.DB, watchId, monitorId))) {
    // The reservation is gone (the create took longer than a reservation lasts): a Monitor with no
    // watch would run on unseen, so it is deleted again.
    await deleteMonitor(env, monitorId).catch(() => console.error("monitor without a watch could not be deleted"));
    throw createFailed(null);
  }
  await markWatched(env.DB, record.id, true);
  if (addedBy === "public") await bump(env.DB, who.ipHash, "watches");
  await dropForRecord(env, record.id);
  return { watch_id: watchId, kind, next_check: nextRun(schedule.minute, schedule.hour) };
}

/**
 * Stops watching a record: the admin, or the public visitor who created a public watch (curated and
 * admin watches: admin only). The Monitor is deleted (already gone counts as deleted), the watch kept
 * as `expired`, and the record's `watched` cleared (an explicit unwatch; an expiry keeps it).
 */
export async function removeWatch(env: Env, recordId: string, who: WatchCaller): Promise<WatchRow> {
  const watch = await activeWatchForRecord(env.DB, recordId);
  if (watch === null) throw new WatchRefused(404, { error: "not_found" });
  const allowed = who.admin || (watch.added_by === "public" && watch.ip_hash !== null && watch.ip_hash === who.ipHash);
  if (!allowed) throw new WatchRefused(403, { error: "forbidden" });
  if (watch.monitor_id !== null) {
    try {
      await deleteMonitor(env, watch.monitor_id);
    } catch (err) {
      throw new WatchRefused(502, { error: "monitor_delete_failed", code: err instanceof TinyFishError ? err.code : "unknown" });
    }
  }
  await setWatchStatus(env.DB, watch.id, "expired");
  await markWatched(env.DB, recordId, false);
  await dropForRecord(env, recordId);
  return { ...watch, status: "expired" };
}

export interface SharedResult {
  registry: string;
  created: boolean;
  monitor_id: string | null;
  url: string | null;
  http_status?: number | null;
  code?: string;
}

/**
 * Creates the NMC and SRA decision-page monitors once each (idempotent: a registry that already has one
 * is reported with `created: false`). Stops at the first refusal and reports its status and code;
 * nothing else on the account is touched to make room.
 */
export async function initSharedMonitors(env: Env): Promise<SharedResult[]> {
  const out: SharedResult[] = [];
  for (const id of ["nmc", "sra"]) {
    const adapter = getAdapterById(id);
    const page = adapter?.decisionPageFor?.(new Date()) ?? adapter?.decisionPages[0];
    if (!adapter || !page) continue;
    const existing = await getSharedMonitor(env.DB, id);
    if (existing !== null) {
      out.push({ registry: id, created: false, monitor_id: existing.monitor_id, url: existing.url });
      continue;
    }
    try {
      const { monitorId } = await createMonitor(env, {
        url: page.url,
        name: `standing-shared-${id}`,
        scheduleCron: staggeredCron(`shared-${id}`).cron,
        purpose: SHARED_PURPOSE,
        webhookUrl: monitorWebhookUrl(env),
      });
      await putSharedMonitor(env.DB, { registry: id, monitor_id: monitorId, url: page.url });
      out.push({ registry: id, created: true, monitor_id: monitorId, url: page.url });
    } catch (err) {
      const refused = createFailed(err);
      out.push({ registry: id, created: false, monitor_id: null, url: page.url, http_status: refused.body.http_status as number | null, code: refused.body.code as string });
      break;
    }
  }
  return out;
}

/**
 * Moves a shared monitor to its regulator's page for this month, where the regulator starts a new page
 * every month (the NMC): without this the Monitor would keep watching a page that no longer changes.
 * Nothing happens until the month's address differs from the one watched. Then the new page is read
 * once (free): a regulator may publish it late, and a Monitor on a missing page would watch nothing.
 * The new Monitor is made and stored first, and last month's deleted after, so the page is never
 * unwatched. Whatever cannot be done is left for the next hour and returned as a plain sentence.
 */
export async function rollSharedMonitors(env: Env, now: Date = new Date()): Promise<string[]> {
  const notes: string[] = [];
  for (const shared of await listSharedMonitors(env.DB)) {
    const adapter = getAdapterById(shared.registry);
    if (!adapter?.decisionPageFor || shared.monitor_id === null) continue;
    const page = adapter.decisionPageFor(now);
    if (page.url === shared.url) continue;
    const about = `shared ${shared.registry} decision page`;
    if (await spendPaused(env.DB)) {
      notes.push(`${about}: spending is paused, so its Monitor stays on last month's page`);
      continue;
    }
    if (!(await fetchPage(env, page.url, "markdown")).ok) {
      notes.push(`${about}: this month's page cannot be read yet, so its Monitor stays on last month's`);
      continue;
    }
    let monitorId: string;
    try {
      ({ monitorId } = await createMonitor(env, {
        url: page.url,
        name: `standing-shared-${shared.registry}-${now.toISOString().slice(0, 7)}`,
        scheduleCron: staggeredCron(`shared-${shared.registry}`).cron,
        purpose: SHARED_PURPOSE,
        webhookUrl: monitorWebhookUrl(env),
      }));
    } catch {
      notes.push(`${about}: TinyFish did not create this month's Monitor`);
      continue;
    }
    await putSharedMonitor(env.DB, { registry: shared.registry, monitor_id: monitorId, url: page.url });
    try {
      await deleteMonitor(env, shared.monitor_id);
    } catch {
      notes.push(`${about}: last month's Monitor ${shared.monitor_id} could not be deleted`);
    }
  }
  return notes;
}
