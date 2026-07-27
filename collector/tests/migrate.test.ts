// The product-dimension migration, tested against a database built by the OLD
// schema — not by a helper that already knows about `product`.
//
// The old DDL below is reproduced literally from the pre-v2 collector: PK
// (instance_id, day) on heartbeats, a single-column PK on instances, and no
// product column anywhere. Every assertion here is about what happens to a
// real volume an operator already has.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryDb } from '../src/db';
import { LEGACY_PRODUCT, migrate, SCHEMA_USER_VERSION } from '../src/migrate';
import { INSTANCE_A, INSTANCE_B, makeV1 } from './fixtures';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'collector-migrate-'));
  dirs.push(dir);
  return join(dir, 'telemetry.db');
}

/** The PRE-PRODUCT schema, verbatim. */
const OLD_DDL = `
  CREATE TABLE IF NOT EXISTS instances (
    instance_id    TEXT PRIMARY KEY,
    first_seen_day TEXT NOT NULL,
    last_seen_day  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS heartbeats (
    instance_id    TEXT NOT NULL,
    day            TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    payload        TEXT NOT NULL,
    received_day   TEXT NOT NULL,
    PRIMARY KEY (instance_id, day)
  );
`;

interface SeedRow {
  instanceId: string;
  day: string;
  payload: string;
  schemaVersion?: number;
}

/** Build a database exactly as the pre-product collector would have left it. */
function seedOldDatabase(path: string, rows: SeedRow[]): void {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(OLD_DDL);
  const insertInstance = db.query(
    `INSERT INTO instances (instance_id, first_seen_day, last_seen_day) VALUES (?1, ?2, ?2)
     ON CONFLICT(instance_id) DO UPDATE SET last_seen_day = MAX(instances.last_seen_day, excluded.last_seen_day)`,
  );
  const insertHeartbeat = db.query(
    `INSERT INTO heartbeats (instance_id, day, schema_version, payload, received_day)
     VALUES (?1, ?2, ?3, ?4, ?2)`,
  );
  for (const row of rows) {
    insertInstance.run(row.instanceId, row.day);
    insertHeartbeat.run(row.instanceId, row.day, row.schemaVersion ?? 1, row.payload);
  }
  db.close();
}

