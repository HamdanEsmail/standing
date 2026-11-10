-- Standing schema. Timestamps are ISO 8601 UTC strings; ids are UUIDs.
-- JSON columns hold text produced by JSON.stringify; arrays default to '[]'.
-- A CHECK on a nullable column passes for NULL, so columns that are empty
-- while a check is pending (outcome, status, method) still carry the enum.

-- One row per lookup. `state` is the lifecycle (pending, then done);
-- `status` is the normalized record status the check found, and is null
-- unless `outcome` is 'match'.
CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done')),
  registry TEXT,
  record_type TEXT,
  jurisdiction TEXT,
  profession TEXT,
  query_raw TEXT,
  query_normalized TEXT,
  number TEXT,
  cache_key TEXT,
  variants_tried TEXT NOT NULL DEFAULT '[]',
  outcome TEXT CHECK (outcome IN ('match', 'ambiguous', 'no_match', 'unsupported', 'error')),
  status TEXT CHECK (status IN ('active', 'conditions', 'suspended', 'removed', 'not_licensed', 'expired', 'dissolved', 'insolvency', 'unknown')),
  flags TEXT NOT NULL DEFAULT '[]',
  record_id TEXT,
  run_id TEXT,
  method TEXT CHECK (method IN ('agent', 'fetch')),
  cached_from_check_id TEXT,
  evidence_key TEXT,
  spend_usd REAL,
  callback_url TEXT,
  candidates_total INTEGER,
  suggestions TEXT NOT NULL DEFAULT '[]',
  trigger TEXT NOT NULL DEFAULT 'request' CHECK (trigger IN ('request', 'monitor')),
  monitor_run_id TEXT,
  ip_hash TEXT,
  added_by TEXT CHECK (added_by IN ('public', 'admin', 'curated')),
  expires_at TEXT,
  started_at TEXT,
  checked_at TEXT,
  error TEXT
);
CREATE INDEX idx_checks_cache_key_checked ON checks (cache_key, checked_at);
-- The feed, the purge and the cache look checks up by the record they read.
CREATE INDEX idx_checks_record ON checks (record_id);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  registry TEXT,
  record_type TEXT,
  licence_number TEXT,
  full_name TEXT,
  status TEXT CHECK (status IN ('active', 'conditions', 'suspended', 'removed', 'not_licensed', 'expired', 'dissolved', 'insolvency', 'unknown')),
  status_raw TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  disciplinary TEXT NOT NULL DEFAULT '[]',
  fields TEXT,
  source_url TEXT,
  evidence_key TEXT,
  watched INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,
  last_checked_at TEXT,
  normalized_hash TEXT
);
-- Unique, so upsertRecord can use ON CONFLICT. SQLite allows several NULL numbers under a UNIQUE
-- index, so a record with no number is always a new row.
CREATE UNIQUE INDEX idx_records_registry_licence ON records (registry, licence_number);

-- The rows a registry search returned for an ambiguous check.
CREATE TABLE candidates (
  check_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  licence_number TEXT,
  full_name TEXT,
  status_raw TEXT,
  detail TEXT,
  source_url TEXT,
  PRIMARY KEY (check_id, position)
);

CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  record_id TEXT,
  kind TEXT CHECK (kind IN ('page', 'topic')),
  monitor_id TEXT,
  added_by TEXT CHECK (added_by IN ('curated', 'public', 'admin')),
  callback_url TEXT,
  expires_at TEXT,
  created_at TEXT,
  status TEXT,
  -- The public caller who created the watch (the same hash as checks.ip_hash), so only they or the
  -- admin can remove it. Null for admin and curated watches.
  ip_hash TEXT
);
CREATE INDEX idx_watches_monitor ON watches (monitor_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  record_id TEXT,
  kind TEXT CHECK (kind IN ('status_change', 'notice', 'recheck')),
  fields TEXT NOT NULL DEFAULT '[]',
  before TEXT,
  after TEXT,
  source_url TEXT,
  monitor_run_id TEXT,
  notified_at TEXT,
  at TEXT
);
CREATE INDEX idx_events_record_at ON events (record_id, at);

-- Regulator decision-page monitors shared by every watch (NMC, SRA).
CREATE TABLE monitors_shared (
  registry TEXT PRIMARY KEY,
  monitor_id TEXT,
  url TEXT,
  created_at TEXT
);

CREATE TABLE spend (
  id TEXT PRIMARY KEY,
  kind TEXT,
  amount_usd REAL,
  ref TEXT,
  at TEXT
);

-- Per-visitor daily counters for the public rate limits.
CREATE TABLE public_use (
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  watches INTEGER NOT NULL DEFAULT 0,
  discovers INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);

-- The one TinyAgent run Standing keeps in flight (one run at a time keeps spend and the load on the registers predictable, and the account's
-- concurrent runs are few). One row, always present: the check holding the slot and since
-- when. A holder older than AGENT_SLOT_STALE_MINUTES no longer blocks (src/checks/slot.ts).
CREATE TABLE agent_slot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder_check_id TEXT,
  since TEXT
);
INSERT INTO agent_slot (id) VALUES (1);
