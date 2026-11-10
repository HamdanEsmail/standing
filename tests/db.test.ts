import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheKey,
  expirePublicChecks,
  findCached,
  finishCheck,
  finishPendingCheck,
  getCheck,
  getCheckByRunId,
  insertCandidates,
  insertCheck,
  listCandidates,
  markQueued,
  nextQueuedCheck,
  requeueByNumber,
  setRunId,
  type NewCheck,
} from "../src/db/checks";
import { insertEvent, listEvents, listEventsForRecord } from "../src/db/events";
import { bump, today } from "../src/db/publicUse";
import {
  getRecord,
  listWatchedAndCurated,
  markWatched,
  recordDiff,
  upsertRecord,
  type RecordInput,
} from "../src/db/records";
import type { NormalizedRecord, RecordRow } from "../src/db/types";
import {
  countWatches,
  expireWatches,
  getSharedMonitor,
  getSharedMonitorByMonitorId,
  getWatch,
  getWatchByMonitorId,
  insertWatch,
  listSharedMonitors,
  listWatches,
  putSharedMonitor,
} from "../src/db/watches";
import type { RegistryRow } from "../src/registries/types";

const db = env.DB;

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const ahead = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

const KEY = "gmc|doctor||christopher wickfold";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A finished GMC match, read an hour ago, filed by a public visitor. */
function done(over: NewCheck = {}): NewCheck {
  return {
    registry: "gmc",
    record_type: "doctor",
    jurisdiction: "GB",
    query_raw: "Christopher Wickfold",
    query_normalized: "christopher wickfold",
    cache_key: KEY,
    added_by: "public",
    state: "done",
    outcome: "match",
    status: "active",
    method: "fetch",
    started_at: ago(1),
    checked_at: ago(1),
    ...over,
  };
}

function normalized(over: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return {
    full_name: "Christopher John Marlow Wickfold",
    licence_number: "9360749",
    status_raw: "Registered with a licence to practise",
    status: "active",
    flags: [],
    disciplinary: [],
    ...over,
  };
}

function recordInput(over: Partial<RecordInput> = {}): RecordInput {
  return {
    registry: "gmc",
    record_type: "doctor",
    source_url: "https://www.gmc-uk.org/registrants/9360749",
    record: normalized(),
    ...over,
  };
}

async function recordRow(id: string): Promise<RecordRow> {
  const row = await getRecord(db, id);
  if (!row) throw new Error(`no record ${id}`);
  return row;
}

describe("cacheKey", () => {
  it("joins registry, record type, profession and query or number, lowercase and tidy", () => {
    expect(cacheKey("gmc", "doctor", "Christopher  Wickfold")).toBe("gmc|doctor||christopher wickfold");
    expect(cacheKey("companies-house", "company", "00444786")).toBe("companies-house|company||00444786");
    expect(cacheKey("ca-dca", "professional", "A 12345", "Dental Board")).toBe(
      "ca-dca|professional|dental board|a 12345",
    );
  });

  it("is stable, and a pipe in a part cannot move the boundary between two parts", () => {
    expect(cacheKey("gmc", "doctor", " Wickfold ")).toBe(cacheKey("GMC", "doctor", "wickfold"));
    expect(cacheKey("gmc", "doctor", "a|b", "c")).not.toBe(cacheKey("gmc", "doctor", "b", "c|a"));
  });
});

describe("findCached", () => {
  it("returns the latest done check in the window, carrying the checked_at it was read at", async () => {
    const readAt = ago(3);
    await insertCheck(db, done({ checked_at: ago(10), started_at: ago(10) }));
    const newer = await insertCheck(db, done({ checked_at: readAt, started_at: ago(2.9) }));

    const hit = await findCached(db, KEY, 24);
    expect(hit?.id).toBe(newer);
    expect(hit?.checked_at).toBe(readAt);
  });

  it("respects the window: 23 hours old is a hit, 25 hours old is a miss, and the window is the caller's", async () => {
    const inside = await insertCheck(db, done({ cache_key: "k-23", checked_at: ago(23), started_at: ago(23) }));
    await insertCheck(db, done({ cache_key: "k-25", checked_at: ago(25), started_at: ago(25) }));

    expect((await findCached(db, "k-23", 24))?.id).toBe(inside);
    expect(await findCached(db, "k-25", 24)).toBeNull();
    // The window is the caller's: the same rows under another window.
    expect(await findCached(db, "k-23", 22)).toBeNull();
    expect((await findCached(db, "k-25", 26))?.cache_key).toBe("k-25");
  });

  it("serves ambiguous and no_match results too", async () => {
    const ambiguous = await insertCheck(db, done({ outcome: "ambiguous", status: null, cache_key: "k-a" }));
    const none = await insertCheck(db, done({ outcome: "no_match", status: null, cache_key: "k-n" }));
    expect((await findCached(db, "k-a", 24))?.id).toBe(ambiguous);
    expect((await findCached(db, "k-n", 24))?.id).toBe(none);
  });

  it("ignores error, unsupported and unfinished checks, even newer ones, and other keys", async () => {
    const good = await insertCheck(db, done({ checked_at: ago(8), started_at: ago(8) }));
    await insertCheck(db, done({ outcome: "error", status: null, error: "busy", checked_at: ago(1) }));
    await insertCheck(db, done({ outcome: "unsupported", status: null, checked_at: ago(1) }));
    await insertCheck(db, done({ state: "pending", outcome: null, status: null, checked_at: null }));
    await insertCheck(db, done({ cache_key: "gmc|doctor||someone else", checked_at: ago(0.5) }));

    expect((await findCached(db, KEY, 24))?.id).toBe(good);
    expect(await findCached(db, "gmc|doctor||nobody", 24)).toBeNull();
  });

  it("returns nothing when only error checks exist", async () => {
    await insertCheck(db, done({ outcome: "error", status: null, error: "busy" }));
    expect(await findCached(db, KEY, 24)).toBeNull();
  });

  it("skips a match whose record had a status_change after the check was read", async () => {
    const recordId = await upsertRecord(db, recordInput());
    await insertCheck(db, done({ record_id: recordId, checked_at: ago(5), started_at: ago(5) }));

    // Nothing has happened to the record: served.
    expect((await findCached(db, KEY, 24))?.record_id).toBe(recordId);

    // A recheck or a notice does not change the facts the check carries.
    await insertEvent(db, { record_id: recordId, kind: "recheck", at: ago(2) });
    await insertEvent(db, { record_id: recordId, kind: "notice", at: ago(2) });
    expect((await findCached(db, KEY, 24))?.record_id).toBe(recordId);

    // A status change from before the check was read is already in what it carries.
    await insertEvent(db, { record_id: recordId, kind: "status_change", at: ago(6) });
    expect((await findCached(db, KEY, 24))?.record_id).toBe(recordId);

    // A status change after the read means the record is no longer what the check saw.
    await insertEvent(db, { record_id: recordId, kind: "status_change", at: ago(2) });
    expect(await findCached(db, KEY, 24)).toBeNull();
  });

  it("applies the status-change rule to matches only: an ambiguous or no_match check carries no record facts", async () => {
    const recordId = await upsertRecord(db, recordInput());
    await insertEvent(db, { record_id: recordId, kind: "status_change", at: ago(0.5) });
    const amb = await insertCheck(
      db,
      done({ outcome: "ambiguous", status: null, record_id: recordId, cache_key: "k-a", checked_at: ago(5), started_at: ago(5) }),
    );
    const none = await insertCheck(
      db,
      done({ outcome: "no_match", status: null, record_id: recordId, cache_key: "k-n", checked_at: ago(5), started_at: ago(5) }),
    );
    await insertCheck(db, done({ record_id: recordId, cache_key: "k-m", checked_at: ago(5), started_at: ago(5) }));

    expect((await findCached(db, "k-a", 24))?.id).toBe(amb);
    expect((await findCached(db, "k-n", 24))?.id).toBe(none);
    expect(await findCached(db, "k-m", 24)).toBeNull();
  });

  it("falls back to an older check that is still true when the newest match went stale", async () => {
    const recordId = await upsertRecord(db, recordInput());
    const older = await insertCheck(
      db,
      done({ outcome: "no_match", status: null, cache_key: "k", checked_at: ago(9), started_at: ago(9) }),
    );
    await insertCheck(db, done({ record_id: recordId, cache_key: "k", checked_at: ago(5), started_at: ago(5) }));
    await insertEvent(db, { record_id: recordId, kind: "status_change", at: ago(2) });
    expect((await findCached(db, "k", 24))?.id).toBe(older);
  });

  it("a request check (no monitor run) is staled by a status change that Monitor caught, and the reverse", async () => {
    const recordId = await upsertRecord(db, recordInput());
    // The main production case: a request check, then a webhook-caught change.
    await insertCheck(db, done({ record_id: recordId, cache_key: "k-req", checked_at: ago(5), started_at: ago(5) }));
    // A monitor check, then a change recorded with another run id.
    await insertCheck(
      db,
      done({ record_id: recordId, cache_key: "k-mon", trigger: "monitor", monitor_run_id: "mrun-1", checked_at: ago(5), started_at: ago(5) }),
    );
    expect((await findCached(db, "k-req", 24))?.record_id).toBe(recordId);
    expect((await findCached(db, "k-mon", 24))?.record_id).toBe(recordId);

    await insertEvent(db, { record_id: recordId, kind: "status_change", monitor_run_id: "mrun-9", at: ago(2) });
    expect(await findCached(db, "k-req", 24)).toBeNull();
    expect(await findCached(db, "k-mon", 24)).toBeNull();
  });

  it("a monitor check is staled by a later status change that carries no run id", async () => {
    const recordId = await upsertRecord(db, recordInput());
    await insertCheck(
      db,
      done({ record_id: recordId, trigger: "monitor", monitor_run_id: "mrun-1", checked_at: ago(5), started_at: ago(5) }),
    );
    await insertEvent(db, { record_id: recordId, kind: "status_change", monitor_run_id: null, at: ago(2) });
    expect(await findCached(db, KEY, 24)).toBeNull();
  });

  it("serves the check that observed a change: an event from the check's own monitor run does not stale it", async () => {
    const recordId = await upsertRecord(db, recordInput());
    const own = await insertCheck(
      db,
      done({ record_id: recordId, trigger: "monitor", monitor_run_id: "mrun-1", checked_at: ago(2), started_at: ago(2) }),
    );
    await insertEvent(db, { record_id: recordId, kind: "status_change", monitor_run_id: "mrun-1", at: ago(1.9) });
    expect((await findCached(db, KEY, 24))?.id).toBe(own);

    // A later change from another run does stale it.
    await insertEvent(db, { record_id: recordId, kind: "status_change", monitor_run_id: "mrun-2", at: ago(0.5) });
    expect(await findCached(db, KEY, 24)).toBeNull();
  });
});