function columns(path: string, table: string): Array<{ name: string; pk: number }> {
  const db = new Database(path, { readonly: true });
  const rows = db.query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`).all();
  db.close();
  return rows;
}

function userVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  const v = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  db.close();
  return v;
}

describe('migration against a REAL old-schema database', () => {
  test('adds the product dimension, backfills every row as brokkr, and loses nothing', () => {
    const path = tempDbPath();
    const rows: SeedRow[] = [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
      { instanceId: INSTANCE_A, day: '2026-07-08', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-08')) },
      { instanceId: INSTANCE_B, day: '2026-07-08', payload: JSON.stringify(makeV1(INSTANCE_B, '2026-07-08')) },
    ];
    seedOldDatabase(path, rows);

    // Sanity: the seeded database really is the old shape.
    expect(columns(path, 'heartbeats').map((c) => c.name)).not.toContain('product');
    expect(userVersion(path)).toBe(0);

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.rebuiltHeartbeats).toBe(true);
      expect(db.migration.rebuiltInstances).toBe(true);
      expect(db.migration.heartbeatRowsCarried).toBe(3);
      expect(db.migration.instanceRowsCarried).toBe(2);

      // Every row is present, under the backfilled product.
      expect(db.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT).map((r) => r.day)).toEqual([
        '2026-07-07',
        '2026-07-08',
      ]);
      expect(db.getHeartbeats(INSTANCE_B, LEGACY_PRODUCT).map((r) => r.day)).toEqual(['2026-07-08']);
      expect(db.countInstances()).toBe(2);

      // ...and nowhere else.
      expect(db.getHeartbeats(INSTANCE_A, 'saga')).toEqual([]);
      expect(db.getInstance(INSTANCE_A, 'saga')).toBeNull();
      expect(db.getInstance(INSTANCE_A, LEGACY_PRODUCT)?.first_seen_day).toBe('2026-07-07');
    } finally {
      db.close();
    }

    const hb = columns(path, 'heartbeats');
    expect(hb.map((c) => c.name)).toContain('product');
    // Primary key is now the three-part (instance_id, product, day).
    expect(hb.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)).toEqual([
      'instance_id',
      'product',
      'day',
    ]);
    const inst = columns(path, 'instances');
    expect(inst.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)).toEqual([
      'instance_id',
      'product',
    ]);
    expect(userVersion(path)).toBe(SCHEMA_USER_VERSION);
  });

  test('stored v1 payloads are normalized to the v2 shape at rest; the wire version is retained', () => {
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
    ]);

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.payloadsNormalized).toBe(1);
      expect(db.migration.payloadsUnparseable).toBe(0);
      const row = db.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT)[0]!;
      // The COLUMN still records "arrived as v1" — that is the number the
      // support-window decision needs.
      expect(row.schema_version).toBe(1);
      const doc = JSON.parse(row.payload);
      expect(doc.schema_version).toBe(2);
      expect(doc.product).toEqual({ name: 'brokkr', version: '0.1.0' });
      expect(doc.product.daemon_version).toBeUndefined();
      expect(doc.sessions).toBeUndefined();
      expect(doc.metrics.sessions).toEqual({ count: 12, minutes: 340, failed: 1 });
      expect(doc.metrics.spine.tokens_before).toBe(412000);
      expect(doc.instance_id).toBe(INSTANCE_A);
      expect(doc.day).toBe('2026-07-07');
    } finally {
      db.close();
    }
  });

  test('re-running is a no-op: no second rebuild, no second payload pass', () => {
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
    ]);

    const first = new TelemetryDb({ path });
    const firstPayload = first.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT)[0]!.payload;
    first.close();

    const second = new TelemetryDb({ path });
    try {
      expect(second.migration.rebuiltHeartbeats).toBe(false);
      expect(second.migration.rebuiltInstances).toBe(false);
      expect(second.migration.payloadsNormalized).toBe(0);
      expect(second.migration.normalizationPassRan).toBe(false);
      expect(second.migration.fromUserVersion).toBe(SCHEMA_USER_VERSION);
      // Byte-identical: a second pass must not re-transform an already
      // normalized document.
      expect(second.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT)[0]!.payload).toBe(firstPayload);
      expect(second.countInstances()).toBe(1);
    } finally {
      second.close();
    }

    const third = new TelemetryDb({ path });
    try {
      expect(third.migration.payloadsNormalized).toBe(0);
      expect(third.countHeartbeats(INSTANCE_A, LEGACY_PRODUCT)).toBe(1);
    } finally {
      third.close();
    }
  });

  test('the collision the product column exists to prevent is gone', () => {
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-08', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-08')) },
    ]);
    const db = new TelemetryDb({ path });
    try {
      // Same id, same day, different product: under the old key this
      // overwrote; under the new one both rows live.
      db.recordHeartbeat(INSTANCE_A, 'saga', '2026-07-08', 2, JSON.stringify({ metrics: {} }), '2026-07-08');
      expect(db.countHeartbeats(INSTANCE_A, LEGACY_PRODUCT)).toBe(1);
      expect(db.countHeartbeats(INSTANCE_A, 'saga')).toBe(1);
      expect(db.countInstances()).toBe(2);
    } finally {
      db.close();
    }
  });

  test('a hand-set version marker cannot skip a rebuild that is genuinely needed', () => {
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
    ]);
    const raw = new Database(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
    raw.close();

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.fromUserVersion).toBe(SCHEMA_USER_VERSION);
      expect(db.migration.rebuiltHeartbeats).toBe(true);
      // The payload pass runs too, because a rebuild happened — the version
      // marker does not gate it once the shape says otherwise.
      expect(db.migration.payloadsNormalized).toBe(1);
      expect(db.countHeartbeats(INSTANCE_A, LEGACY_PRODUCT)).toBe(1);
    } finally {
      db.close();
    }
  });

  test('a partially-migrated database (one table converted) is completed, not skipped', () => {
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
    ]);
    // Convert ONLY heartbeats by hand, leaving instances on the old shape.
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE hb2 (
        instance_id TEXT NOT NULL, product TEXT NOT NULL, day TEXT NOT NULL,
        schema_version INTEGER NOT NULL, payload TEXT NOT NULL, received_day TEXT NOT NULL,
        PRIMARY KEY (instance_id, product, day)
      );
      INSERT INTO hb2 SELECT instance_id, 'brokkr', day, schema_version, payload, received_day FROM heartbeats;
      DROP TABLE heartbeats;
      ALTER TABLE hb2 RENAME TO heartbeats;
    `);
    raw.close();

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.rebuiltHeartbeats).toBe(false);
      expect(db.migration.rebuiltInstances).toBe(true);
      expect(db.countInstances()).toBe(1);
      expect(db.getInstance(INSTANCE_A, LEGACY_PRODUCT)).not.toBeNull();
      expect(db.countHeartbeats(INSTANCE_A, LEGACY_PRODUCT)).toBe(1);
    } finally {
      db.close();
    }
  });

  test('a database converted by OTHER means still gets its stored v1 payloads normalized', () => {
    // The silent-miss this closes: tables already carry `product` and
    // user_version already says 1, but the payloads are raw v1. Gating the
    // payload pass on the SHAPE marker would skip it, and every historical
    // total would then quietly fold zeros out of documents it cannot see into.
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
    ]);
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE hb2 (
        instance_id TEXT NOT NULL, product TEXT NOT NULL, day TEXT NOT NULL,
        schema_version INTEGER NOT NULL, payload TEXT NOT NULL, received_day TEXT NOT NULL,
        PRIMARY KEY (instance_id, product, day)
      );
      INSERT INTO hb2 SELECT instance_id, 'brokkr', day, schema_version, payload, received_day FROM heartbeats;
      DROP TABLE heartbeats;
      ALTER TABLE hb2 RENAME TO heartbeats;
      CREATE TABLE inst2 (
        instance_id TEXT NOT NULL, product TEXT NOT NULL,
        first_seen_day TEXT NOT NULL, last_seen_day TEXT NOT NULL,
        PRIMARY KEY (instance_id, product)
      );
      INSERT INTO inst2 SELECT instance_id, 'brokkr', first_seen_day, last_seen_day FROM instances;
      DROP TABLE instances;
      ALTER TABLE inst2 RENAME TO instances;
    `);
    raw.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
    raw.close();

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.rebuiltHeartbeats).toBe(false);
      expect(db.migration.rebuiltInstances).toBe(false);
      expect(db.migration.normalizationPassRan).toBe(true);
      expect(db.migration.payloadsNormalized).toBe(1);
      const doc = JSON.parse(db.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT)[0]!.payload);
      expect(doc.schema_version).toBe(2);
      expect(doc.metrics.sessions.count).toBe(12);
    } finally {
      db.close();
    }

    // ...and it is a no-op the next time.
    const again = new TelemetryDb({ path });
    try {
      expect(again.migration.normalizationPassRan).toBe(false);
      expect(again.migration.payloadsNormalized).toBe(0);
    } finally {
      again.close();
    }
  });

  test('a naive ADD COLUMN upgrade is detected and completed, not mistaken for done', () => {
    // The obvious hand-upgrade is `ALTER TABLE ... ADD COLUMN product`, which
    // leaves the LEGACY primary key in place. Detecting on the column alone
    // would call that database current — and the service could not even
    // prepare its upsert, whose ON CONFLICT then matches no constraint.
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
      { instanceId: INSTANCE_B, day: '2026-07-08', payload: JSON.stringify(makeV1(INSTANCE_B, '2026-07-08')) },
    ]);
    const raw = new Database(path);
    raw.exec("ALTER TABLE heartbeats ADD COLUMN product TEXT NOT NULL DEFAULT 'brokkr'");
    raw.exec("ALTER TABLE instances ADD COLUMN product TEXT NOT NULL DEFAULT 'brokkr'");
    // ...and mark it done, the way a hand-written script would.
    raw.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
    raw.close();

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.rebuiltHeartbeats).toBe(true);
      expect(db.migration.rebuiltInstances).toBe(true);
      expect(db.migration.heartbeatRowsCarried).toBe(2);
      expect(db.countHeartbeats(INSTANCE_A, LEGACY_PRODUCT)).toBe(1);
      // The upsert works, which is the whole point.
      expect(db.recordHeartbeat(INSTANCE_A, 'saga', '2026-07-09', 2, '{}', '2026-07-09').ok).toBe(true);
      expect(db.countHeartbeats(INSTANCE_A, 'saga')).toBe(1);
    } finally {
      db.close();
    }

    const hb = columns(path, 'heartbeats');
    expect(hb.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)).toEqual([
      'instance_id', 'product', 'day',
    ]);
  });

  test('product values already present in a half-upgraded table are KEPT, not overwritten', () => {
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
      { instanceId: INSTANCE_B, day: '2026-07-08', payload: JSON.stringify(makeV1(INSTANCE_B, '2026-07-08')) },
    ]);
    const raw = new Database(path);
    raw.exec('ALTER TABLE heartbeats ADD COLUMN product TEXT');
    raw.exec('ALTER TABLE instances ADD COLUMN product TEXT');
    // One row was already classified; the other was left blank.
    raw.query('UPDATE heartbeats SET product = ?1 WHERE instance_id = ?2').run('saga', INSTANCE_B);
    raw.query('UPDATE instances SET product = ?1 WHERE instance_id = ?2').run('saga', INSTANCE_B);
    raw.close();

    const db = new TelemetryDb({ path });
    try {
      expect(db.countHeartbeats(INSTANCE_B, 'saga')).toBe(1);
      expect(db.countHeartbeats(INSTANCE_B, LEGACY_PRODUCT)).toBe(0);
      expect(db.getInstance(INSTANCE_B, 'saga')).not.toBeNull();
      // ...while the unclassified row still backfills to the legacy product.
      expect(db.countHeartbeats(INSTANCE_A, LEGACY_PRODUCT)).toBe(1);
    } finally {
      db.close();
    }
  });

  test('an unparseable stored payload is carried over verbatim and counted, never dropped', () => {
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-06', payload: 'not json at all' },
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
      { instanceId: INSTANCE_A, day: '2026-07-08', payload: '[1,2,3]' },
    ]);

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.heartbeatRowsCarried).toBe(3);
      expect(db.migration.payloadsNormalized).toBe(1);
      expect(db.migration.payloadsUnparseable).toBe(2);
      const rows = db.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT);
      expect(rows.map((r) => r.day)).toEqual(['2026-07-06', '2026-07-07', '2026-07-08']);
      expect(rows[0]!.payload).toBe('not json at all');
      expect(rows[2]!.payload).toBe('[1,2,3]');
    } finally {
      db.close();
    }
  });

  test('a database already carrying v2 rows is left alone by the payload pass', () => {
    const path = tempDbPath();
    const v2Doc = JSON.stringify({ schema_version: 2, metrics: { sessions: { count: 1 } } });
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: v2Doc, schemaVersion: 2 },
    ]);
    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.payloadsNormalized).toBe(0);
      expect(db.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT)[0]!.payload).toBe(v2Doc);
    } finally {
      db.close();
    }
  });

  test('an upgraded database gets first_report_day derived from its surviving heartbeats', () => {
    // Rows written before the column existed have no recorded first day. The
    // best evidence available is the earliest heartbeat that survives.
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
      { instanceId: INSTANCE_A, day: '2026-07-09', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-09')) },
      { instanceId: INSTANCE_B, day: '2026-07-08', payload: JSON.stringify(makeV1(INSTANCE_B, '2026-07-08')) },
    ]);

    const db = new TelemetryDb({ path });
    try {
      expect(db.getInstance(INSTANCE_A, LEGACY_PRODUCT)?.first_report_day).toBe('2026-07-07');
      expect(db.getInstance(INSTANCE_B, LEGACY_PRODUCT)?.first_report_day).toBe('2026-07-08');
    } finally {
      db.close();
    }

    // Re-running does not re-derive it.
    const again = new TelemetryDb({ path });
    try {
      expect(again.migration.firstReportBackfilled).toBe(0);
      expect(again.getInstance(INSTANCE_A, LEGACY_PRODUCT)?.first_report_day).toBe('2026-07-07');
    } finally {
      again.close();
    }
  });

  test('an instance whose heartbeats have all been pruned keeps a NULL first-report day', () => {
    // NULL says "unknown" honestly. Filling it in from a later heartbeat would
    // stamp an ordinary day as the first-report day and exclude it from every
    // rate for the rest of that installation's life.
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
    ]);
    const raw = new Database(path);
    raw.exec('DELETE FROM heartbeats');
    raw.close();

    const db = new TelemetryDb({ path });
    try {
      expect(db.getInstance(INSTANCE_A, LEGACY_PRODUCT)?.first_report_day).toBeNull();
      // A later heartbeat does NOT claim the marker.
      db.recordHeartbeat(INSTANCE_A, LEGACY_PRODUCT, '2026-08-01', 2, '{}', '2026-08-01');
      expect(db.getInstance(INSTANCE_A, LEGACY_PRODUCT)?.first_report_day).toBeNull();
    } finally {
      db.close();
    }
  });

  test('a table declared with different column CASING is recognised, not rebuilt and overwritten', () => {
    // SQLite identifiers are case-insensitive but PRAGMA table_info reports
    // the casing as declared. Comparing verbatim would call this table
    // unconverted, rebuild it, and — because its product column would also
    // read as absent — overwrite every real product value with the default.
    const path = tempDbPath();
    const raw = new Database(path, { create: true });
    raw.exec(`
      CREATE TABLE Heartbeats (
        Instance_ID TEXT NOT NULL, PRODUCT TEXT NOT NULL, Day TEXT NOT NULL,
        Schema_Version INTEGER NOT NULL, Payload TEXT NOT NULL, Received_Day TEXT NOT NULL,
        PRIMARY KEY (Instance_ID, PRODUCT, Day)
      );
      CREATE TABLE Instances (
        Instance_ID TEXT NOT NULL, PRODUCT TEXT NOT NULL,
        First_Seen_Day TEXT NOT NULL, Last_Seen_Day TEXT NOT NULL,
        PRIMARY KEY (Instance_ID, PRODUCT)
      );
    `);
    raw.query('INSERT INTO Instances VALUES (?1, ?2, ?3, ?3)').run(INSTANCE_A, 'saga', '2026-07-07');
    raw
      .query('INSERT INTO Heartbeats VALUES (?1, ?2, ?3, ?4, ?5, ?3)')
      .run(INSTANCE_A, 'saga', '2026-07-07', 2, JSON.stringify({ schema_version: 2, metrics: {} }));
    raw.close();

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.rebuiltHeartbeats).toBe(false);
      expect(db.migration.rebuiltInstances).toBe(false);
      // The product value survived, rather than being replaced by the default.
      expect(db.countHeartbeats(INSTANCE_A, 'saga')).toBe(1);
      expect(db.countHeartbeats(INSTANCE_A, LEGACY_PRODUCT)).toBe(0);
    } finally {
      db.close();
    }
  });

  test('a LEGACY table declared with different casing is still found and rebuilt', () => {
    // SQLite treats `Heartbeats` and `heartbeats` as one table. A
    // case-sensitive existence check reports the legacy table as absent, skips
    // its rebuild entirely, and leaves the service querying a `product` column
    // that does not exist.
    const path = tempDbPath();
    const raw = new Database(path, { create: true });
    raw.exec(`
      CREATE TABLE Heartbeats (
        Instance_ID TEXT NOT NULL, Day TEXT NOT NULL, Schema_Version INTEGER NOT NULL,
        Payload TEXT NOT NULL, Received_Day TEXT NOT NULL,
        PRIMARY KEY (Instance_ID, Day)
      );
      CREATE TABLE Instances (
        Instance_ID TEXT PRIMARY KEY, First_Seen_Day TEXT NOT NULL, Last_Seen_Day TEXT NOT NULL
      );
    `);
    raw.query('INSERT INTO Instances VALUES (?1, ?2, ?2)').run(INSTANCE_A, '2026-07-07');
    raw
      .query('INSERT INTO Heartbeats VALUES (?1, ?2, ?3, ?4, ?2)')
      .run(INSTANCE_A, '2026-07-07', 1, JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')));
    raw.close();

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.rebuiltHeartbeats).toBe(true);
      expect(db.migration.rebuiltInstances).toBe(true);
      expect(db.migration.heartbeatRowsCarried).toBe(1);
      expect(db.countHeartbeats(INSTANCE_A, LEGACY_PRODUCT)).toBe(1);
      expect(JSON.parse(db.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT)[0]!.payload).metrics.sessions.count).toBe(12);
      expect(db.recordHeartbeat(INSTANCE_A, 'saga', '2026-07-09', 2, '{}', '2026-07-09').ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test('a WITHOUT ROWID heartbeats table does not break the payload pass', () => {
    // It passes every shape check and so is not rebuilt — a pass that paged on
    // `rowid` would then fail, roll the migration back, and leave the service
    // unable to start.
    const path = tempDbPath();
    const raw = new Database(path, { create: true });
    raw.exec(`
      CREATE TABLE heartbeats (
        instance_id TEXT NOT NULL, product TEXT NOT NULL, day TEXT NOT NULL,
        schema_version INTEGER NOT NULL, payload TEXT NOT NULL, received_day TEXT NOT NULL,
        PRIMARY KEY (instance_id, product, day)
      ) WITHOUT ROWID;
      CREATE TABLE instances (
        instance_id TEXT NOT NULL, product TEXT NOT NULL,
        first_seen_day TEXT NOT NULL, last_seen_day TEXT NOT NULL,
        PRIMARY KEY (instance_id, product)
      ) WITHOUT ROWID;
    `);
    const insert = raw.query('INSERT INTO heartbeats VALUES (?1, ?2, ?3, ?4, ?5, ?3)');
    for (const day of ['2026-07-07', '2026-07-08']) {
      insert.run(INSTANCE_A, 'brokkr', day, 1, JSON.stringify(makeV1(INSTANCE_A, day)));
    }
    raw.query('INSERT INTO instances VALUES (?1, ?2, ?3, ?3)').run(INSTANCE_A, 'brokkr', '2026-07-07');
    raw.close();

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.rebuiltHeartbeats).toBe(false);
      expect(db.migration.normalizationPassRan).toBe(true);
      expect(db.migration.payloadsNormalized).toBe(2);
      const rows = db.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT);
      expect(rows.map((r) => r.day)).toEqual(['2026-07-07', '2026-07-08']);
      expect(JSON.parse(rows[0]!.payload).metrics.sessions.count).toBe(12);
    } finally {
      db.close();
    }
  });

  test('the payload pass pages correctly across more rows than one batch', () => {
    // Keyset pagination on the composite key: every row must be visited
    // exactly once, with none skipped at a batch boundary.
    const path = tempDbPath();
    const rows: SeedRow[] = [];
    for (let i = 0; i < 1200; i++) {
      const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      rows.push({ instanceId: INSTANCE_A, day, payload: JSON.stringify(makeV1(INSTANCE_A, day)) });
    }
    seedOldDatabase(path, rows);

    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.heartbeatRowsCarried).toBe(1200);
      expect(db.migration.payloadsNormalized).toBe(1200);
      expect(db.countHeartbeats(INSTANCE_A, LEGACY_PRODUCT)).toBe(1200);
      for (const row of db.getHeartbeats(INSTANCE_A, LEGACY_PRODUCT)) {
        expect(JSON.parse(row.payload).schema_version).toBe(2);
      }
    } finally {
      db.close();
    }
  });

  test('a fresh database is created, not migrated', () => {
    const path = tempDbPath();
    const db = new TelemetryDb({ path });
    try {
      expect(db.migration.createdFresh).toBe(true);
      expect(db.migration.rebuiltHeartbeats).toBe(false);
      expect(db.migration.heartbeatRowsCarried).toBe(0);
      expect(db.journalMode().toLowerCase()).toBe('wal');
    } finally {
      db.close();
    }
    expect(userVersion(path)).toBe(SCHEMA_USER_VERSION);
  });

  test('a failure inside the migration leaves the old database untouched', () => {
    const path = tempDbPath();
    seedOldDatabase(path, [
      { instanceId: INSTANCE_A, day: '2026-07-07', payload: JSON.stringify(makeV1(INSTANCE_A, '2026-07-07')) },
    ]);

    // A leftover table with the tmp name AND a conflicting shape would break
    // the rebuild — the transaction must roll all of it back rather than leave
    // a half-converted store. (`DROP TABLE IF EXISTS` handles the benign case;
    // this forces the failure path with a view, which cannot be dropped as a
    // table.)
    const raw = new Database(path);
    raw.exec('CREATE VIEW heartbeats_migration_tmp AS SELECT 1 AS x');
    raw.close();

    const db = new Database(path);
    expect(() => migrate(db)).toThrow();
    // Old shape intact, data intact.
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(heartbeats)').all().map((c) => c.name);
    expect(cols).not.toContain('product');
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM heartbeats').get()?.n).toBe(1);
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(0);
    db.close();
  });
});
