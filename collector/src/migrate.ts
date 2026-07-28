// Schema migration (plan §11).
//
// The store gained a product dimension: the primary key moved from
// (instance_id, day) to (instance_id, product, day). `CREATE TABLE IF NOT
// EXISTS` cannot express that — it neither adds a column nor changes a primary
// key — so an operator reusing an existing volume would get `no such column:
// product`, or, worse, silently keep the collision in which one product's
// heartbeat overwrites another's for the same day.
//
// What ships instead is a transactional rebuild:
//
//   • every existing row is carried over and backfilled as product `brokkr`
//     (the only product that could have written to a pre-product database);
//   • the whole thing runs inside one IMMEDIATE transaction, so it either
//     lands completely or not at all, and a second process booting against the
//     same file waits rather than racing;
//   • state is detected from the actual table shape INSIDE that transaction,
//     never from `PRAGMA user_version` alone, so re-running is a no-op and a
//     hand-edited version marker cannot skip a rebuild that is genuinely
//     needed.
//
// A STORED PAYLOAD IS NEVER REWRITTEN. There is one heartbeat schema, so there
// is no at-rest conversion to perform and no second shape the read path has to
// handle; the migration moves rows between table definitions and touches the
// document text not at all.
//
// NO ROW IS DROPPED either. A payload that cannot be parsed is carried over
// verbatim, never discarded, and a rebuild that would carry fewer rows than it
// found aborts the whole transaction instead of completing.
//
// That guarantee is about ROWS, and deliberately not about schema objects
// ATTACHED to the rebuilt tables. A rebuild is `DROP TABLE` + `RENAME`, and
// SQLite drops a table's triggers and indexes with it; this code recreates its
// own indexes (INDEX_DDL, below) but cannot recreate objects it never
// declared. Nothing in this service's schema history — current or
// pre-product — defines a trigger or a view, so there is nothing of ours to
// lose; an operator who has hand-added one to a collector volume must
// recreate it after an upgrade. Recorded here rather than solved, because
// preserving arbitrary operator DDL across a rebuild is a much larger promise
// than this store needs to make.

import type { Database } from 'bun:sqlite';

/**
 * Bumped when the TABLE shape changes.
 *
 * This is SQLite's `PRAGMA user_version` for this store's DDL and has nothing
 * to do with the heartbeat schema version — the two numbers are independent and
 * must not be conflated. Lowering it would make a current volume look
 * un-migrated on the next boot.
 */
export const SCHEMA_USER_VERSION = 2;

/**
 * Bumped when `instances.first_report_day` needs (re)deriving for existing rows.
 *
 * That column records the day of an identity's FIRST heartbeat, which is the
 * one day that is not a one-day delta: a counter with no prior snapshot emits
 * its whole lifetime value, so an install that ran for months before telemetry
 * was switched on reports months of accumulation as a single day. The read
 * path must not average that row in — see `foldRates` — and it can only do so
 * if the day is recorded durably. Deriving it from whatever happens to be in
 * the window would break the moment retention pruned the real first day.
 */
export const FIRST_REPORT_BACKFILL = 1;
const FIRST_REPORT_KEY = 'first_report_backfill';

/** The product every pre-product row is backfilled as. */
export const LEGACY_PRODUCT = 'brokkr';

export interface MigrationReport {
  /** `user_version` found before anything ran. */
  fromUserVersion: number;
  /** Tables were absent and created fresh (no data to carry). */
  createdFresh: boolean;
  /** A table lacking `product` was rebuilt. */
  rebuiltHeartbeats: boolean;
  rebuiltInstances: boolean;
  /** Rows carried across the rebuild. */
  heartbeatRowsCarried: number;
  instanceRowsCarried: number;
  /** The admission ledger was created and back-filled from existing rows. */
  admissionsSeeded: boolean;
  /** `instances.first_report_day` was added to an existing table. */
  addedFirstReportColumn: boolean;
  /** Rows whose first-report day was derived from surviving heartbeats. */
  firstReportBackfilled: number;
}