describe("checks", () => {
  it("insertCheck generates the id, stamps started_at, defaults to pending and stringifies the JSON columns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T09:00:00.000Z"));
    const id = await insertCheck(db, {
      registry: "gmc",
      record_type: "doctor",
      jurisdiction: "GB",
      query_raw: "Christopher Wickfold",
      cache_key: KEY,
      added_by: "public",
      ip_hash: "ip1",
      run_id: "run-1",
      callback_url: "https://example.com/hook",
      variants_tried: ["Christopher Wickfold", "Wickfold"],
      suggestions: ["try the number"],
    });
    vi.useRealTimers();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getCheck(db, id)).toMatchObject({
      id,
      state: "pending",
      outcome: null,
      status: null,
      flags: "[]",
      variants_tried: '["Christopher Wickfold","Wickfold"]',
      suggestions: '["try the number"]',
      trigger: "request",
      started_at: "2026-11-05T09:00:00.000Z",
      checked_at: null,
      run_id: "run-1",
      ip_hash: "ip1",
    });
  });

  it("insertCheck keeps a given id, started_at and state (a cached copy is born done)", async () => {
    const id = await insertCheck(
      db,
      done({ id: "copy-1", cached_from_check_id: "orig-1", checked_at: "2026-11-05T08:00:00.000Z", started_at: "2026-11-05T09:30:00.000Z" }),
    );
    expect(id).toBe("copy-1");
    expect(await getCheck(db, "copy-1")).toMatchObject({
      state: "done",
      cached_from_check_id: "orig-1",
      checked_at: "2026-11-05T08:00:00.000Z",
      started_at: "2026-11-05T09:30:00.000Z",
    });
  });

  it("getCheck and getCheckByRunId return null for an unknown id", async () => {
    await insertCheck(db, { run_id: "run-1" });
    expect(await getCheck(db, "nope")).toBeNull();
    expect(await getCheckByRunId(db, "nope")).toBeNull();
    expect((await getCheckByRunId(db, "run-1"))?.run_id).toBe("run-1");
  });

  it("finishCheck sets state done, stringifies arrays, stamps checked_at, and leaves the other columns alone", async () => {
    const id = await insertCheck(db, { registry: "gmc", cache_key: KEY, added_by: "public", ip_hash: "ip1" });
    await finishCheck(db, id, {
      outcome: "match",
      status: "conditions",
      flags: ["interim_order"],
      variants_tried: ["Christopher Wickfold"],
      suggestions: [],
      record_id: "rec-1",
      method: "fetch",
      evidence_key: `evidence/${id}.jpg`,
      spend_usd: 0.128,
      checked_at: "2026-11-05T09:22:55.000Z",
    });
    expect(await getCheck(db, id)).toMatchObject({
      state: "done",
      outcome: "match",
      status: "conditions",
      flags: '["interim_order"]',
      variants_tried: '["Christopher Wickfold"]',
      suggestions: "[]",
      record_id: "rec-1",
      method: "fetch",
      evidence_key: `evidence/${id}.jpg`,
      spend_usd: 0.128,
      checked_at: "2026-11-05T09:22:55.000Z",
      registry: "gmc",
      cache_key: KEY,
      ip_hash: "ip1",
    });
  });

  it("finishCheck stamps checked_at with now when the patch has none, and never moves one that is set", async () => {
    const a = await insertCheck(db, {});
    await finishCheck(db, a, { outcome: "error", error: "busy" });
    const stamped = (await getCheck(db, a))?.checked_at;
    expect(stamped).toBeTruthy();
    expect(Date.now() - Date.parse(stamped ?? "")).toBeLessThan(60_000);

    await finishCheck(db, a, { evidence_key: "evidence/x.jpg" });
    expect((await getCheck(db, a))?.checked_at).toBe(stamped);
  });

  it("finishPendingCheck finishes a pending check once and says whether it did", async () => {
    const id = await insertCheck(db, { registry: "gmc", added_by: "public" });
    expect(await finishPendingCheck(db, id, { outcome: "match", status: "active", checked_at: "2026-11-05T09:22:55.000Z" })).toBe(true);
    expect(await getCheck(db, id)).toMatchObject({ state: "done", outcome: "match", status: "active" });

    // A second finish changes nothing.
    expect(await finishPendingCheck(db, id, { outcome: "error", status: null, error: "late duplicate" })).toBe(false);
    expect(await getCheck(db, id)).toMatchObject({ state: "done", outcome: "match", status: "active", error: null });

    expect(await finishPendingCheck(db, "no-such-check", { outcome: "error" })).toBe(false);
  });

  it("finishPendingCheck lets exactly one of two racing callbacks resolve the check", async () => {
    const id = await insertCheck(db, { registry: "gmc", added_by: "public", run_id: "run-1" });
    const results = await Promise.all([
      finishPendingCheck(db, id, { outcome: "match", status: "active", spend_usd: 0.1 }),
      finishPendingCheck(db, id, { outcome: "no_match", spend_usd: 0.2 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await getCheck(db, id);
    expect(row?.state).toBe("done");
    // The row holds one callback's patch whole, not a mixture.
    expect([
      { outcome: "match", spend_usd: 0.1 },
      { outcome: "no_match", spend_usd: 0.2 },
    ]).toContainEqual({ outcome: row?.outcome, spend_usd: row?.spend_usd });
  });

  it("finishPendingCheck with candidates stores them in the same transaction, and only when it applies", async () => {
    const id = await insertCheck(db, { registry: "gmc", added_by: "public", run_id: "run-c" });
    const rows: RegistryRow[] = [
      { name: "Ada FICTITIOUS", number: "99000001", status_raw: null, detail: null, url: null },
      { name: "Ada Jane FICTITIOUS", number: "99000002", status_raw: null, detail: "London", url: null },
    ];
    const results = await Promise.all([
      finishPendingCheck(db, id, { outcome: "ambiguous", candidates_total: 2 }, rows),
      finishPendingCheck(db, id, { outcome: "ambiguous", candidates_total: 2 }, rows),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await listCandidates(db, id)).map((c) => [c.position, c.licence_number])).toEqual([
      [0, "99000001"],
      [1, "99000002"],
    ]);
    // A done check takes no candidates.
    expect(await finishPendingCheck(db, id, { outcome: "ambiguous" }, rows)).toBe(false);
    expect(await listCandidates(db, id)).toHaveLength(2);
  });

  it("nextQueuedCheck is the oldest pending Agent check without a run; markQueued and setRunId move a check in and out", async () => {
    expect(await nextQueuedCheck(db)).toBeNull();
    const fetching = await insertCheck(db, { method: "fetch", started_at: ago(3) });
    const started = await insertCheck(db, { method: "agent", run_id: "run-1", started_at: ago(3) });
    await insertCheck(db, { method: "agent", state: "done", outcome: "error", started_at: ago(3) });
    const newer = await insertCheck(db, { method: "agent", started_at: ago(1) });
    const older = await insertCheck(db, { method: "agent", started_at: ago(2) });
    expect((await nextQueuedCheck(db))?.id).toBe(older);

    // A Fetch-path check joins the queue only when it falls back to the Agent; it is then the oldest.
    expect(await markQueued(db, fetching)).toBe(true);
    expect((await nextQueuedCheck(db))?.id).toBe(fetching);
    expect(await markQueued(db, started)).toBe(false);

    expect(await setRunId(db, fetching, "run-2")).toBe(true);
    expect(await setRunId(db, fetching, "run-3")).toBe(false);
    expect(await getCheck(db, fetching)).toMatchObject({ state: "pending", run_id: "run-2", method: "agent" });
    expect((await nextQueuedCheck(db))?.id).toBe(older);
    expect(newer).not.toBe(older);
  });

  it("requeueByNumber sends a name check back to the queue by number once, guarded on its run", async () => {
    const id = await insertCheck(db, { method: "agent", run_id: "run-name", query_raw: "Ada Fictitious" });
    expect(await requeueByNumber(db, id, "run-other", "99000001", { variants_tried: ["ada fictitious"], spend_usd: 0.144 })).toBe(false);
    expect(await requeueByNumber(db, id, "run-name", "99000001", { variants_tried: ["ada fictitious"], spend_usd: 0.144 })).toBe(true);
    expect(await getCheck(db, id)).toMatchObject({
      state: "pending",
      method: "agent",
      run_id: null,
      number: "99000001",
      variants_tried: '["ada fictitious"]',
      spend_usd: 0.144,
    });
    expect((await nextQueuedCheck(db))?.id).toBe(id);
    // A check that already searched by number never goes back again.
    expect(await setRunId(db, id, "run-number")).toBe(true);
    expect(await requeueByNumber(db, id, "run-number", "99000001", { variants_tried: [], spend_usd: 0.3 })).toBe(false);
  });

  it("finishCheck lets the patch say the check stays pending", async () => {
    const id = await insertCheck(db, {});
    await finishCheck(db, id, { run_id: "run-9", state: "pending" });
    expect(await getCheck(db, id)).toMatchObject({ state: "pending", run_id: "run-9", checked_at: null });
  });

  it("finishCheck writes only whitelisted columns and binds every value", async () => {
    const id = await insertCheck(db, { registry: "gmc", added_by: "public" });
    const hostile = "x'; DROP TABLE checks; --";
    await finishCheck(db, id, {
      error: hostile,
      // Not in the whitelist: ignored, never turned into SQL.
      id: "hijacked",
      added_by: "admin",
      "error = 'pwned', outcome": "match",
    } as never);

    expect(await getCheck(db, id)).toMatchObject({ id, added_by: "public", error: hostile, outcome: null });
    expect(await getCheck(db, "hijacked")).toBeNull();
  });
});

describe("timestamps", () => {
  // A TinyFish time has seconds only; ours have milliseconds. As text "...34Z" sorts after "...34.500Z",
  // so unless both are stored the same way a later read can look earlier.
  const sec = Math.floor((Date.now() - 2 * HOUR) / 1000) * 1000;
  const secondRes = new Date(sec).toISOString().replace(".000Z", "Z");
  const normalizedSec = new Date(sec).toISOString();
  const halfSecondLater = new Date(sec + 500).toISOString();

  it("stores a check's times as millisecond ISO, so mixed resolutions sort as time", async () => {
    const earlier = await insertCheck(db, done({ checked_at: secondRes, started_at: secondRes }));
    const later = await insertCheck(db, done({ checked_at: halfSecondLater, started_at: halfSecondLater }));

    expect(await getCheck(db, earlier)).toMatchObject({ checked_at: normalizedSec, started_at: normalizedSec });
    expect((await findCached(db, KEY, 24))?.id).toBe(later);

    const pending = await insertCheck(db, { cache_key: "k-fin" });
    await finishCheck(db, pending, { outcome: "no_match", checked_at: secondRes });
    expect((await getCheck(db, pending))?.checked_at).toBe(normalizedSec);
    const second = await insertCheck(db, { cache_key: "k-fin2" });
    expect(await finishPendingCheck(db, second, { outcome: "no_match", checked_at: secondRes })).toBe(true);
    expect((await getCheck(db, second))?.checked_at).toBe(normalizedSec);
  });

  it("stores a record's, an event's and a watch's times the same way, and compares query times the same way", async () => {
    const rec = await upsertRecord(db, recordInput({ checked_at: secondRes }));
    expect(await getRecord(db, rec)).toMatchObject({ first_seen_at: normalizedSec, last_checked_at: normalizedSec });
    await markWatched(db, rec, true);

    const event = await insertEvent(db, { record_id: rec, kind: "recheck", at: secondRes, notified_at: secondRes });
    const [stored] = await listEventsForRecord(db, rec);
    expect(stored).toMatchObject({ id: event, at: normalizedSec, notified_at: normalizedSec });
    // The event at exactly that instant is inside "since" however the instant is written.
    expect((await listEvents(db, secondRes, 10)).map((e) => e.id)).toEqual([event]);
    expect((await listEvents(db, halfSecondLater, 10)).map((e) => e.id)).toEqual([]);

    const watch = await insertWatch(db, {
      record_id: rec, kind: "page", monitor_id: "m", added_by: "public", expires_at: secondRes,
    });
    expect((await getWatch(db, watch))?.expires_at).toBe(normalizedSec);
    // The same instant, written with seconds only: the watch has run out.
    expect((await expireWatches(db, secondRes)).map((w) => w.id)).toEqual([watch]);
  });

  it("compares the purge cutoff as time too", async () => {
    await insertCheck(db, done({ id: "old", started_at: secondRes, evidence_key: null }));
    await insertCheck(db, done({ id: "new", started_at: halfSecondLater, evidence_key: null }));
    // A cutoff written with seconds only, at the instant "old" started: neither started before it.
    expect((await expirePublicChecks(db, secondRes)).ids).toEqual([]);
    // 400 ms later: "old" started before it, "new" (500 ms in) did not.
    expect((await expirePublicChecks(db, new Date(sec + 400).toISOString())).ids).toEqual(["old"]);
  });

  it("rejects a time that does not parse, and keeps null as null", async () => {
    await expect(insertCheck(db, { checked_at: "not a time" })).rejects.toThrow();
    await expect(insertCheck(db, { started_at: "" })).rejects.toThrow();
    await expect(insertCheck(db, { expires_at: "soon" })).rejects.toThrow();
    const id = await insertCheck(db, { checked_at: null, expires_at: null });
    expect(await getCheck(db, id)).toMatchObject({ checked_at: null, expires_at: null });
    await expect(finishCheck(db, id, { checked_at: "later" })).rejects.toThrow();
    await expect(finishPendingCheck(db, id, { checked_at: "later" })).rejects.toThrow();
    await expect(expirePublicChecks(db, "yesterday-ish")).rejects.toThrow();
    await expect(upsertRecord(db, recordInput({ checked_at: "whenever" }))).rejects.toThrow();
    await expect(insertEvent(db, { record_id: "r", kind: "recheck", at: "tomorrow-ish" })).rejects.toThrow();
    await expect(listEvents(db, "since-ish", 5)).rejects.toThrow();
    await expect(expireWatches(db, "now-ish")).rejects.toThrow();
    await expect(
      insertWatch(db, { record_id: "r", kind: "page", monitor_id: "m", added_by: "public", expires_at: "eventually" }),
    ).rejects.toThrow();
    const n = await db.prepare("SELECT COUNT(*) AS n FROM records").first<{ n: number }>();
    expect(n?.n).toBe(0);
    const w = await db.prepare("SELECT COUNT(*) AS n FROM watches").first<{ n: number }>();
    expect(w?.n).toBe(0);
  });
});

describe("candidates", () => {
  const rows: RegistryRow[] = [
    { name: "Zoe WICKFOLD", number: "7000001", status_raw: "Registered", detail: "Leeds", url: "https://r/7000001" },
    { name: "Aaron Wickfold", number: null, status_raw: null, detail: null, url: null },
    { name: "Mark WICKFOLD", number: "7000003", status_raw: "Not registered", detail: "Bath", url: "https://r/7000003" },
  ];

  it("insertCandidates numbers the rows in the order given and does not re-sort", async () => {
    const id = await insertCheck(db, {});
    await insertCandidates(db, id, rows);

    const listed = await listCandidates(db, id);
    expect(listed.map((c) => c.position)).toEqual([0, 1, 2]);
    expect(listed.map((c) => c.full_name)).toEqual(["Zoe WICKFOLD", "Aaron Wickfold", "Mark WICKFOLD"]);
    expect(listed[0]).toEqual({
      check_id: id,
      position: 0,
      licence_number: "7000001",
      full_name: "Zoe WICKFOLD",
      status_raw: "Registered",
      detail: "Leeds",
      source_url: "https://r/7000001",
    });
    expect(listed[1]).toMatchObject({ licence_number: null, status_raw: null, detail: null, source_url: null });
  });

  it("keeps candidates apart per check, and an empty list inserts nothing", async () => {
    const a = await insertCheck(db, {});
    const b = await insertCheck(db, {});
    await insertCandidates(db, a, rows);
    await insertCandidates(db, b, rows.slice(0, 1));
    await insertCandidates(db, b, []);
    expect(await listCandidates(db, a)).toHaveLength(3);
    expect(await listCandidates(db, b)).toHaveLength(1);
    expect(await listCandidates(db, "nobody")).toEqual([]);
  });
});

describe("expirePublicChecks", () => {
  it("deletes old unwatched public checks with their candidates and unreferenced records, and returns ids and evidence keys", async () => {
    const recA = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "1" }) }));
    const recB = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "2" }) }));
    await markWatched(db, recB, true);

    const a = await insertCheck(db, done({ id: "a", record_id: recA, evidence_key: "evidence/a.jpg", started_at: ago(30) }));
    const b = await insertCheck(db, done({ id: "b", record_id: recB, evidence_key: "evidence/b.jpg", started_at: ago(30) }));
    const fresh = await insertCheck(db, done({ id: "fresh", started_at: ago(1), evidence_key: "evidence/fresh.jpg" }));
    const ambiguous = await insertCheck(db, done({ id: "f", outcome: "ambiguous", status: null, started_at: ago(30) }));
    const pending = await insertCheck(db, { id: "p", added_by: "public", started_at: ago(30) });
    await insertCandidates(db, ambiguous, [{ name: "X", number: "9", status_raw: null, detail: null, url: null }]);
    await insertCandidates(db, b, [{ name: "Y", number: "8", status_raw: null, detail: null, url: null }]);

    const out = await expirePublicChecks(db, ago(24));

    expect(out.ids.sort()).toEqual([a, ambiguous, pending].sort());
    expect(out.evidenceKeys.sort()).toEqual(["evidence/a.jpg", "evidence/a.md"]);

    expect(await getCheck(db, a)).toBeNull();
    expect(await getCheck(db, ambiguous)).toBeNull();
    expect(await getCheck(db, pending)).toBeNull();
    expect(await listCandidates(db, ambiguous)).toEqual([]);
    // The watched record keeps its check, its candidates and itself; the fresh check is untouched.
    expect(await getCheck(db, b)).not.toBeNull();
    expect(await listCandidates(db, b)).toHaveLength(1);
    expect(await getCheck(db, fresh)).not.toBeNull();
    expect(await getRecord(db, recB)).not.toBeNull();
    // The one-off record nobody watches goes with its check.
    expect(await getRecord(db, recA)).toBeNull();
  });

  it("never touches admin or curated checks, nor a record they reference", async () => {
    const rec = await upsertRecord(db, recordInput());
    const admin = await insertCheck(db, done({ id: "admin", added_by: "admin", record_id: rec, started_at: ago(90), evidence_key: "evidence/admin.jpg" }));
    const curated = await insertCheck(db, done({ id: "curated", added_by: "curated", record_id: rec, started_at: ago(90), evidence_key: "evidence/curated.jpg" }));
    const pub = await insertCheck(db, done({ id: "pub", record_id: rec, started_at: ago(30), evidence_key: "evidence/pub.jpg" }));

    const out = await expirePublicChecks(db, ago(24));

    expect(out.ids).toEqual([pub]);
    expect(out.evidenceKeys.sort()).toEqual(["evidence/pub.jpg", "evidence/pub.md"]);
    expect(await getCheck(db, admin)).not.toBeNull();
    expect(await getCheck(db, curated)).not.toBeNull();
    expect(await getRecord(db, rec)).not.toBeNull();
  });

  it("keeps a record that another remaining check still references", async () => {
    const rec = await upsertRecord(db, recordInput());
    await insertCheck(db, done({ id: "old", record_id: rec, started_at: ago(30) }));
    await insertCheck(db, done({ id: "new", record_id: rec, started_at: ago(2) }));
    const out = await expirePublicChecks(db, ago(24));
    expect(out.ids).toEqual(["old"]);
    expect(await getRecord(db, rec)).not.toBeNull();
  });

  it("keeps an evidence key a remaining check still references (a cached check copies the original's key)", async () => {
    const rec = await upsertRecord(db, recordInput());
    await insertCheck(db, done({ id: "orig", record_id: rec, started_at: ago(30), evidence_key: "evidence/orig.jpg" }));
    await insertCheck(
      db,
      done({ id: "copy", record_id: rec, cached_from_check_id: "orig", started_at: ago(2), evidence_key: "evidence/orig.jpg" }),
    );

    const first = await expirePublicChecks(db, ago(24));
    expect(first.ids).toEqual(["orig"]);
    expect(first.evidenceKeys).toEqual([]);
    expect(await getRecord(db, rec)).not.toBeNull();

    // Once the copy goes too, the original's objects are nobody's and are returned (under the key the copy carried).
    const second = await expirePublicChecks(db, ahead(1));
    expect(second.ids).toEqual(["copy"]);
    expect(second.evidenceKeys.sort()).toEqual(["evidence/orig.jpg", "evidence/orig.md"]);
    expect(await getRecord(db, rec)).toBeNull();
  });

  it("keeps an evidence key a remaining record still references", async () => {
    // The record survives because a curated check points at it, and its evidence is the expiring check's.
    const rec = await upsertRecord(db, recordInput({ evidence_key: "evidence/x.jpg" }));
    await insertCheck(db, done({ id: "curated", added_by: "curated", record_id: rec, started_at: ago(90) }));
    await insertCheck(db, done({ id: "x", record_id: rec, started_at: ago(30), evidence_key: "evidence/x.jpg" }));

    const out = await expirePublicChecks(db, ago(24));
    expect(out.ids).toEqual(["x"]);
    expect(out.evidenceKeys).toEqual([]);
    expect((await getRecord(db, rec))?.evidence_key).toBe("evidence/x.jpg");
  });

  it("releases the evidence of a deleted record that no deleted check carried", async () => {
    // c1 reads the record with a screenshot; c2 re-reads without one, so the record keeps c1's key.
    const rec = await upsertRecord(db, recordInput({ evidence_key: "evidence/c1.jpg" }));
    await insertCheck(db, done({ id: "c1", record_id: rec, started_at: ago(40), evidence_key: "evidence/c1.jpg" }));
    await insertCheck(db, done({ id: "c2", record_id: rec, started_at: ago(10), evidence_key: null }));

    // c1 expires while the record (kept by c2) still holds its key.
    expect(await expirePublicChecks(db, ago(24))).toEqual({ ids: ["c1"], evidenceKeys: [] });
    // c2 expires, the record goes, and the key it held is nobody's: it must be returned.
    const second = await expirePublicChecks(db, ahead(1));
    expect(second.ids).toEqual(["c2"]);
    expect(second.evidenceKeys).toEqual(["evidence/c1.jpg", "evidence/c1.md"]);
    expect(await getRecord(db, rec)).toBeNull();
  });

  it("returns a deleted record's key even when it differs from every deleted check's key, unless a remaining check names it", async () => {
    const rec = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "r1" }), evidence_key: "evidence/rec.jpg" }));
    await insertCheck(db, done({ id: "a", record_id: rec, started_at: ago(30), evidence_key: "evidence/a.jpg" }));
    const shared = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "r2" }), evidence_key: "evidence/shared.jpg" }));
    await insertCheck(db, done({ id: "b", record_id: shared, started_at: ago(30), evidence_key: null }));
    // A curated check elsewhere still names the second record's key.
    await insertCheck(db, done({ id: "keeper", added_by: "curated", started_at: ago(90), evidence_key: "evidence/shared.jpg" }));

    const out = await expirePublicChecks(db, ago(24));
    expect(out.ids).toEqual(["a", "b"]);
    expect(out.evidenceKeys).toEqual(["evidence/a.jpg", "evidence/a.md", "evidence/rec.jpg", "evidence/rec.md"]);
    expect(await getRecord(db, rec)).toBeNull();
    expect(await getRecord(db, shared)).toBeNull();
  });

  it("does not expire a public check whose record is watched, and a record deleted with its checks does not protect its own key", async () => {
    const watched = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "w" }), evidence_key: "evidence/w.jpg" }));
    await markWatched(db, watched, true);
    await insertCheck(db, done({ id: "w", record_id: watched, started_at: ago(30), evidence_key: "evidence/w.jpg" }));
    const loose = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "l" }), evidence_key: "evidence/l.jpg" }));
    await insertCheck(db, done({ id: "l", record_id: loose, started_at: ago(30), evidence_key: "evidence/l.jpg" }));

    const out = await expirePublicChecks(db, ago(24));
    expect(out.ids).toEqual(["l"]);
    expect(out.evidenceKeys.sort()).toEqual(["evidence/l.jpg", "evidence/l.md"]);
    expect(await getCheck(db, "w")).not.toBeNull();
    expect(await getRecord(db, loose)).toBeNull();
  });

  it("returns no evidence keys for a check that had none, and nothing when nothing is old", async () => {
    await insertCheck(db, done({ id: "plain", started_at: ago(30), evidence_key: null }));
    expect(await expirePublicChecks(db, ago(24))).toEqual({ ids: ["plain"], evidenceKeys: [] });
    expect(await expirePublicChecks(db, ago(24))).toEqual({ ids: [], evidenceKeys: [] });
  });

  it("deletes a record's events with the record, and leaves the events of a record that stays", async () => {
    // An unwatched record (its watch was removed) whose only checks expire: record and events go.
    const gone = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "gone" }) }));
    await insertEvent(db, { record_id: gone, kind: "status_change", fields: ["status"], at: ago(40) });
    await insertEvent(db, { record_id: gone, kind: "recheck", at: ago(40) });
    await insertCheck(db, done({ id: "gone-check", record_id: gone, started_at: ago(30) }));
    // A record a curated check still references stays, and so do its events.
    const kept = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "kept" }) }));
    await insertEvent(db, { record_id: kept, kind: "status_change", fields: ["status"], at: ago(40) });
    await insertCheck(db, done({ id: "kept-curated", added_by: "curated", record_id: kept, started_at: ago(90) }));
    await insertCheck(db, done({ id: "kept-public", record_id: kept, started_at: ago(30) }));
    // A watched record's public check does not expire at all.
    const watched = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "watched" }) }));
    await markWatched(db, watched, true);
    await insertEvent(db, { record_id: watched, kind: "status_change", fields: ["status"], at: ago(40) });
    await insertCheck(db, done({ id: "watched-check", record_id: watched, started_at: ago(30) }));

    const out = await expirePublicChecks(db, ago(24));

    expect(out.ids.sort()).toEqual(["gone-check", "kept-public"]);
    expect(await getRecord(db, gone)).toBeNull();
    expect(await listEventsForRecord(db, gone)).toEqual([]);
    expect(await getRecord(db, kept)).not.toBeNull();
    expect(await listEventsForRecord(db, kept)).toHaveLength(1);
    expect(await getRecord(db, watched)).not.toBeNull();
    expect(await listEventsForRecord(db, watched)).toHaveLength(1);
    const orphans = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE record_id NOT IN (SELECT id FROM records)")
      .first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });

  it("handles more checks than D1 allows bound parameters in one statement", async () => {
    const statements = [];
    for (let i = 0; i < 150; i++) {
      statements.push(
        db
          .prepare(
            "INSERT INTO checks (id, state, added_by, started_at, evidence_key) VALUES (?, 'done', 'public', ?, ?)",
          )
          .bind(`bulk-${i}`, ago(30), `evidence/bulk-${i}.jpg`),
      );
    }
    await db.batch(statements);

    const out = await expirePublicChecks(db, ago(24));
    expect(out.ids).toHaveLength(150);
    expect(out.evidenceKeys).toHaveLength(300);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM checks").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("records", () => {
  it("upsertRecord inserts, then updates the same row by (registry, licence_number)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T09:00:00.000Z"));
    const id = await upsertRecord(
      db,
      recordInput({
        evidence_key: "evidence/c1.jpg",
        restrictions: ["No solo practice"],
        record: normalized({ registered_since: "1992-08-01", specialties: ["Infectious diseases"], raw_fields: { register: "GP" } }),
      }),
    );
    expect(await recordRow(id)).toMatchObject({
      id,
      registry: "gmc",
      record_type: "doctor",
      licence_number: "9360749",
      full_name: "Christopher John Marlow Wickfold",
      status: "active",
      status_raw: "Registered with a licence to practise",
      flags: "[]",
      disciplinary: "[]",
      source_url: "https://www.gmc-uk.org/registrants/9360749",
      evidence_key: "evidence/c1.jpg",
      watched: 0,
      first_seen_at: "2026-11-05T09:00:00.000Z",
      last_checked_at: "2026-11-05T09:00:00.000Z",
    });
    expect(JSON.parse((await recordRow(id)).fields ?? "null")).toEqual({
      registered_since: "1992-08-01",
      expiry_date: null,
      specialties: ["Infectious diseases"],
      restrictions: ["No solo practice"],
      raw: { register: "GP" },
    });

    await markWatched(db, id, true);
    vi.setSystemTime(new Date("2026-11-06T10:00:00.000Z"));
    const again = await upsertRecord(
      db,
      recordInput({
        source_url: "https://www.gmc-uk.org/registrants/9360749?x=1",
        record: normalized({
          status: "conditions",
          status_raw: "Registered with a licence to practise",
          flags: ["interim_order"],
          disciplinary: [{ date: "2026-10-01", summary: "Conditions imposed", source_url: null }],
        }),
      }),
    );
    vi.useRealTimers();

    expect(again).toBe(id);
    expect(await recordRow(id)).toMatchObject({
      status: "conditions",
      flags: '["interim_order"]',
      disciplinary: '[{"date":"2026-10-01","summary":"Conditions imposed","source_url":null}]',
      source_url: "https://www.gmc-uk.org/registrants/9360749?x=1",
      // untouched by a re-read
      watched: 1,
      first_seen_at: "2026-11-05T09:00:00.000Z",
      // refreshed
      last_checked_at: "2026-11-06T10:00:00.000Z",
      // not provided on the second call: kept
      evidence_key: "evidence/c1.jpg",
    });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM records").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("keeps the stored name when a re-read lacks it, and the stored number when updated by id", async () => {
    const id = await upsertRecord(db, recordInput());

    // Same number, no name on the page this time.
    const sameNumber = await upsertRecord(db, recordInput({ record: normalized({ full_name: null }) }));
    expect(sameNumber).toBe(id);
    expect((await recordRow(id)).full_name).toBe("Christopher John Marlow Wickfold");

    // A page that shows neither the name nor the number, re-read for a record we hold by id.
    const byId = await upsertRecord(
      db,
      recordInput({ id, record: normalized({ full_name: null, licence_number: null, status: "removed", status_raw: "Erased" }) }),
    );
    expect(byId).toBe(id);
    expect(await recordRow(id)).toMatchObject({
      full_name: "Christopher John Marlow Wickfold",
      licence_number: "9360749",
      status: "removed",
      status_raw: "Erased",
    });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM records").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("replaces the name and number when the page shows new ones", async () => {
    const id = await upsertRecord(db, recordInput());
    await upsertRecord(db, recordInput({ id, record: normalized({ full_name: "Chris Wickfold", licence_number: "9360749" }) }));
    expect((await recordRow(id)).full_name).toBe("Chris Wickfold");
  });

  it("treats the same number at another registry as another record, and a record with no number as always new", async () => {
    const a = await upsertRecord(db, recordInput());
    const b = await upsertRecord(db, recordInput({ registry: "companies-house", record_type: "company" }));
    expect(b).not.toBe(a);

    const n1 = await upsertRecord(db, recordInput({ registry: "nmc", record: normalized({ licence_number: null }) }));
    const n2 = await upsertRecord(db, recordInput({ registry: "nmc", record: normalized({ licence_number: null }) }));
    expect(n1).not.toBe(n2);
  });

  it("normalized_hash is a SHA-256 hex of the comparable fields only", async () => {
    const a = await upsertRecord(db, recordInput({ record: normalized({ raw_fields: { when: "Results of search on 5 Nov" } }) }));
    const hashA = (await recordRow(a)).normalized_hash;
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);

    await upsertRecord(db, recordInput({ record: normalized({ raw_fields: { when: "Results of search on 6 Nov" }, specialties: ["x"] }) }));
    expect((await recordRow(a)).normalized_hash).toBe(hashA);

    await upsertRecord(db, recordInput({ record: normalized({ status: "suspended", status_raw: "Suspended" }) }));
    expect((await recordRow(a)).normalized_hash).not.toBe(hashA);
  });

  it("markWatched flips the flag, and listWatchedAndCurated returns watched records and records of curated checks", async () => {
    const watched = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "1" }) }));
    const curated = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "2" }) }));
    const adminOnly = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "3" }) }));
    const plain = await upsertRecord(db, recordInput({ record: normalized({ licence_number: "4" }) }));
    await markWatched(db, watched, true);
    await insertCheck(db, done({ added_by: "curated", record_id: curated }));
    await insertCheck(db, done({ added_by: "admin", record_id: adminOnly }));
    await insertCheck(db, done({ added_by: "public", record_id: plain }));

    expect((await listWatchedAndCurated(db)).map((r) => r.id).sort()).toEqual([watched, curated].sort());

    await markWatched(db, watched, false);
    expect((await recordRow(watched)).watched).toBe(0);
    expect((await listWatchedAndCurated(db)).map((r) => r.id)).toEqual([curated]);
  });

  it("getRecord returns null for an unknown id", async () => {
    expect(await getRecord(db, "nope")).toBeNull();
  });
});

