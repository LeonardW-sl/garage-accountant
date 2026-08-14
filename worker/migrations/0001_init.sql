-- 汽修记账助手 schema
-- Design note: spoken_name is what the mechanic said, NEVER rewritten, always
-- what gets read back aloud. canonical_id is a backend-only best-effort match
-- and may stay NULL forever without hurting anything.

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,        -- client-generated UUID, enables offline-first
  device_id     TEXT NOT NULL,
  plate         TEXT,                    -- nullable: mechanic may skip the plate
  plate_photo   TEXT,                    -- R2 object key
  customer_id   TEXT,
  note          TEXT,
  total_cost    INTEGER NOT NULL DEFAULT 0,   -- fen (cents), never float
  total_charge  INTEGER NOT NULL DEFAULT 0,
  settled       INTEGER NOT NULL DEFAULT 0,   -- 0=unpaid 1=paid
  created_at    INTEGER NOT NULL,             -- epoch ms, from the device
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER                       -- soft delete, sync-safe
);

CREATE INDEX IF NOT EXISTS idx_jobs_created  ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_plate    ON jobs(plate);
CREATE INDEX IF NOT EXISTS idx_jobs_sync     ON jobs(device_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);

CREATE TABLE IF NOT EXISTS job_items (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  spoken_name  TEXT NOT NULL,           -- verbatim, never corrected
  canonical_id TEXT,                    -- nullable forever
  qty          INTEGER NOT NULL DEFAULT 1,
  cost         INTEGER NOT NULL DEFAULT 0,  -- fen
  charge       INTEGER NOT NULL DEFAULT 0,  -- fen
  seq          INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_job ON job_items(job_id, seq);

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  name        TEXT,
  phone       TEXT,
  wechat_qr   TEXT,                     -- R2 key of the scanned QR screenshot
  wechat_id   TEXT,
  plates      TEXT,                     -- JSON array of known plates
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cust_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_cust_sync  ON customers(device_id, updated_at);

-- Part-name dictionary: grows from real usage, powers fuzzy match of spoken names.
CREATE TABLE IF NOT EXISTS parts (
  id          TEXT PRIMARY KEY,
  canonical   TEXT NOT NULL,
  aliases     TEXT,                     -- JSON array, includes ASR mis-hearings
  last_cost   INTEGER,
  last_charge INTEGER,
  use_count   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_canonical ON parts(canonical);
