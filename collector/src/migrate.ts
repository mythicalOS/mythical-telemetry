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
//   • stored v1 payloads are normalized to the v2 shape at rest, so the read
//     path has exactly one shape to handle — leaving them un-normalized would
//     not crash, it would silently fold zeros into every historical total,
//     which is worse;
//   • the whole thing runs inside one IMMEDIATE transaction, so it either
//     lands completely or not at all, and a second process booting against the
//     same file waits rather than racing;
//   • state is detected from the actual table shape INSIDE that transaction,
//     never from `PRAGMA user_version` alone, so re-running is a no-op and a
//     hand-edited version marker cannot skip a rebuild that is genuinely
//     needed.
//
// Nothing is dropped. A payload that cannot be parsed is carried over verbatim
// and counted, never discarded.

import type { Database } from 'bun:sqlite';
import { v1ToV2 } from './normalize';

/** Bumped only when a further rebuild is required. */
export const SCHEMA_USER_VERSION = 1;

/** The product every pre-product row is backfilled as. */
export const LEGACY_PRODUCT = 'brokkr';

/** Rows rewritten per statement batch during the payload pass (bounds memory). */
const PAYLOAD_BATCH = 500;

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
  /** Stored v1 payloads rewritten into the v2 shape. */
  payloadsNormalized: number;
  /** Rows whose payload could not be parsed — carried over verbatim, never dropped. */
  payloadsUnparseable: number;
  /** The admission ledger was created and back-filled from existing rows. */
  admissionsSeeded: boolean;
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

const INSTANCES_DDL = `
  CREATE TABLE IF NOT EXISTS instances (
    instance_id    TEXT NOT NULL,
    product        TEXT NOT NULL,
    first_seen_day TEXT NOT NULL,
    last_seen_day  TEXT NOT NULL,
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

const INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_heartbeats_product_day ON heartbeats (product, day);
  CREATE INDEX IF NOT EXISTS idx_instances_product ON instances (product);
  CREATE INDEX IF NOT EXISTS idx_instances_first_seen ON instances (first_seen_day);
`;

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1")
    .get(name);
  return (row?.n ?? 0) > 0;
}

function columnNames(db: Database, table: string): string[] {
  // PRAGMA takes no bound parameters; `table` is never user input — it is one
  // of two literals below.
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return rows.map((r) => r.name);
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
    payloadsNormalized: 0,
    payloadsUnparseable: 0,
    admissionsSeeded: false,
  };

  // IMMEDIATE takes the write lock up front, so a second process booting on
  // the same file blocks here (busy_timeout) instead of reading a stale shape
  // and deciding to rebuild a table the winner already rebuilt.
  db.exec('BEGIN IMMEDIATE');
  try {
    // Detection happens INSIDE the transaction — see above.
    const versionInTx = userVersion(db);
    const hasHeartbeats = tableExists(db, 'heartbeats');
    const hasInstances = tableExists(db, 'instances');
    const heartbeatsNeedsProduct = hasHeartbeats && !columnNames(db, 'heartbeats').includes('product');
    const instancesNeedsProduct = hasInstances && !columnNames(db, 'instances').includes('product');

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

    // The payload pass is O(rows) and must not run on every boot. It runs when
    // a rebuild just happened, or when the version marker says this database
    // has not been through it yet.
    if (report.rebuiltHeartbeats || versionInTx < SCHEMA_USER_VERSION) {
      const pass = normalizeStoredV1Payloads(db);
      report.payloadsNormalized = pass.normalized;
      report.payloadsUnparseable = pass.unparseable;
    }

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
  db.query(
    `INSERT INTO heartbeats_migration_tmp (instance_id, product, day, schema_version, payload, received_day)
     SELECT instance_id, ?1, day, schema_version, payload, received_day FROM heartbeats`,
  ).run(LEGACY_PRODUCT);
  const after = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM heartbeats_migration_tmp').get()?.n ?? 0;
  if (after !== before) {
    // Impossible given the uniqueness argument above; if it ever happens the
    // transaction must abort rather than silently lose rows.
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
      instance_id    TEXT NOT NULL,
      product        TEXT NOT NULL,
      first_seen_day TEXT NOT NULL,
      last_seen_day  TEXT NOT NULL,
      PRIMARY KEY (instance_id, product)
    );
  `);
  const before = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM instances').get()?.n ?? 0;
  db.query(
    `INSERT INTO instances_migration_tmp (instance_id, product, first_seen_day, last_seen_day)
     SELECT instance_id, ?1, first_seen_day, last_seen_day FROM instances`,
  ).run(LEGACY_PRODUCT);
  const after = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM instances_migration_tmp').get()?.n ?? 0;
  if (after !== before) {
    throw new Error(`migration would lose instance rows: ${before} before, ${after} after`);
  }
  db.exec('DROP TABLE instances');
  db.exec('ALTER TABLE instances_migration_tmp RENAME TO instances');
  return after;
}

/**
 * Rewrite stored v1 documents into the v2 shape, in bounded batches.
 *
 * `heartbeats.schema_version` records the version the payload arrived as on
 * the wire; `heartbeats.payload` is always the normalized v2 document. Rows
 * written by the pre-product collector hold a raw v1 document, and this pass
 * brings them to that invariant.
 *
 * A row whose payload will not parse, or which is already v2, is left exactly
 * as it is. This pass never deletes.
 */
function normalizeStoredV1Payloads(db: Database): { normalized: number; unparseable: number } {
  const select = db.query<{ rowid: number; payload: string }, [number, number]>(
    'SELECT rowid AS rowid, payload FROM heartbeats WHERE rowid > ?1 ORDER BY rowid LIMIT ?2',
  );
  const update = db.query('UPDATE heartbeats SET payload = ?2 WHERE rowid = ?1');

  let cursor = 0;
  let normalized = 0;
  let unparseable = 0;

  for (;;) {
    const rows = select.all(cursor, PAYLOAD_BATCH);
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.rowid;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        unparseable += 1;
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        unparseable += 1;
        continue;
      }
      const doc = parsed as Record<string, unknown>;
      if (doc['schema_version'] !== 1) continue; // already v2 (or unknown) — leave it alone
      update.run(row.rowid, JSON.stringify(v1ToV2(doc)));
      normalized += 1;
    }
    if (rows.length < PAYLOAD_BATCH) break;
  }

  return { normalized, unparseable };
}