describe("recordDiff", () => {
  async function stored(over: Partial<NormalizedRecord> = {}): Promise<RecordRow> {
    return recordRow(await upsertRecord(db, recordInput({ record: normalized(over) })));
  }

  it("flags a new conditions block as a change in disciplinary, and in status if it moved", async () => {
    const before = await stored();
    const conditionsBlock = [{ date: "2026-10-01", summary: "Conditions: must not practise alone.", source_url: null }];

    expect(recordDiff(before, normalized({ disciplinary: conditionsBlock }))).toEqual({
      changed: true,
      fields: ["disciplinary"],
    });
    expect(recordDiff(before, normalized({ status: "conditions", disciplinary: conditionsBlock }))).toEqual({
      changed: true,
      fields: ["status", "disciplinary"],
    });
  });

  it("names exactly the fields that differ: status, flags, disciplinary, status_raw", async () => {
    const before = await stored();
    expect(recordDiff(before, normalized({ status: "suspended" })).fields).toEqual(["status"]);
    expect(recordDiff(before, normalized({ flags: ["under_review"] })).fields).toEqual(["flags"]);
    expect(recordDiff(before, normalized({ status_raw: "Registered without a licence to practise" })).fields).toEqual(["status_raw"]);
    expect(
      recordDiff(before, normalized({ status: "removed", flags: ["name_changed"], status_raw: "Erased" })).fields,
    ).toEqual(["status", "flags", "status_raw"]);
  });

  it("ignores everything that is not those four fields: timestamps, search text, specialties, raw fields, urls", async () => {
    const before = await stored({
      registered_since: "1992-08-01",
      specialties: ["Infectious diseases", "Tropical medicine"],
      raw_fields: { note: "Results of search on 5 November 2026 at 09:22" },
      disciplinary: [{ date: "2026-10-01", summary: "Conditions", source_url: "https://a" }],
    });
    const after = normalized({
      registered_since: "1992-08-01",
      expiry_date: "2027-01-01",
      specialties: ["Tropical medicine", "Infectious diseases"],
      raw_fields: { note: "Results of search on 6 November 2026 at 11:40" },
      conditions: [{ from: "2026-10-01", to: null, text: "Conditions" }],
      disciplinary: [{ date: "2026-10-01", summary: "Conditions", source_url: "https://b" }],
    });
    expect(recordDiff(before, after)).toEqual({ changed: false, fields: [] });
  });

  it("ignores whitespace in status_raw and in disciplinary summaries, and the order of flags and entries", async () => {
    const before = await stored({
      status_raw: "Registered with a licence to practise",
      flags: ["interim_order", "under_review"],
      disciplinary: [
        { date: "2026-10-01", summary: "Conditions imposed", source_url: null },
        { date: "2026-09-01", summary: "Warning issued", source_url: null },
      ],
    });
    const after = normalized({
      status_raw: "  Registered with a licence   to practise\n",
      flags: ["under_review", "interim_order"],
      disciplinary: [
        { date: "2026-09-01", summary: "Warning\n issued", source_url: null },
        { date: "2026-10-01", summary: "  Conditions   imposed ", source_url: null },
      ],
    });
    expect(recordDiff(before, after)).toEqual({ changed: false, fields: [] });
  });

  it("notices a changed date, a changed summary, a dropped entry, and a repeated entry", async () => {
    const entry = { date: "2026-10-01", summary: "Conditions imposed", source_url: null };
    const before = await stored({ disciplinary: [entry] });
    expect(recordDiff(before, normalized({ disciplinary: [{ ...entry, date: "2026-10-02" }] })).fields).toEqual(["disciplinary"]);
    expect(recordDiff(before, normalized({ disciplinary: [{ ...entry, summary: "Conditions lifted" }] })).fields).toEqual(["disciplinary"]);
    expect(recordDiff(before, normalized({ disciplinary: [] })).fields).toEqual(["disciplinary"]);
    expect(recordDiff(before, normalized({ disciplinary: [entry, entry] })).fields).toEqual(["disciplinary"]);
  });

  it("reads a stored row with null or malformed columns as empty rather than throwing", () => {
    const bare = {
      id: "r",
      registry: "gmc",
      record_type: "doctor",
      licence_number: "1",
      full_name: null,
      status: null,
      status_raw: null,
      flags: "not json",
      disciplinary: "[null, 3, {\"summary\": 7}]",
      fields: null,
      source_url: null,
      evidence_key: null,
      watched: 0,
      first_seen_at: null,
      last_checked_at: null,
      normalized_hash: null,
    } satisfies RecordRow;
    expect(recordDiff(bare, normalized({ status: "unknown", status_raw: null })).fields).toEqual(["status"]);
  });
});

