// Storage: product-keyed upsert, retention prune, admission budgets,
// aggregates, and the privacy properties that are schema-level rather than
// promises.

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryDb } from '../src/db';

const payload = (day: string) => JSON.stringify({ day, schema_version: 2, metrics: {} });

describe('TelemetryDb basics', () => {
  test('file-backed database runs in WAL mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'collector-db-'));
    try {
      const db = new TelemetryDb({ path: join(dir, 'telemetry.db') });
      expect(db.journalMode().toLowerCase()).toBe('wal');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('NO column anywhere can hold an address or key material', () => {
    // The no-address-retention promise is a schema property, so it is asserted
    // against the schema rather than trusted to code review.
    const dir = mkdtempSync(join(tmpdir(), 'collector-db-'));
    try {
      const path = join(dir, 'telemetry.db');
      new TelemetryDb({ path }).close();
      const raw = new Database(path, { readonly: true });
      const names: string[] = [];
      for (const table of ['instances', 'heartbeats']) {
        for (const col of raw.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()) {
          names.push(`${table}.${col.name}`);
        }
      }
      raw.close();
      expect(names).toEqual([
        'instances.instance_id',
        'instances.product',
        'instances.first_seen_day',
        'instances.last_seen_day',
        'heartbeats.instance_id',
        'heartbeats.product',
        'heartbeats.day',
        'heartbeats.schema_version',
        'heartbeats.payload',
        'heartbeats.received_day',
      ]);
      for (const name of names) {
        expect(name).not.toMatch(/ip|addr|secret|key|token|received_at|timestamp/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('upsert maintains first/last_seen_day and replaces per (instance, product, day)', () => {
    const db = new TelemetryDb({ path: ':memory:' });
    db.recordHeartbeat('id-1', 'brokkr', '2026-07-01', 2, payload('2026-07-01'), '2026-07-02');
    let inst = db.getInstance('id-1', 'brokkr')!;
    expect(inst.first_seen_day).toBe('2026-07-02');
    expect(inst.last_seen_day).toBe('2026-07-02');
    expect(db.countHeartbeats('id-1', 'brokkr')).toBe(1);

    db.recordHeartbeat('id-1', 'brokkr', '2026-07-01', 2, JSON.stringify({ marker: 'y' }), '2026-07-03');
    expect(db.countHeartbeats('id-1', 'brokkr')).toBe(1);
    expect(JSON.parse(db.getHeartbeats('id-1', 'brokkr')[0]!.payload).marker).toBe('y');
    inst = db.getInstance('id-1', 'brokkr')!;
    expect(inst.first_seen_day).toBe('2026-07-02'); // first seen never moves
    expect(inst.last_seen_day).toBe('2026-07-03');
    db.close();
  });

  test('the same id under two products is two independent series', () => {
    const db = new TelemetryDb({ path: ':memory:' });
    db.recordHeartbeat('id-1', 'brokkr', '2026-07-01', 2, payload('brokkr'), '2026-07-01');
    db.recordHeartbeat('id-1', 'saga', '2026-07-01', 2, payload('saga'), '2026-07-01');
    expect(db.countHeartbeats('id-1', 'brokkr')).toBe(1);
    expect(db.countHeartbeats('id-1', 'saga')).toBe(1);
    expect(JSON.parse(db.getHeartbeats('id-1', 'brokkr')[0]!.payload).day).toBe('brokkr');
    expect(JSON.parse(db.getHeartbeats('id-1', 'saga')[0]!.payload).day).toBe('saga');
    db.close();
  });

  test('getHeartbeats returns days ascending; the trim keeps the most recent N (still ascending)', () => {
    const db = new TelemetryDb({ path: ':memory:' });
    for (const day of ['2026-07-03', '2026-07-01', '2026-07-02']) {
      db.recordHeartbeat('id-1', 'brokkr', day, 2, payload(day), day);
    }
    expect(db.getHeartbeats('id-1', 'brokkr').map((r) => r.day)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(db.getHeartbeats('id-1', 'brokkr', 2).map((r) => r.day)).toEqual(['2026-07-02', '2026-07-03']);
    db.close();
  });

  test('deleteInstance purges the identity across EVERY product, idempotently', () => {
    const db = new TelemetryDb({ path: ':memory:' });
    db.recordHeartbeat('id-1', 'brokkr', '2026-07-01', 2, payload('a'), '2026-07-01');
    db.recordHeartbeat('id-1', 'saga', '2026-07-01', 2, payload('b'), '2026-07-01');
    db.recordHeartbeat('id-2', 'brokkr', '2026-07-01', 2, payload('c'), '2026-07-01');

    db.deleteInstance('id-1');
    expect(db.getInstance('id-1', 'brokkr')).toBeNull();
    expect(db.getInstance('id-1', 'saga')).toBeNull();
    expect(db.countHeartbeats('id-1', 'brokkr')).toBe(0);
    expect(db.countHeartbeats('id-1', 'saga')).toBe(0);
    // Scoped: another identity is untouched.
    expect(db.countHeartbeats('id-2', 'brokkr')).toBe(1);
    db.deleteInstance('id-1');
    db.deleteInstance('never-seen');
    db.close();
  });
});

describe('retention prune (per-instance, per-product row cap)', () => {
  test('keeps the newest N rows per (instance, product), drops the oldest', () => {
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 3 });
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']) {
      db.recordHeartbeat('id-1', 'brokkr', day, 2, payload(day), day);
      db.recordHeartbeat('id-1', 'saga', day, 2, payload(day), day);
    }
    db.recordHeartbeat('id-2', 'brokkr', '2026-06-01', 2, payload('x'), '2026-06-01');

    expect(db.pruneRetention()).toBe(4); // 2 per (id-1, product)
    expect(db.getHeartbeats('id-1', 'brokkr').map((r) => r.day)).toEqual([
      '2026-07-03', '2026-07-04', '2026-07-05',
    ]);
    // Partitioning is per PRODUCT too — saga's series is not eaten by brokkr's.
    expect(db.getHeartbeats('id-1', 'saga').map((r) => r.day)).toEqual([
      '2026-07-03', '2026-07-04', '2026-07-05',
    ]);
    expect(db.getHeartbeats('id-2', 'brokkr').map((r) => r.day)).toEqual(['2026-06-01']);
    db.close();
  });
});

describe('admission control — the decision and the write are one transaction', () => {
  test('an unseen identity beyond the absolute ceiling is refused, and nothing is written', () => {
    const db = new TelemetryDb({ path: ':memory:', maxInstances: 1 });
    expect(db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: true,
      existing: false,
    });

    expect(db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('b'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'instance_capacity',
    });
    // A refusal must leave NO trace — otherwise the refusal itself consumes
    // the capacity it was protecting.
    expect(db.getInstance('id-2', 'brokkr')).toBeNull();
    expect(db.countHeartbeats('id-2', 'brokkr')).toBe(0);
    expect(db.countInstances()).toBe(1);

    // The SAME id under a different product is a different identity, and so is
    // also subject to the ceiling.
    expect(db.recordHeartbeat('id-1', 'saga', '2026-07-09', 2, payload('c'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'instance_capacity',
    });
    // The established identity keeps writing.
    expect(db.recordHeartbeat('id-1', 'brokkr', '2026-07-08', 2, payload('d'), '2026-07-09')).toEqual({
      ok: true,
      existing: true,
    });
    db.close();
  });

  test('the daily budget bounds how fast the ceiling can be approached, and resets with the day', () => {
    const db = new TelemetryDb({ path: ':memory:', maxInstances: 100, newInstancesPerDay: 2 });
    db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    expect(db.admittedOnDay('2026-07-09')).toBe(2);

    expect(db.recordHeartbeat('id-3', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
    // Established installs keep writing while the budget is exhausted.
    expect(db.recordHeartbeat('id-1', 'brokkr', '2026-07-08', 2, payload('a'), '2026-07-09').ok).toBe(true);
    // A new day restores the budget.
    expect(db.recordHeartbeat('id-3', 'brokkr', '2026-07-10', 2, payload('a'), '2026-07-10')).toEqual({
      ok: true,
      existing: false,
    });
    db.close();
  });

  test('the ledger is append-only: delete-and-remint cannot buy back budget', () => {
    // Deriving the daily count from instances.first_seen_day would fall again
    // on delete, so mint → delete → mint would be unbounded.
    const db = new TelemetryDb({ path: ':memory:', maxInstances: 100, newInstancesPerDay: 2 });
    db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');

    db.deleteInstance('id-1');
    db.deleteInstance('id-2');
    expect(db.countInstances()).toBe(0);
    expect(db.admittedOnDay('2026-07-09')).toBe(2); // ledger unmoved

    expect(db.recordHeartbeat('id-3', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
    db.close();
  });

  test('the daily budget is durable, not in-memory: a restart does not reset it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'collector-db-'));
    try {
      const path = join(dir, 'telemetry.db');
      const first = new TelemetryDb({ path, newInstancesPerDay: 1 });
      first.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
      expect(first.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
        ok: false,
        reason: 'daily_admission_budget',
      });
      first.close();

      const second = new TelemetryDb({ path, newInstancesPerDay: 1 });
      expect(second.admittedOnDay('2026-07-09')).toBe(1);
      expect(second.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
        ok: false,
        reason: 'daily_admission_budget',
      });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a second process on the same file cannot walk past the ceiling', () => {
    // Two TelemetryDb handles on one database file are the same shape as two
    // replicas. Because the check and the insert share one IMMEDIATE
    // transaction, the second handle observes the first handle's write.
    const dir = mkdtempSync(join(tmpdir(), 'collector-db-'));
    try {
      const path = join(dir, 'telemetry.db');
      const a = new TelemetryDb({ path, maxInstances: 1 });
      const b = new TelemetryDb({ path, maxInstances: 1 });
      expect(a.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09').ok).toBe(true);
      expect(b.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
        ok: false,
        reason: 'instance_capacity',
      });
      expect(b.countInstances()).toBe(1);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a zero daily budget disables that check without disabling the ceiling', () => {
    const db = new TelemetryDb({ path: ':memory:', maxInstances: 2, newInstancesPerDay: 0 });
    db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    expect(db.recordHeartbeat('id-3', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'instance_capacity',
    });
    db.close();
  });

  test('the ledger is trimmed by the retention prune', () => {
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 2 });
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']) {
      db.recordHeartbeat(`id-${day}`, 'brokkr', day, 2, payload(day), day);
    }
    expect(db.admittedOnDay('2026-07-01')).toBe(1);
    db.pruneRetention();
    expect(db.admittedOnDay('2026-07-01')).toBe(0);
    expect(db.admittedOnDay('2026-07-04')).toBe(1);
    db.close();
  });
});

describe('aggregates', () => {
  test('grouped per product, with an active window, and NO total', () => {
    const db = new TelemetryDb({ path: ':memory:' });
    db.recordHeartbeat('a', 'brokkr', '2026-07-01', 2, payload('x'), '2026-07-01');
    db.recordHeartbeat('a', 'brokkr', '2026-07-09', 2, payload('x'), '2026-07-09');
    db.recordHeartbeat('b', 'brokkr', '2026-01-01', 2, payload('x'), '2026-01-01');
    db.recordHeartbeat('c', 'saga', '2026-07-09', 2, payload('x'), '2026-07-09');

    const rows = db.aggregates('2026-06-12');
    expect(rows).toEqual([
      { product: 'brokkr', installs_seen: 2, installs_active: 1, days_reported: 3 },
      { product: 'saga', installs_seen: 1, installs_active: 1, days_reported: 1 },
    ]);
    db.close();
  });
});
