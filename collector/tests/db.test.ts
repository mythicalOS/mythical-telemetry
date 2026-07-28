// Storage: product-keyed upsert, retention prune, admission budgets,
// aggregates, and the privacy properties that are schema-level rather than
// promises.

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INGEST_DAY_WINDOW_DAYS, shiftDay } from '../src/day';
import { maxRowsFor, TelemetryDb } from '../src/db';

const payload = (day: string) => JSON.stringify({ day, schema_version: 1, metrics: {} });

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
        'instances.first_report_day',
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

describe('retention is a CLOCK — rows expire by age, whether or not an install still reports', () => {
  test('an install that STOPPED reporting has its rows deleted once they age past the window', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Before the clock, the prune was a
    // per-(instance, product) row cap and nothing else: this installation has
    // ten rows, far fewer than the cap, so no prune ever deleted one of them and
    // its data was kept indefinitely — three years after it last said anything.
    // The published commitment ("everything already held expires within a
    // quarter") was therefore false for exactly the population least able to
    // notice: the ones who stopped.
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 90 });
    const days = Array.from({ length: 10 }, (_, i) => `2023-01-${String(i + 1).padStart(2, '0')}`);
    for (const day of days) db.recordHeartbeat('gone-quiet', 'brokkr', day, 2, payload(day), day);
    expect(db.countHeartbeats('gone-quiet', 'brokkr')).toBe(10);

    const report = db.pruneRetention('2026-07-28');
    expect(report.expired_heartbeats).toBe(10);
    // ...and the cap deleted NOTHING, which is the point: with only the cap
    // there was no control that could ever have touched these rows.
    expect(report.capped_heartbeats).toBe(0);
    expect(db.countHeartbeats('gone-quiet', 'brokkr')).toBe(0);
    // The identity row goes too — it is pseudonymous personal data by itself.
    expect(report.expired_instances).toBe(1);
    expect(db.getInstance('gone-quiet', 'brokkr')).toBeNull();
    expect(db.countInstances()).toBe(0);
    db.close();
  });

  test('the boundary: the window counts the arrival day, and the day after it is gone', () => {
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 90 });
    // 90 days ending 2026-07-28 inclusive starts on 2026-04-30. One row on the
    // first day inside the window, one on the last day outside it.
    db.recordHeartbeat('edge', 'brokkr', '2026-04-30', 2, payload('in'), '2026-04-30');
    db.recordHeartbeat('edge', 'brokkr', '2026-04-29', 2, payload('out'), '2026-04-29');

    const report = db.pruneRetention('2026-07-28');
    expect(report.cutoff_day).toBe('2026-04-30');
    expect(report.expired_heartbeats).toBe(1);
    expect(db.getHeartbeats('edge', 'brokkr').map((r) => r.day)).toEqual(['2026-04-30']);
    // One day later the surviving row is on the wrong side of the cutoff.
    expect(db.pruneRetention('2026-07-29').expired_heartbeats).toBe(1);
    expect(db.countHeartbeats('edge', 'brokkr')).toBe(0);
    db.close();
  });

  test('the clock is on ARRIVAL, so a late backfill gets its full window', () => {
    // A heartbeat for an old `day` that arrived today has been held for one day,
    // not for a month, and retention is a promise about how long WE hold it.
    // Keying on `day` would give this row two months of window instead of three,
    // purely because delivery was late.
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 90 });
    db.recordHeartbeat('backfiller', 'brokkr', '2026-06-28', 2, payload('late'), '2026-07-28');
    expect(db.pruneRetention('2026-07-28').expired_heartbeats).toBe(0);
    expect(db.countHeartbeats('backfiller', 'brokkr')).toBe(1);
    // It survives until 90 days after it ARRIVED...
    expect(db.pruneRetention('2026-10-25').expired_heartbeats).toBe(0);
    // ...and no longer. (Had `day` been the basis it would already have gone.)
    expect(db.pruneRetention('2026-10-26').expired_heartbeats).toBe(1);
    db.close();
  });

  test('an impossible arrival day is CORRECTED, so it cannot buy a second window', () => {
    // A row cannot arrive after today. Believing one that says it did is how a
    // record outlives the window twice over: the cutoff has to climb past the
    // stamp before it even starts counting, so a stamp a year out would be held
    // for a year AND a window. Deleting it is the other error — a replica one
    // day fast would lose a heartbeat that did nothing wrong. So it is clamped.
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 90 });
    db.recordHeartbeat('year-ahead', 'brokkr', '2026-07-20', 2, payload('a'), '2027-07-28');
    // The exact boundary of the old, too-generous horizon: today + retention.
    db.recordHeartbeat('window-ahead', 'brokkr', '2026-07-20', 2, payload('b'), '2026-10-26');
    // Not a date at all — it sorts above every real day, so the same comparison
    // catches it. This is what makes the rule total.
    db.recordHeartbeat('sorts-high', 'brokkr', '2026-07-20', 2, payload('c'), 'not-a-day');
    // A replica a few minutes fast. Real data, left alone, costs at most a day.
    db.recordHeartbeat('bit-fast', 'brokkr', '2026-07-20', 2, payload('d'), '2026-07-29');

    const report = db.pruneRetention('2026-07-28');
    expect(report.clamped_heartbeats).toBe(3);
    expect(report.clamped_instances).toBe(3);
    expect(report.expired_heartbeats).toBe(0); // corrected, never destroyed
    expect(db.countHeartbeats('year-ahead', 'brokkr')).toBe(1);
    // The correction is in the STORE, not merely in the report's arithmetic.
    for (const id of ['year-ahead', 'window-ahead', 'sorts-high']) {
      expect(db.getHeartbeats(id, 'brokkr')[0]!.received_day).toBe('2026-07-28');
      expect(db.getInstance(id, 'brokkr')!.last_seen_day).toBe('2026-07-28');
    }
    // ...and a believable stamp is left exactly as it was.
    expect(db.getHeartbeats('bit-fast', 'brokkr')[0]!.received_day).toBe('2026-07-29');

    // Each corrected row now expires exactly one window after the prune that
    // corrected it — not a year later, and not a window after that.
    expect(db.pruneRetention('2026-10-25').expired_heartbeats).toBe(0);
    const expiry = db.pruneRetention('2026-10-26');
    expect(expiry.expired_heartbeats).toBe(3);
    expect(expiry.expired_instances).toBe(3);
    // The slightly-fast one keeps its own stamp and goes a single day later.
    expect(db.countHeartbeats('bit-fast', 'brokkr')).toBe(1);
    expect(db.pruneRetention('2026-10-27').expired_heartbeats).toBe(1);
    expect(db.countInstances()).toBe(0);
    db.close();
  });

  test('a malformed day BELOW the clamp still expires, on the ordinary cutoff', () => {
    // Nothing in this service writes one — `received_day` is always the server's
    // own UTC day. A malformed value sorting above tomorrow is caught by the
    // clamp; one sorting below it is left to the rising cutoff, which reaches it
    // at the same prune as its well-formed neighbour. Bounded is the
    // requirement; instant is not.
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 90 });
    db.recordHeartbeat('malformed', 'brokkr', '2026-07-20', 2, payload('b'), '2026-07-1X');
    db.recordHeartbeat('neighbour', 'brokkr', '2026-07-20', 2, payload('c'), '2026-07-19');
    db.recordHeartbeat('empty', 'brokkr', '2026-07-20', 2, payload('d'), '');

    // The empty string is below every cutoff and goes on the first prune; the
    // other two are untouched, and NOT clamped — they are not in the future.
    const first = db.pruneRetention('2026-07-28');
    expect(first.expired_heartbeats).toBe(1);
    expect(first.clamped_heartbeats).toBe(0);
    expect(db.countHeartbeats('malformed', 'brokkr')).toBe(1);

    expect(db.pruneRetention('2026-10-16').expired_heartbeats).toBe(0);
    // Both go together: the malformed value gets no more life than the real one.
    expect(db.pruneRetention('2026-10-17').expired_heartbeats).toBe(2);
    expect(db.countInstances()).toBe(0);
    db.close();
  });

  test('an identity row is never orphaned: it outlives every heartbeat keyed to it', () => {
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 90 });
    db.recordHeartbeat('mixed', 'brokkr', '2026-01-01', 2, payload('old'), '2026-01-01');
    db.recordHeartbeat('mixed', 'brokkr', '2026-07-20', 2, payload('new'), '2026-07-20');

    const report = db.pruneRetention('2026-07-28');
    expect(report.expired_heartbeats).toBe(1);
    // Still reporting, so the identity row stays — it is the only way to read
    // the row that survived, and first_report_day rides on it.
    expect(report.expired_instances).toBe(0);
    expect(db.getInstance('mixed', 'brokkr')).not.toBeNull();
    expect(db.getHeartbeats('mixed', 'brokkr').map((r) => r.day)).toEqual(['2026-07-20']);
    db.close();
  });

  test('a stopped install is fully forgotten: no identity row, and no way back to it', () => {
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 30 });
    db.recordHeartbeat('forgotten', 'brokkr', '2026-01-01', 2, payload('a'), '2026-01-01');
    db.recordHeartbeat('forgotten', 'saga', '2026-01-01', 2, payload('a'), '2026-01-01');
    db.pruneRetention('2026-07-28');

    // Both products' rows are gone, and the ONLY trace left anywhere in the
    // store is the admission ledger's count for that day — a number, with no
    // identity in it. That is the one thing deliberately retained.
    expect(db.countInstances()).toBe(0);
    expect(db.getInstance('forgotten', 'brokkr')).toBeNull();
    expect(db.getInstance('forgotten', 'saga')).toBeNull();
    expect(db.admittedOnDay('2026-01-01')).toBe(2);
    db.close();
  });

  test('a prune folds the write-ahead log back and truncates it, and says whether it did', () => {
    // Deleted rows land in the WAL first, where secure_delete has no reach. This
    // is storage hygiene rather than retention — the rows are deleted either
    // way — so the outcome rides the receipt instead of failing the prune, which
    // would report a committed prune as a failure and count towards taking the
    // service down.
    const dir = mkdtempSync(join(tmpdir(), 'collector-db-'));
    try {
      const path = join(dir, 'telemetry.db');
      const db = new TelemetryDb({ path, retentionDays: 30 });
      db.recordHeartbeat('id-1', 'brokkr', '2026-01-01', 2, payload('a'), '2026-01-01');
      const report = db.pruneRetention('2026-07-28');
      expect(report.expired_heartbeats).toBe(1);
      expect(report.wal_truncated).toBe(true);
      // Truncated means truncated: the log file is empty on disk.
      expect(statSync(`${path}-wal`).size).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a clock moved BACK cannot suspend retention — the cutoff is one-way', () => {
    // The one direction that would silently stop the promise: the cutoff
    // retreats, rows past the window are kept, and nothing anywhere says so.
    // The watermark is durable, so this survives a restart too.
    const dir = mkdtempSync(join(tmpdir(), 'collector-db-'));
    try {
      const path = join(dir, 'telemetry.db');
      const first = new TelemetryDb({ path, retentionDays: 30 });
      first.recordHeartbeat('id-1', 'brokkr', '2026-07-20', 2, payload('a'), '2026-07-20');
      expect(first.pruneRetention('2026-07-28').cutoff_day).toBe('2026-06-29');
      first.close();

      // The host comes back with its clock a year in the past.
      const second = new TelemetryDb({ path, retentionDays: 30 });
      const report = second.pruneRetention('2025-07-28');
      expect(report.effective_day).toBe('2026-07-28'); // the watermark won
      expect(report.cutoff_day).toBe('2026-06-29'); // ...so the cutoff did not retreat
      // ...and the row still expires on the real schedule rather than being
      // held indefinitely by a wrong clock.
      expect(second.pruneRetention('2025-01-01').expired_heartbeats).toBe(0);
      second.close();

      const third = new TelemetryDb({ path, retentionDays: 30 });
      expect(third.pruneRetention('2026-08-19').expired_heartbeats).toBe(1);
      expect(third.countInstances()).toBe(0);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a watermark that is not a calendar day is refused, not compared', () => {
    // Text comparison ranks 'zzz' above every real date, and `shiftDay` returns
    // what it cannot parse — so a cutoff of 'zzz' would delete every ISO date in
    // the store and then be written back to do it again tomorrow. One bad value
    // in a key/value table must not be able to empty the database.
    const dir = mkdtempSync(join(tmpdir(), 'collector-db-'));
    try {
      const path = join(dir, 'telemetry.db');
      const seed = new TelemetryDb({ path, retentionDays: 30 });
      seed.recordHeartbeat('id-1', 'brokkr', '2026-07-20', 2, payload('a'), '2026-07-20');
      seed.close();

      // 'zzz' sorts above every real date; '2026-02-30' has the right SHAPE and
      // is still not a day, so a regex would wave it through.
      for (const bad of ['zzz', '2026-02-30', '2026-7-1', '']) {
        const raw = new Database(path);
        raw
          .query('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('retention_watermark_day', bad);
        raw.close();

        const db = new TelemetryDb({ path, retentionDays: 30 });
        const report = db.pruneRetention('2026-07-28');
        expect(report.effective_day).toBe('2026-07-28'); // today, not the garbage
        expect(report.cutoff_day).toBe('2026-06-29');
        expect(report.expired_heartbeats).toBe(0);
        expect(db.countHeartbeats('id-1', 'brokkr')).toBe(1);
        db.close();
      }

      // ...and the unusable value is replaced rather than re-read every prune.
      const check = new Database(path, { readonly: true });
      const value = check
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'retention_watermark_day'")
        .get()?.value;
      check.close();
      expect(value).toBe('2026-07-28');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('under a regressed clock the CLAMP moves with the watermark, not with the wrong clock', () => {
    // Both halves have to use the same day. If the clamp kept using the host's
    // (wrong, earlier) today while the cutoff used the watermark, a row stamped
    // between the two would be clamped DOWN below the cutoff and deleted on the
    // spot — the regression turned into immediate data loss.
    const dir = mkdtempSync(join(tmpdir(), 'collector-db-'));
    try {
      const path = join(dir, 'telemetry.db');
      const first = new TelemetryDb({ path, retentionDays: 30 });
      first.recordHeartbeat('id-1', 'brokkr', '2026-07-20', 2, payload('a'), '2026-07-20');
      first.pruneRetention('2026-07-28'); // watermark := 2026-07-28
      first.close();

      const second = new TelemetryDb({ path, retentionDays: 30 });
      // A row stamped ahead of the regressed clock but behind the watermark.
      second.recordHeartbeat('later', 'brokkr', '2026-07-25', 2, payload('b'), '2026-07-26');
      const report = second.pruneRetention('2026-07-01'); // clock a month behind
      expect(report.effective_day).toBe('2026-07-28');
      expect(report.clamp_day).toBe('2026-07-29'); // from the watermark, not from 2026-07-01
      expect(report.clamped_heartbeats).toBe(0); // so nothing was "corrected"...
      expect(report.clamped_instances).toBe(0); // ...on either table...
      expect(report.expired_heartbeats).toBe(0); // ...and nothing was destroyed
      expect(second.getHeartbeats('later', 'brokkr')[0]!.received_day).toBe('2026-07-26');
      expect(second.getInstance('later', 'brokkr')!.last_seen_day).toBe('2026-07-26');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('pruneRetention REFUSES a day it cannot parse rather than computing a garbage cutoff', () => {
    // An unparseable day would flow into a text comparison and delete everything
    // or nothing. Both are silent; neither is acceptable in a delete path.
    const db = new TelemetryDb({ path: ':memory:' });
    db.recordHeartbeat('id-1', 'brokkr', '2026-07-20', 2, payload('a'), '2026-07-20');
    for (const bad of ['', 'today', '2026-7-1', '2026-02-30', '20260728']) {
      expect(() => db.pruneRetention(bad)).toThrow(/real UTC calendar day/);
    }
    expect(db.countHeartbeats('id-1', 'brokkr')).toBe(1);
    db.close();
  });
});

describe('the row cap behind the clock (a pathology bound, NOT retention)', () => {
  test('keeps the newest N rows per (instance, product), drops the oldest', () => {
    // Note the explicit cap: the retention window no longer doubles as one, so a
    // test about the cap has to say which control it is exercising.
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 90, maxRowsPerInstance: 3 });
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']) {
      db.recordHeartbeat('id-1', 'brokkr', day, 2, payload(day), day);
      db.recordHeartbeat('id-1', 'saga', day, 2, payload(day), day);
    }
    db.recordHeartbeat('id-2', 'brokkr', '2026-06-01', 2, payload('x'), '2026-06-01');

    const report = db.pruneRetention('2026-07-05');
    expect(report.capped_heartbeats).toBe(4); // 2 per (id-1, product)
    expect(report.expired_heartbeats).toBe(0); // nothing is old enough
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

  test('the default cap allows a whole ingest window of backfill, so it cannot pass for retention', () => {
    // A cap equal to the retention window would trim a backfilling install's
    // oldest days before the clock reached them — the cap doing retention's job,
    // which is the conflation this change exists to end.
    expect(maxRowsFor(90)).toBe(90 + INGEST_DAY_WINDOW_DAYS + 1);
    expect(new TelemetryDb({ path: ':memory:', retentionDays: 90 }).maxRowsPerInstance).toBe(maxRowsFor(90));

    const retentionDays = 5;
    const db = new TelemetryDb({ path: ':memory:', retentionDays });
    // A WHOLE window's worth of days plus a whole ingest window of backfill,
    // every row arriving on the same day — the widest legitimate holding this
    // store allows. A cap that merely matched the retention window, or any
    // number below `maxRowsFor`, would trim the oldest of these.
    const rows = maxRowsFor(retentionDays); // 5 + 30 + 1
    for (let i = 0; i < rows; i++) {
      const day = shiftDay('2026-07-28', -i);
      db.recordHeartbeat('backfiller', 'brokkr', day, 2, payload(day), '2026-07-28');
    }
    expect(db.countHeartbeats('backfiller', 'brokkr')).toBe(rows);

    const report = db.pruneRetention('2026-07-28');
    expect(report.capped_heartbeats).toBe(0);
    expect(report.expired_heartbeats).toBe(0);
    expect(db.countHeartbeats('backfiller', 'brokkr')).toBe(rows);

    // One row beyond it IS the pathology the cap is for, and only then.
    const extra = shiftDay('2026-07-28', -rows);
    db.recordHeartbeat('backfiller', 'brokkr', extra, 2, payload(extra), '2026-07-28');
    expect(db.pruneRetention('2026-07-28').capped_heartbeats).toBe(1);
    expect(db.getHeartbeats('backfiller', 'brokkr').map((r) => r.day)).not.toContain(extra);
    db.close();
  });

  test('a cap below 1 is refused, like a retention below 1', () => {
    expect(() => new TelemetryDb({ path: ':memory:', maxRowsPerInstance: 0 })).toThrow(/at least 1/);
    expect(() => new TelemetryDb({ path: ':memory:', maxRowsPerInstance: -1 })).toThrow(/at least 1/);
    expect(() => new TelemetryDb({ path: ':memory:', maxRowsPerInstance: 2.5 })).toThrow(/at least 1/);
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

  test('the ledger is NEVER pruned, so no clock movement can hand back a spent budget', () => {
    // Pruning it is the only operation that can free budget, and a clock-driven
    // prune is exactly the lever: jump forward past the horizon, let the prune
    // drop a day, move back, and that day is fresh again. The heartbeat and
    // identity prunes ARE clock-driven — they have to be, a time-based promise
    // needs a clock — but neither can refund anything, because the ledger they
    // are checked against only ever increases.
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 1, newInstancesPerDay: 1 });
    db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    for (const day of ['2026-07-10', '2026-07-11', '2027-01-01', '2030-01-01']) {
      db.recordHeartbeat(`id-${day}`, 'brokkr', day, 2, payload('a'), day);
    }
    // Prune far past every one of those days, then move the clock back.
    db.pruneRetention('2031-01-01');
    db.pruneRetention('2026-07-09');
    // The original day's row is still there, however far the clock has moved,
    // and every identity admitted on it has long since been expired.
    expect(db.admittedOnDay('2026-07-09')).toBe(1);
    expect(db.countInstances()).toBe(0);
    expect(db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
    db.close();
  });

  test('heartbeat rows ARE pruned while the ledger stays', () => {
    const db = new TelemetryDb({ path: ':memory:', retentionDays: 2 });
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']) {
      db.recordHeartbeat('id-1', 'brokkr', day, 2, payload(day), day);
    }
    expect(db.pruneRetention('2026-07-04').expired_heartbeats).toBe(2);
    expect(db.getHeartbeats('id-1', 'brokkr').map((r) => r.day)).toEqual(['2026-07-03', '2026-07-04']);
    expect(db.admittedOnDay('2026-07-01')).toBe(1);
    db.close();
  });

  test('a retention of zero is REFUSED, not honoured', () => {
    // Honouring it would delete every heartbeat on the next prune — "store
    // nothing" is not a supported configuration, and silently doing it would
    // be worse than saying so.
    expect(() => new TelemetryDb({ path: ':memory:', retentionDays: 0 })).toThrow(/at least 1/);
    expect(() => new TelemetryDb({ path: ':memory:', retentionDays: -5 })).toThrow(/at least 1/);
    expect(() => new TelemetryDb({ path: ':memory:', retentionDays: 1.5 })).toThrow(/at least 1/);
  });

  test('the prune cannot be used to reset the CURRENT day budget by restarting', () => {
    const db = new TelemetryDb({
      path: ':memory:',
      retentionDays: 1,
      newInstancesPerDay: 1,
    });
    db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    db.pruneRetention('2026-07-09'); // as the boot path does
    expect(db.admittedOnDay('2026-07-09')).toBe(1);
    expect(db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
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