describe("watches", () => {
  const watch = (over: Partial<Parameters<typeof insertWatch>[1]> = {}) => ({
    record_id: "rec-1",
    kind: "page" as const,
    monitor_id: "mon-1",
    added_by: "public" as const,
    callback_url: null,
    expires_at: ahead(24 * 7),
    ...over,
  });

  it("insertWatch generates the id, stamps created_at, defaults to active; the getters find it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T09:00:00.000Z"));
    const id = await insertWatch(db, watch({ callback_url: "https://example.com/hook" }));
    vi.useRealTimers();

    const row = await getWatch(db, id);
    expect(row).toEqual({
      id,
      record_id: "rec-1",
      kind: "page",
      monitor_id: "mon-1",
      added_by: "public",
      callback_url: "https://example.com/hook",
      expires_at: row?.expires_at,
      created_at: "2026-11-05T09:00:00.000Z",
      status: "active",
      ip_hash: null,
    });
    expect(await getWatchByMonitorId(db, "mon-1")).toEqual(row);
    expect(await getWatch(db, "nope")).toBeNull();
    expect(await getWatchByMonitorId(db, "nope")).toBeNull();
  });

  it("listWatches lists oldest first, and filters by record, status or who added it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T09:00:00.000Z"));
    const first = await insertWatch(db, watch({ record_id: "r1", monitor_id: "m1" }));
    vi.setSystemTime(new Date("2026-11-05T10:00:00.000Z"));
    const second = await insertWatch(db, watch({ record_id: "r2", monitor_id: "m2", added_by: "curated", expires_at: null }));
    vi.setSystemTime(new Date("2026-11-05T11:00:00.000Z"));
    const third = await insertWatch(db, watch({ record_id: "r1", monitor_id: "m3", status: "failed" }));
    vi.useRealTimers();

    expect((await listWatches(db)).map((w) => w.id)).toEqual([first, second, third]);
    expect((await listWatches(db, { recordId: "r1" })).map((w) => w.id)).toEqual([first, third]);
    expect((await listWatches(db, { status: "active" })).map((w) => w.id)).toEqual([first, second]);
    expect((await listWatches(db, { addedBy: "curated" })).map((w) => w.id)).toEqual([second]);
    expect(await listWatches(db, { recordId: "r1", status: "failed", addedBy: "public" })).toHaveLength(1);
  });

  it("countWatches counts only active watches, optionally per who added them (expired and failed hold no slot)", async () => {
    await insertWatch(db, watch({ monitor_id: "a", added_by: "curated", expires_at: null }));
    await insertWatch(db, watch({ monitor_id: "b", added_by: "public" }));
    await insertWatch(db, watch({ monitor_id: "c", added_by: "public", status: "expired" }));
    await insertWatch(db, watch({ monitor_id: "d", added_by: "public", status: "failed" }));
    await insertWatch(db, watch({ monitor_id: "e", added_by: "admin" }));

    expect(await countWatches(db)).toBe(3);
    expect(await countWatches(db, "public")).toBe(1);
    expect(await countWatches(db, "curated")).toBe(1);
    expect(await countWatches(db, "admin")).toBe(1);
  });

  it("expireWatches expires active public watches past their time, returns them, and does it once", async () => {
    const lapsed = await insertWatch(db, watch({ monitor_id: "lapsed", expires_at: ago(1) }));
    const lapsedToo = await insertWatch(db, watch({ monitor_id: "lapsed2", expires_at: ago(48) }));
    await insertWatch(db, watch({ monitor_id: "live", expires_at: ahead(5) }));
    await insertWatch(db, watch({ monitor_id: "curated", added_by: "curated", expires_at: ago(100) }));
    await insertWatch(db, watch({ monitor_id: "admin", added_by: "admin", expires_at: ago(100) }));
    await insertWatch(db, watch({ monitor_id: "no-end", expires_at: null }));
    await insertWatch(db, watch({ monitor_id: "gone", expires_at: ago(100), status: "failed" }));

    const expired = await expireWatches(db, new Date().toISOString());
    expect(expired.map((w) => w.id).sort()).toEqual([lapsed, lapsedToo].sort());
    expect(expired.every((w) => w.status === "expired")).toBe(true);
    expect((await getWatch(db, lapsed))?.status).toBe("expired");
    expect(await countWatches(db, "public")).toBe(2);
    expect(await countWatches(db, "curated")).toBe(1);

    expect(await expireWatches(db, new Date().toISOString())).toEqual([]);
  });

  it("stores and finds the shared regulator monitors, and putSharedMonitor replaces the monitor but keeps created_at", async () => {
    expect(await getSharedMonitor(db, "nmc")).toBeNull();
    expect(await listSharedMonitors(db)).toEqual([]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T09:00:00.000Z"));
    await putSharedMonitor(db, { registry: "sra", monitor_id: "mon-sra", url: "https://sra.example/decisions" });
    await putSharedMonitor(db, { registry: "nmc", monitor_id: "mon-nmc", url: "https://nmc.example/hearings" });
    vi.setSystemTime(new Date("2026-11-06T09:00:00.000Z"));
    await putSharedMonitor(db, { registry: "nmc", monitor_id: "mon-nmc-2", url: "https://nmc.example/hearings" });
    vi.useRealTimers();

    expect(await getSharedMonitor(db, "nmc")).toEqual({
      registry: "nmc",
      monitor_id: "mon-nmc-2",
      url: "https://nmc.example/hearings",
      created_at: "2026-11-05T09:00:00.000Z",
    });
    expect((await getSharedMonitorByMonitorId(db, "mon-sra"))?.registry).toBe("sra");
    expect(await getSharedMonitorByMonitorId(db, "mon-nmc")).toBeNull();
    expect((await listSharedMonitors(db)).map((m) => m.registry)).toEqual(["nmc", "sra"]);
  });
});

