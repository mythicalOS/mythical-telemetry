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
      db.upsertHeartbeat(INSTANCE_A, 'saga', '2026-07-08', 2, JSON.stringify({ metrics: {} }), '2026-07-08');
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