const HEARTBEATS_DDL = `
  CREATE TABLE IF NOT EXISTS heartbeats (
    instance_id    TEXT NOT NULL,
    product        TEXT NOT NULL,
    day            TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    payload        TEXT NOT NULL,
    received_day   TEXT NOT NULL,
    PRIMARY KEY (instance_id, product, day)
  );
`;

// `first_report_day` is NULLABLE on purpose: a row carried over from a
// pre-column database whose heartbeats have all been pruned has no derivable
// first day, and NULL says "unknown" honestly. It is never filled in later
// from a subsequent heartbeat — that would mark an ordinary day as the
// first-report day and wrongly exclude it from every rate.
const INSTANCES_DDL = `
  CREATE TABLE IF NOT EXISTS instances (
    instance_id      TEXT NOT NULL,
    product          TEXT NOT NULL,
    first_seen_day   TEXT NOT NULL,
    last_seen_day    TEXT NOT NULL,
    first_report_day TEXT,
    PRIMARY KEY (instance_id, product)
  );
`;

// The admission ledger: one row per UTC day, counting identities admitted for
// the FIRST time on that day. It is deliberately NOT derived from
// `instances.first_seen_day`, because that count falls again when an
// installation exercises its right to delete — so mint, delete, repeat would
// have bought unlimited admissions against the daily budget. The ledger is
// only ever incremented.
const ADMISSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS admissions (
    day      TEXT PRIMARY KEY,
    admitted INTEGER NOT NULL
  );
`;

// Durable markers this code owns. Separate from `PRAGMA user_version`, which
// an operator or an older script may have set by hand.
const META_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// `idx_heartbeats_received_day` serves the retention clock: the daily prune
// deletes on `received_day`, and without it that is a full scan of every
// heartbeat ever stored. Added with the clock itself (2026-07) — an index is not
// a schema shape, so it needs no user_version bump and no rebuild: this DDL is
// idempotent and runs on every boot, so an existing volume simply gains it.
const INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_heartbeats_product_day ON heartbeats (product, day);
  CREATE INDEX IF NOT EXISTS idx_heartbeats_received_day ON heartbeats (received_day);
  CREATE INDEX IF NOT EXISTS idx_instances_product ON instances (product);
  CREATE INDEX IF NOT EXISTS idx_instances_first_seen ON instances (first_seen_day);
`;

/**
 * Does this table exist, under any casing?
 *
 * `COLLATE NOCASE` for the same reason the column lookup folds case: SQLite
 * treats `Heartbeats` and `heartbeats` as one table, so a case-sensitive
 * comparison here would report a legacy table as absent, skip its rebuild
 * entirely, and leave the service querying a `product` column that does not
 * exist. Every statement elsewhere names tables in fixed lowercase, which
 * SQLite resolves to whatever casing was declared.
 */
function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1 COLLATE NOCASE",
    )
    .get(name);
  return (row?.n ?? 0) > 0;
}

/**
 * Column names, ASCII-lowercased.
 *
 * SQLite identifiers are case-INSENSITIVE, but `PRAGMA table_info` reports the
 * casing as declared. Comparing those verbatim means a table declared with
 * `PRODUCT` reads as having no product column — it would be rebuilt
 * needlessly, and worse, the rebuild would then treat its real product values
 * as absent and overwrite every one of them with the legacy default. Folding
 * case makes the comparison agree with what SQLite itself considers the same
 * column. The SQL below only ever uses fixed lowercase identifiers, which
 * SQLite matches whatever the declaration said.
 */
function columnNames(db: Database, table: string): string[] {
  // PRAGMA takes no bound parameters; `table` is never user input — it is one
  // of the literals below.
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return rows.map((r) => r.name.toLowerCase());
}