describe("events", () => {
  async function visibleRecord(licence: string, how: "watched" | "curated" | "plain" | "admin"): Promise<string> {
    const id = await upsertRecord(db, recordInput({ record: normalized({ licence_number: licence }) }));
    if (how === "watched") await markWatched(db, id, true);
    if (how === "curated") await insertCheck(db, done({ added_by: "curated", record_id: id }));
    if (how === "admin") await insertCheck(db, done({ added_by: "admin", record_id: id }));
    if (how === "plain") await insertCheck(db, done({ added_by: "public", record_id: id }));
    return id;
  }

  it("insertEvent stringifies fields, before and after, and defaults at to now", async () => {
    const rec = await visibleRecord("1", "watched");
    const id = await insertEvent(db, {
      record_id: rec,
      kind: "status_change",
      fields: ["status", "disciplinary"],
      before: { status: "active" },
      after: { status: "conditions" },
      source_url: "https://r/1",
      monitor_run_id: "mrun-1",
    });
    const [row] = await listEventsForRecord(db, rec);
    expect(row).toMatchObject({
      id,
      record_id: rec,
      kind: "status_change",
      fields: '["status","disciplinary"]',
      before: '{"status":"active"}',
      after: '{"status":"conditions"}',
      source_url: "https://r/1",
      monitor_run_id: "mrun-1",
      notified_at: null,
    });
    expect(Date.now() - Date.parse(row?.at ?? "")).toBeLessThan(60_000);

    const bare = await insertEvent(db, { record_id: rec, kind: "notice", source_url: "https://news/1" });
    const rows = await listEventsForRecord(db, rec);
    expect(rows.find((r) => r.id === bare)).toMatchObject({ fields: "[]", before: null, after: null });
  });

  it("listEvents returns only events of watched or curated records, newest first", async () => {
    const watched = await visibleRecord("1", "watched");
    const curated = await visibleRecord("2", "curated");
    const plain = await visibleRecord("3", "plain");
    const admin = await visibleRecord("4", "admin");
    const e1 = await insertEvent(db, { record_id: watched, kind: "status_change", at: ago(5) });
    const e2 = await insertEvent(db, { record_id: curated, kind: "notice", at: ago(3) });
    await insertEvent(db, { record_id: plain, kind: "status_change", at: ago(4) });
    await insertEvent(db, { record_id: admin, kind: "status_change", at: ago(2) });
    await insertEvent(db, { record_id: "ghost-record", kind: "status_change", at: ago(1) });
    const e3 = await insertEvent(db, { record_id: watched, kind: "recheck", at: ago(1) });

    expect((await listEvents(db, null, 50)).map((e) => e.id)).toEqual([e3, e2, e1]);

    // Un-watch it and its events leave the feed (they stay on the record).
    await markWatched(db, watched, false);
    expect((await listEvents(db, null, 50)).map((e) => e.id)).toEqual([e2]);
    expect(await listEventsForRecord(db, watched)).toHaveLength(2);
  });

  it("listEvents honours since (inclusive) and limit, and a bad limit never means no limit", async () => {
    const rec = await visibleRecord("1", "watched");
    const times = [10, 8, 6, 4].map((h) => ago(h));
    const ids = [] as string[];
    for (const at of times) ids.push(await insertEvent(db, { record_id: rec, kind: "recheck", at }));

    // The event at exactly the since time is included.
    expect((await listEvents(db, times[2] ?? null, 50)).map((e) => e.id)).toEqual([ids[3], ids[2]]);
    expect((await listEvents(db, null, 2)).map((e) => e.id)).toEqual([ids[3], ids[2]]);
    expect(await listEvents(db, null, 0)).toEqual([]);
    expect(await listEvents(db, null, -3)).toEqual([]);
    expect(await listEvents(db, null, Number.NaN)).toEqual([]);
  });

  it("listEventsForRecord returns that record's events, newest first, and none for another", async () => {
    const a = await visibleRecord("1", "watched");
    const b = await visibleRecord("2", "watched");
    const old = await insertEvent(db, { record_id: a, kind: "recheck", at: ago(5) });
    const recent = await insertEvent(db, { record_id: a, kind: "status_change", at: ago(1) });
    await insertEvent(db, { record_id: b, kind: "recheck", at: ago(2) });
    expect((await listEventsForRecord(db, a)).map((e) => e.id)).toEqual([recent, old]);
    expect(await listEventsForRecord(db, "nobody")).toEqual([]);
  });
});

