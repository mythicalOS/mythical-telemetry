-- SPIKE — the collector's CURRENT table shape, expressed as a D1 migration.
--
-- This is deliberately NOT a port of `collector/src/migrate.ts`. That module is
-- a transactional REBUILD: it detects a pre-product table by its primary key
-- inside an IMMEDIATE transaction, copies every row into a new table,
-- backfills `product`, and aborts if the copy would carry fewer rows than it
-- found. None of that is expressible here, and none of it is NEEDED here — a D1
-- database is created empty, so the legacy shape it upgrades from cannot exist.
--
-- The consequence is recorded rather than hidden: an existing SQLite volume
-- cannot be brought to D1 by running this. It would have to be exported and
-- reloaded, and the rebuild logic (and its row-conservation guard) has no home
-- in the D1 world. See the spike report.
--
-- `PRAGMA user_version` is not set: D1 tracks applied migrations in its own
-- `d1_migrations` table, which is the mechanism that replaces the user_version
-- marker. `SCHEMA_USER_VERSION` and `FIRST_REPORT_BACKFILL` become dead
-- concepts on D1.

CREATE TABLE IF NOT EXISTS heartbeats (
  instance_id    TEXT NOT NULL,
  product        TEXT NOT NULL,
  day            TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload        TEXT NOT NULL,
  received_day   TEXT NOT NULL,
  PRIMARY KEY (instance_id, product, day)
);

CREATE TABLE IF NOT EXISTS instances (
  instance_id      TEXT NOT NULL,
  product          TEXT NOT NULL,
  first_seen_day   TEXT NOT NULL,
  last_seen_day    TEXT NOT NULL,
  first_report_day TEXT,
  PRIMARY KEY (instance_id, product)
);

CREATE TABLE IF NOT EXISTS admissions (
  day      TEXT PRIMARY KEY,
  admitted INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_product_day ON heartbeats (product, day);
CREATE INDEX IF NOT EXISTS idx_heartbeats_received_day ON heartbeats (received_day);
CREATE INDEX IF NOT EXISTS idx_instances_product ON instances (product);
CREATE INDEX IF NOT EXISTS idx_instances_first_seen ON instances (first_seen_day);