/** The table's primary-key columns, in key order, lowercased. Empty when it has none. */
function primaryKeyColumns(db: Database, table: string): string[] {
  const rows = db.query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`).all();
  return rows
    .filter((r) => r.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((r) => r.name.toLowerCase());
}

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((name, i) => actual[i] === name);
}

const HEARTBEATS_KEY = ['instance_id', 'product', 'day'] as const;
const INSTANCES_KEY = ['instance_id', 'product'] as const;

/** A meta marker as an integer; 0 when absent or unreadable. */
function readMetaInt(db: Database, key: string): number {
  if (!tableExists(db, 'meta')) return 0;
  const row = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?1').get(key);
  const n = Number(row?.value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function writeMeta(db: Database, key: string, value: string): void {
  db.query('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
}

/**
 * Bring the database up to the current shape. Safe to call on every boot:
 * idempotent, and a no-op once the shape is current.
 */
export function migrate(db: Database): MigrationReport {
  const report: MigrationReport = {
    fromUserVersion: userVersion(db),
    createdFresh: false,
    rebuiltHeartbeats: false,
    rebuiltInstances: false,
    heartbeatRowsCarried: 0,
    instanceRowsCarried: 0,
    admissionsSeeded: false,
    addedFirstReportColumn: false,
    firstReportBackfilled: 0,
  };

  // IMMEDIATE takes the write lock up front, so a second process booting on
  // the same file blocks here (busy_timeout) instead of reading a stale shape
  // and deciding to rebuild a table the winner already rebuilt.
  db.exec('BEGIN IMMEDIATE');
  try {
    // Detection happens INSIDE the transaction — see above.
    const hasHeartbeats = tableExists(db, 'heartbeats');
    const hasInstances = tableExists(db, 'instances');
    // Detection is on the PRIMARY KEY, not merely on the column's presence.
    // `ALTER TABLE ... ADD COLUMN product` is the obvious hand-upgrade, and it
    // leaves the legacy key in place — a database that looks converted but
    // whose `ON CONFLICT (instance_id, product, day)` matches no constraint,
    // so the service cannot even prepare its statements. Keying off the
    // constraint that actually has to exist catches that.
    const heartbeatsNeedsProduct =
      hasHeartbeats && !sameColumns(primaryKeyColumns(db, 'heartbeats'), HEARTBEATS_KEY);
    const instancesNeedsProduct =
      hasInstances && !sameColumns(primaryKeyColumns(db, 'instances'), INSTANCES_KEY);

    if (!hasHeartbeats && !hasInstances) report.createdFresh = true;

    if (heartbeatsNeedsProduct) {
      report.heartbeatRowsCarried = rebuildHeartbeats(db);
      report.rebuiltHeartbeats = true;
    }
    if (instancesNeedsProduct) {
      report.instanceRowsCarried = rebuildInstances(db);
      report.rebuiltInstances = true;
    }

    // Creates anything still missing (fresh database, or only one table
    // present). Never touches a table that already exists.
    const hadAdmissions = tableExists(db, 'admissions');
    db.exec(HEARTBEATS_DDL);
    db.exec(INSTANCES_DDL);
    db.exec(ADMISSIONS_DDL);
    db.exec(META_DDL);

    // Additive column for a database that already has `product` but predates
    // the first-report rule. ADD COLUMN is cheap and does not rewrite rows.
    if (!columnNames(db, 'instances').includes('first_report_day')) {
      db.exec('ALTER TABLE instances ADD COLUMN first_report_day TEXT');
      report.addedFirstReportColumn = true;
    }
    db.exec(INDEX_DDL);

    // Seed the ledger from what is already stored, so upgrading does not hand
    // today's budget back in full. `INSERT OR IGNORE` keeps this a one-shot.
    if (!hadAdmissions) {
      db.exec(
        `INSERT OR IGNORE INTO admissions (day, admitted)
         SELECT first_seen_day, COUNT(*) FROM instances GROUP BY first_seen_day`,
      );
      report.admissionsSeeded = true;
    }

    // Derive the first-report day for rows that predate the column. MIN(day)
    // over the surviving heartbeats is the best evidence available; where no
    // heartbeat survives, the value stays NULL rather than being guessed.
    if (readMetaInt(db, FIRST_REPORT_KEY) < FIRST_REPORT_BACKFILL) {
      report.firstReportBackfilled = db
        .query(`
          UPDATE instances SET first_report_day = (
            SELECT MIN(h.day) FROM heartbeats h
            WHERE h.instance_id = instances.instance_id AND h.product = instances.product
          ) WHERE first_report_day IS NULL
        `)
        .run().changes;
    }
    writeMeta(db, FIRST_REPORT_KEY, String(FIRST_REPORT_BACKFILL));

    db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed ROLLBACK means the transaction was already resolved; the
      // original error is what matters.
    }
    throw err;
  }

  return report;
}

/**
 * Rebuild `heartbeats` with the product column and the three-part primary key.
 *
 * `(instance_id, day)` was already unique, so `(instance_id, 'brokkr', day)`
 * cannot collide — every old row survives the copy. Returns rows carried.
 */
function rebuildHeartbeats(db: Database): number {
  db.exec('DROP TABLE IF EXISTS heartbeats_migration_tmp');
  db.exec(`
    CREATE TABLE heartbeats_migration_tmp (
      instance_id    TEXT NOT NULL,
      product        TEXT NOT NULL,
      day            TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload        TEXT NOT NULL,
      received_day   TEXT NOT NULL,
      PRIMARY KEY (instance_id, product, day)
    );
  `);
  const before = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM heartbeats').get()?.n ?? 0;
  // A half-upgraded table may already carry product VALUES under the legacy
  // key. Those are real data — keep them, and backfill only what is missing.
  const productExpr = columnNames(db, 'heartbeats').includes('product')
    ? "COALESCE(NULLIF(product, ''), ?1)"
    : '?1';
  db.query(
    `INSERT INTO heartbeats_migration_tmp (instance_id, product, day, schema_version, payload, received_day)
     SELECT instance_id, ${productExpr}, day, schema_version, payload, received_day FROM heartbeats`,
  ).run(LEGACY_PRODUCT);
  const after = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM heartbeats_migration_tmp').get()?.n ?? 0;
  if (after !== before) {
    // `(instance_id, day)` was already unique, so adding a third key component
    // cannot collide. A shortfall means the source table's constraints were
    // not what they appeared to be — abort rather than silently lose rows.
    throw new Error(`migration would lose heartbeat rows: ${before} before, ${after} after`);
  }
  db.exec('DROP TABLE heartbeats');
  db.exec('ALTER TABLE heartbeats_migration_tmp RENAME TO heartbeats');
  return after;
}

/** Rebuild `instances` with the product column and the two-part primary key. */
function rebuildInstances(db: Database): number {
  db.exec('DROP TABLE IF EXISTS instances_migration_tmp');
  db.exec(`
    CREATE TABLE instances_migration_tmp (
      instance_id      TEXT NOT NULL,
      product          TEXT NOT NULL,
      first_seen_day   TEXT NOT NULL,
      last_seen_day    TEXT NOT NULL,
      first_report_day TEXT,
      PRIMARY KEY (instance_id, product)
    );
  `);
  const before = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM instances').get()?.n ?? 0;
  const existing = columnNames(db, 'instances');
  const productExpr = existing.includes('product') ? "COALESCE(NULLIF(product, ''), ?1)" : '?1';
  const firstReportExpr = existing.includes('first_report_day') ? 'first_report_day' : 'NULL';
  db.query(
    `INSERT INTO instances_migration_tmp (instance_id, product, first_seen_day, last_seen_day, first_report_day)
     SELECT instance_id, ${productExpr}, first_seen_day, last_seen_day, ${firstReportExpr} FROM instances`,
  ).run(LEGACY_PRODUCT);
  const after = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM instances_migration_tmp').get()?.n ?? 0;
  if (after !== before) {
    throw new Error(`migration would lose instance rows: ${before} before, ${after} after`);
  }
  db.exec('DROP TABLE instances');
  db.exec('ALTER TABLE instances_migration_tmp RENAME TO instances');
  return after;
}
