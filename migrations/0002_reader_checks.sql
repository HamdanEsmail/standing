-- The daily reader check (src/readerCheck.ts). Once a UTC day Standing reads one known business
-- record on each register it reads with Fetch, to see that its own reader still understands the
-- page. It is not a lookup and not a watch: no check, record, event or watch reads this table, and
-- nothing here is read again for anyone.
--
-- One row per register per UTC day, written before the page is read, so a register is tried once
-- a day whatever happens. `outcome` stays 'started' when the read never finished.
CREATE TABLE reader_checks (
  registry TEXT NOT NULL,
  day TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'started' CHECK (outcome IN ('started', 'understood', 'no_answer', 'not_understood')),
  -- understood: the status text the page showed; no_answer: Fetch's own code; not_understood: what was missing
  detail TEXT,
  source_url TEXT,
  PRIMARY KEY (registry, day)
);