describe("publicUse", () => {
  it("bump creates the day's row on first use and counts each field apart", async () => {
    expect(await today(db, "ip1")).toEqual({ checks: 0, watches: 0, discovers: 0 });

    expect(await bump(db, "ip1", "checks")).toEqual({ checks: 1, watches: 0, discovers: 0 });
    await bump(db, "ip1", "checks");
    await bump(db, "ip1", "watches");
    await bump(db, "ip1", "discovers");
    await bump(db, "ip1", "discovers");
    await bump(db, "ip1", "discovers");

    expect(await today(db, "ip1")).toEqual({ checks: 2, watches: 1, discovers: 3 });
    expect(await today(db, "ip2")).toEqual({ checks: 0, watches: 0, discovers: 0 });
  });

  it("counts per visitor and per UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T23:59:30.000Z"));
    await bump(db, "ip1", "checks");
    await bump(db, "ip2", "checks");
    expect(await today(db, "ip1")).toEqual({ checks: 1, watches: 0, discovers: 0 });

    vi.setSystemTime(new Date("2026-11-06T00:00:30.000Z"));
    expect(await today(db, "ip1")).toEqual({ checks: 0, watches: 0, discovers: 0 });
    await bump(db, "ip1", "checks");
    expect(await today(db, "ip1")).toEqual({ checks: 1, watches: 0, discovers: 0 });
    vi.useRealTimers();

    const days = await db.prepare("SELECT day FROM public_use WHERE ip_hash = 'ip1' ORDER BY day").all<{ day: string }>();
    expect(days.results.map((r) => r.day)).toEqual(["2026-11-05", "2026-11-06"]);
  });

  it("rejects a field that is not one of the three counters", async () => {
    await expect(bump(db, "ip1", "checks; DROP TABLE public_use" as never)).rejects.toThrow();
    expect(await today(db, "ip1")).toEqual({ checks: 0, watches: 0, discovers: 0 });
  });
});
