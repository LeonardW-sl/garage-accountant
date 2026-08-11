-- Align storage with the confirmed product contract.
-- Shipping stays separate in storage even though the UI shows it merged into cost.
ALTER TABLE job_items ADD COLUMN shipping INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_cust_phone;
ALTER TABLE customers RENAME TO customers_v1;

CREATE TABLE customers (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL,
  wechat_qr    TEXT,
  avatar_photo TEXT,
  openid       TEXT,
  plates       TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

INSERT INTO customers (
  id, device_id, wechat_qr, plates, note, created_at, updated_at, deleted_at
)
SELECT id, device_id, wechat_qr, plates, note, created_at, updated_at, deleted_at
FROM customers_v1;

DROP TABLE customers_v1;
CREATE INDEX idx_cust_sync ON customers(device_id, updated_at);
CREATE UNIQUE INDEX idx_cust_openid ON customers(openid) WHERE openid IS NOT NULL;

ALTER TABLE parts RENAME TO parts_v1;

CREATE TABLE parts (
  id         TEXT PRIMARY KEY,
  canonical  TEXT NOT NULL,
  aliases    TEXT,
  use_count  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT INTO parts (id, canonical, aliases, use_count, updated_at)
SELECT id, canonical, aliases, use_count, updated_at FROM parts_v1;

DROP TABLE parts_v1;
CREATE UNIQUE INDEX idx_parts_canonical ON parts(canonical);
