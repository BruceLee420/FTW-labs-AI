-- Studio Drop review queue.
--
-- One row per dropped piece that is eligible to be listed. Sketches and WIPs
-- never land here — only an explicit "final" does.
--
-- The queue is the source of truth for the auto-deploy timer, so it must live
-- server-side: a countdown that only runs in the browser stops the moment the
-- tab closes, which defeats the entire point of dropping art and walking away.

CREATE TABLE IF NOT EXISTS queue (
  id              TEXT PRIMARY KEY,
  r2_key          TEXT NOT NULL UNIQUE,
  stage           TEXT NOT NULL,

  -- Drafted copy. Editable before AND after publishing.
  title           TEXT,
  description     TEXT,
  tags            TEXT,               -- comma-separated
  price_cents     INTEGER,
  currency        TEXT DEFAULT 'USD',

  -- Costing, so the margin floor can be enforced without a provider round-trip
  -- at publish time.
  base_cost_cents INTEGER,
  margin_floor_pct INTEGER DEFAULT 21,

  -- queued | held | publishing | published | failed | cancelled
  status          TEXT NOT NULL DEFAULT 'queued',
  hold_reasons    TEXT,               -- JSON array; non-empty forces manual review

  -- Auto-deploy control.
  publish_after   INTEGER,            -- unix seconds; NULL = never auto-publish
  paused          INTEGER NOT NULL DEFAULT 0,

  -- Set once live, so edits afterwards can re-publish in place rather than
  -- creating a duplicate listing.
  external_id     TEXT,
  external_url    TEXT,

  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  published_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_queue_due
  ON queue (status, paused, publish_after);

CREATE INDEX IF NOT EXISTS idx_queue_created
  ON queue (created_at DESC);

-- Append-only trail of what happened and who caused it. Useful when a listing
-- goes live and you want to know whether you edited it or the timer fired.
CREATE TABLE IF NOT EXISTS queue_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id   TEXT NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT,
  actor      TEXT,                    -- email, or 'system' for the cron
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_queue ON queue_events (queue_id, created_at DESC);
