// SPIKE — `collector/tests/db.test.ts` ported to the D1 store.
//
// The transform is MECHANICAL: every `test(...)` callback became `async`, every
// store call gained `await`, and the store is constructed over the
// `D1OverSqlite` harness (see that file for what it does and does NOT prove)
// instead of a filesystem path. NO ASSERTION WAS RELAXED and no expected value
// was changed.
//
// A file-backed database that is CLOSED AND REOPENED becomes a second
// `TelemetryD1` over the SAME shim — which is the honest analogue, because that
// is what "durable, not in-memory" means when the store is D1: a different
// isolate talking to the same database.
//
// TWO TESTS FROM THE ORIGINAL ARE ABSENT, and they are absent because D1 cannot
// satisfy them, not because they were inconvenient:
//
//   1. 'file-backed database runs in WAL mode' — D1 refuses `PRAGMA
//      journal_mode` (`not authorized: SQLITE_AUTH`, measured). There is no
//      journal mode to assert.
//   2. 'a prune folds the write-ahead log back and truncates it, and says
//      whether it did' — D1 exposes no write-ahead log, refuses `PRAGMA
//      wal_checkpoint`, and there is no `-wal` file to `statSync`. The
//      behaviour this test guards does not exist on D1; `PruneReportD1` drops
//      the `wal_truncated` field for the same reason.
//
// Both losses are privacy-adjacent, not cosmetic — see the spike report.

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { INGEST_DAY_WINDOW_DAYS, shiftDay } from '../../../collector/src/day';
import { maxRowsFor, TelemetryD1, type TelemetryD1Config } from '../src/db-d1';
import { D1OverSqlite } from '../src/d1-over-sqlite';

const payload = (day: string) => JSON.stringify({ day, schema_version: 1, metrics: {} });

/** The current schema, as `migrations/0001_init.sql` defines it. */
const SCHEMA = `
  CREATE TABLE heartbeats (
    instance_id TEXT NOT NULL, product TEXT NOT NULL, day TEXT NOT NULL,
    schema_version INTEGER NOT NULL, payload TEXT NOT NULL, received_day TEXT NOT NULL,
    PRIMARY KEY (instance_id, product, day));
  CREATE TABLE instances (
    instance_id TEXT NOT NULL, product TEXT NOT NULL, first_seen_day TEXT NOT NULL,
    last_seen_day TEXT NOT NULL, first_report_day TEXT,
    PRIMARY KEY (instance_id, product));
  CREATE TABLE admissions (day TEXT PRIMARY KEY, admitted INTEGER NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX idx_heartbeats_received_day ON heartbeats (received_day);
`;

type StoreOpts = Omit<TelemetryD1Config, 'db'>;

/** A fresh store over a fresh database. Stands in for `{ path: ':memory:' }`. */
function makeDb(config: StoreOpts = {}): TelemetryD1 {
  const raw = new Database(':memory:');
  raw.exec(SCHEMA);
  return new TelemetryD1({ db: new D1OverSqlite(raw), ...config });
}

/** A raw database plus a factory for stores over it — the "same file" cases. */
function makeShared(): { attach: (config?: StoreOpts) => TelemetryD1 } {
  const raw = new Database(':memory:');
  raw.exec(SCHEMA);
  const shim = new D1OverSqlite(raw);
  return { attach: (config: StoreOpts = {}) => new TelemetryD1({ db: shim, ...config }) };
}

describe('TelemetryDb basics', () => {

  test('NO column anywhere can hold an address or key material', async () => {
    // The no-address-retention promise is a schema property, so it is asserted
    // against the schema rather than trusted to code review.
    // The store is created over a raw database we hold, so the schema can be
    // read back directly. `PRAGMA table_info` is the ONE pragma D1 permits
    // (measured), so this assertion survives the port unchanged.
    const raw = new Database(':memory:');
    raw.exec(SCHEMA);
    new TelemetryD1({ db: new D1OverSqlite(raw) });
    const names: string[] = [];
    for (const table of ['instances', 'heartbeats']) {
      for (const col of raw.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()) {
        names.push(`${table}.${col.name}`);
      }
    }
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
  });

  test('upsert maintains first/last_seen_day and replaces per (instance, product, day)', async () => {
    const db = makeDb();
    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-01', 2, payload('2026-07-01'), '2026-07-02');
    let inst = (await db.getInstance('id-1', 'brokkr'))!;
    expect(inst.first_seen_day).toBe('2026-07-02');
    expect(inst.last_seen_day).toBe('2026-07-02');
    expect(await db.countHeartbeats('id-1', 'brokkr')).toBe(1);

    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-01', 2, JSON.stringify({ marker: 'y' }), '2026-07-03');
    expect(await db.countHeartbeats('id-1', 'brokkr')).toBe(1);
    expect(JSON.parse((await db.getHeartbeats('id-1', 'brokkr'))[0]!.payload).marker).toBe('y');
    inst = (await db.getInstance('id-1', 'brokkr'))!;
    expect(inst.first_seen_day).toBe('2026-07-02'); // first seen never moves
    expect(inst.last_seen_day).toBe('2026-07-03');
  });

  test('the same id under two products is two independent series', async () => {
    const db = makeDb();
    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-01', 2, payload('brokkr'), '2026-07-01');
    await db.recordHeartbeat('id-1', 'saga', '2026-07-01', 2, payload('saga'), '2026-07-01');
    expect(await db.countHeartbeats('id-1', 'brokkr')).toBe(1);
    expect(await db.countHeartbeats('id-1', 'saga')).toBe(1);
    expect(JSON.parse((await db.getHeartbeats('id-1', 'brokkr'))[0]!.payload).day).toBe('brokkr');
    expect(JSON.parse((await db.getHeartbeats('id-1', 'saga'))[0]!.payload).day).toBe('saga');
  });

  test('getHeartbeats returns days ascending; the trim keeps the most recent N (still ascending)', async () => {
    const db = makeDb();
    for (const day of ['2026-07-03', '2026-07-01', '2026-07-02']) {
      await db.recordHeartbeat('id-1', 'brokkr', day, 2, payload(day), day);
    }
    expect((await db.getHeartbeats('id-1', 'brokkr')).map((r) => r.day)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect((await db.getHeartbeats('id-1', 'brokkr', 2)).map((r) => r.day)).toEqual(['2026-07-02', '2026-07-03']);
  });

  test('deleteInstance purges the identity across EVERY product, idempotently', async () => {
    const db = makeDb();
    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-01', 2, payload('a'), '2026-07-01');
    await db.recordHeartbeat('id-1', 'saga', '2026-07-01', 2, payload('b'), '2026-07-01');
    await db.recordHeartbeat('id-2', 'brokkr', '2026-07-01', 2, payload('c'), '2026-07-01');

    await db.deleteInstance('id-1');
    expect(await db.getInstance('id-1', 'brokkr')).toBeNull();
    expect(await db.getInstance('id-1', 'saga')).toBeNull();
    expect(await db.countHeartbeats('id-1', 'brokkr')).toBe(0);
    expect(await db.countHeartbeats('id-1', 'saga')).toBe(0);
    // Scoped: another identity is untouched.
    expect(await db.countHeartbeats('id-2', 'brokkr')).toBe(1);
    await db.deleteInstance('id-1');
    await db.deleteInstance('never-seen');
  });
});

describe('retention is a CLOCK — rows expire by age, whether or not an install still reports', () => {
  test('an install that STOPPED reporting has its rows deleted once they age past the window', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Before the clock, the prune was a
    // per-(instance, product) row cap and nothing else: this installation has
    // ten rows, far fewer than the cap, so no prune ever deleted one of them and
    // its data was kept indefinitely — three years after it last said anything.
    // The published commitment ("everything already held expires within a
    // quarter") was therefore false for exactly the population least able to
    // notice: the ones who stopped.
    const db = makeDb({ retentionDays: 90 });
    const days = Array.from({ length: 10 }, (_, i) => `2023-01-${String(i + 1).padStart(2, '0')}`);
    for (const day of days) await db.recordHeartbeat('gone-quiet', 'brokkr', day, 2, payload(day), day);
    expect(await db.countHeartbeats('gone-quiet', 'brokkr')).toBe(10);

    const report = await db.pruneRetention('2026-07-28');
    expect(report.expired_heartbeats).toBe(10);
    // ...and the cap deleted NOTHING, which is the point: with only the cap
    // there was no control that could ever have touched these rows.
    expect(report.capped_heartbeats).toBe(0);
    expect(await db.countHeartbeats('gone-quiet', 'brokkr')).toBe(0);
    // The identity row goes too — it is pseudonymous personal data by itself.
    expect(report.expired_instances).toBe(1);
    expect(await db.getInstance('gone-quiet', 'brokkr')).toBeNull();
    expect(await db.countInstances()).toBe(0);
  });

  test('the boundary: the window counts the arrival day, and the day after it is gone', async () => {
    const db = makeDb({ retentionDays: 90 });
    // 90 days ending 2026-07-28 inclusive starts on 2026-04-30. One row on the
    // first day inside the window, one on the last day outside it.
    await db.recordHeartbeat('edge', 'brokkr', '2026-04-30', 2, payload('in'), '2026-04-30');
    await db.recordHeartbeat('edge', 'brokkr', '2026-04-29', 2, payload('out'), '2026-04-29');

    const report = await db.pruneRetention('2026-07-28');
    expect(report.cutoff_day).toBe('2026-04-30');
    expect(report.expired_heartbeats).toBe(1);
    expect((await db.getHeartbeats('edge', 'brokkr')).map((r) => r.day)).toEqual(['2026-04-30']);
    // One day later the surviving row is on the wrong side of the cutoff.
    expect((await db.pruneRetention('2026-07-29')).expired_heartbeats).toBe(1);
    expect(await db.countHeartbeats('edge', 'brokkr')).toBe(0);
  });

  test('the clock is on ARRIVAL, so a late backfill gets its full window', async () => {
    // A heartbeat for an old `day` that arrived today has been held for one day,
    // not for a month, and retention is a promise about how long WE hold it.
    // Keying on `day` would give this row two months of window instead of three,
    // purely because delivery was late.
    const db = makeDb({ retentionDays: 90 });
    await db.recordHeartbeat('backfiller', 'brokkr', '2026-06-28', 2, payload('late'), '2026-07-28');
    expect((await db.pruneRetention('2026-07-28')).expired_heartbeats).toBe(0);
    expect(await db.countHeartbeats('backfiller', 'brokkr')).toBe(1);
    // It survives until 90 days after it ARRIVED...
    expect((await db.pruneRetention('2026-10-25')).expired_heartbeats).toBe(0);
    // ...and no longer. (Had `day` been the basis it would already have gone.)
    expect((await db.pruneRetention('2026-10-26')).expired_heartbeats).toBe(1);
  });

  test('an impossible arrival day is CORRECTED, so it cannot buy a second window', async () => {
    // A row cannot arrive after today. Believing one that says it did is how a
    // record outlives the window twice over: the cutoff has to climb past the
    // stamp before it even starts counting, so a stamp a year out would be held
    // for a year AND a window. Deleting it is the other error — a replica one
    // day fast would lose a heartbeat that did nothing wrong. So it is clamped.
    const db = makeDb({ retentionDays: 90 });
    await db.recordHeartbeat('year-ahead', 'brokkr', '2026-07-20', 2, payload('a'), '2027-07-28');
    // The exact boundary of the old, too-generous horizon: today + retention.
    await db.recordHeartbeat('window-ahead', 'brokkr', '2026-07-20', 2, payload('b'), '2026-10-26');
    // Not a date at all — it sorts above every real day, so the same comparison
    // catches it. This is what makes the rule total.
    await db.recordHeartbeat('sorts-high', 'brokkr', '2026-07-20', 2, payload('c'), 'not-a-day');
    // A replica a few minutes fast. Real data, left alone, costs at most a day.
    await db.recordHeartbeat('bit-fast', 'brokkr', '2026-07-20', 2, payload('d'), '2026-07-29');

    const report = await db.pruneRetention('2026-07-28');
    expect(report.clamped_heartbeats).toBe(3);
    expect(report.clamped_instances).toBe(3);
    expect(report.expired_heartbeats).toBe(0); // corrected, never destroyed
    expect(await db.countHeartbeats('year-ahead', 'brokkr')).toBe(1);
    // The correction is in the STORE, not merely in the report's arithmetic.
    for (const id of ['year-ahead', 'window-ahead', 'sorts-high']) {
      expect((await db.getHeartbeats(id, 'brokkr'))[0]!.received_day).toBe('2026-07-28');
      expect((await db.getInstance(id, 'brokkr'))!.last_seen_day).toBe('2026-07-28');
    }
    // ...and a believable stamp is left exactly as it was.
    expect((await db.getHeartbeats('bit-fast', 'brokkr'))[0]!.received_day).toBe('2026-07-29');

    // Each corrected row now expires exactly one window after the prune that
    // corrected it — not a year later, and not a window after that.
    expect((await db.pruneRetention('2026-10-25')).expired_heartbeats).toBe(0);
    const expiry = await db.pruneRetention('2026-10-26');
    expect(expiry.expired_heartbeats).toBe(3);
    expect(expiry.expired_instances).toBe(3);
    // The slightly-fast one keeps its own stamp and goes a single day later.
    expect(await db.countHeartbeats('bit-fast', 'brokkr')).toBe(1);
    expect((await db.pruneRetention('2026-10-27')).expired_heartbeats).toBe(1);
    expect(await db.countInstances()).toBe(0);
  });

  test('a malformed day BELOW the clamp still expires, on the ordinary cutoff', async () => {
    // Nothing in this service writes one — `received_day` is always the server's
    // own UTC day. A malformed value sorting above tomorrow is caught by the
    // clamp; one sorting below it is left to the rising cutoff, which reaches it
    // at the same prune as its well-formed neighbour. Bounded is the
    // requirement; instant is not.
    const db = makeDb({ retentionDays: 90 });
    await db.recordHeartbeat('malformed', 'brokkr', '2026-07-20', 2, payload('b'), '2026-07-1X');
    await db.recordHeartbeat('neighbour', 'brokkr', '2026-07-20', 2, payload('c'), '2026-07-19');
    await db.recordHeartbeat('empty', 'brokkr', '2026-07-20', 2, payload('d'), '');

    // The empty string is below every cutoff and goes on the first prune; the
    // other two are untouched, and NOT clamped — they are not in the future.
    const first = await db.pruneRetention('2026-07-28');
    expect(first.expired_heartbeats).toBe(1);
    expect(first.clamped_heartbeats).toBe(0);
    expect(await db.countHeartbeats('malformed', 'brokkr')).toBe(1);

    expect((await db.pruneRetention('2026-10-16')).expired_heartbeats).toBe(0);
    // Both go together: the malformed value gets no more life than the real one.
    expect((await db.pruneRetention('2026-10-17')).expired_heartbeats).toBe(2);
    expect(await db.countInstances()).toBe(0);
  });

  test('an identity row is never orphaned: it outlives every heartbeat keyed to it', async () => {
    const db = makeDb({ retentionDays: 90 });
    await db.recordHeartbeat('mixed', 'brokkr', '2026-01-01', 2, payload('old'), '2026-01-01');
    await db.recordHeartbeat('mixed', 'brokkr', '2026-07-20', 2, payload('new'), '2026-07-20');

    const report = await db.pruneRetention('2026-07-28');
    expect(report.expired_heartbeats).toBe(1);
    // Still reporting, so the identity row stays — it is the only way to read
    // the row that survived, and first_report_day rides on it.
    expect(report.expired_instances).toBe(0);
    expect(await db.getInstance('mixed', 'brokkr')).not.toBeNull();
    expect((await db.getHeartbeats('mixed', 'brokkr')).map((r) => r.day)).toEqual(['2026-07-20']);
  });

  test('a stopped install is fully forgotten: no identity row, and no way back to it', async () => {
    const db = makeDb({ retentionDays: 30 });
    await db.recordHeartbeat('forgotten', 'brokkr', '2026-01-01', 2, payload('a'), '2026-01-01');
    await db.recordHeartbeat('forgotten', 'saga', '2026-01-01', 2, payload('a'), '2026-01-01');
    await db.pruneRetention('2026-07-28');

    // Both products' rows are gone, and the ONLY trace left anywhere in the
    // store is the admission ledger's count for that day — a number, with no
    // identity in it. That is the one thing deliberately retained.
    expect(await db.countInstances()).toBe(0);
    expect(await db.getInstance('forgotten', 'brokkr')).toBeNull();
    expect(await db.getInstance('forgotten', 'saga')).toBeNull();
    expect(await db.admittedOnDay('2026-01-01')).toBe(2);
  });

  test('the identity row cannot outlive its last heartbeat, even when the CAP took the newest one', async () => {
    // The cap deletes by `day`, so it can remove the row that contributed the
    // newest ARRIVAL. An instance expiry that also demanded `last_seen_day <
    // cutoff` would then find a last-seen day pointing at a row that no longer
    // exists, and keep the identity for up to a whole window after the last
    // thing it described was deleted — publishing it in the aggregate as an
    // installation with nothing held for it.
    const db = makeDb({ retentionDays: 30, maxRowsPerInstance: 1 });
    // An OLD day that arrived recently — so it carries the identity's newest
    // arrival, and the cap (which orders by `day`) is the one that takes it.
    await db.recordHeartbeat('capped', 'brokkr', '2026-01-01', 2, payload('late'), '2026-07-20');
    // A newer day that arrived earlier: the cap keeps this one.
    await db.recordHeartbeat('capped', 'brokkr', '2026-06-30', 2, payload('early'), '2026-06-30');
    expect((await db.getInstance('capped', 'brokkr'))!.last_seen_day).toBe('2026-07-20');

    const first = await db.pruneRetention('2026-07-28');
    expect(first.expired_heartbeats).toBe(0); // both arrivals are inside the window
    expect(first.capped_heartbeats).toBe(1); // ...and the cap takes the late arrival
    // `last_seen_day` now points at a row that no longer exists.
    expect((await db.getInstance('capped', 'brokkr'))!.last_seen_day).toBe('2026-07-20');

    // Three days later the survivor ages out, and with it the whole identity —
    // under the old condition this row would have been kept until 2026-08-19,
    // long after the last thing it described was deleted.
    const second = await db.pruneRetention('2026-07-31');
    expect(second.expired_heartbeats).toBe(1);
    expect(await db.countHeartbeats('capped', 'brokkr')).toBe(0);
    expect(second.expired_instances).toBe(1);
    expect(await db.getInstance('capped', 'brokkr')).toBeNull();
    // ...so the public aggregate cannot report an installation with nothing held.
    expect(await db.aggregates('2026-01-01')).toEqual([]);
  });


  test('a clock moved BACK cannot suspend retention — the cutoff is one-way', async () => {
    // The one direction that would silently stop the promise: the cutoff
    // retreats, rows past the window are kept, and nothing anywhere says so.
    // The watermark is durable, so this survives a restart too.
    const { attach } = makeShared();
    const first = attach({ retentionDays: 30 });
    await first.recordHeartbeat('id-1', 'brokkr', '2026-07-20', 2, payload('a'), '2026-07-20');
    expect((await first.pruneRetention('2026-07-28')).cutoff_day).toBe('2026-06-29');
    // The host comes back with its clock a year in the past.
    const second = attach({ retentionDays: 30 });
    const report = await second.pruneRetention('2025-07-28');
    expect(report.effective_day).toBe('2026-07-28'); // the watermark won
    expect(report.cutoff_day).toBe('2026-06-29'); // ...so the cutoff did not retreat
    // ...and the row still expires on the real schedule rather than being
    // held indefinitely by a wrong clock.
    expect((await second.pruneRetention('2025-01-01')).expired_heartbeats).toBe(0);
    const third = attach({ retentionDays: 30 });
    expect((await third.pruneRetention('2026-08-19')).expired_heartbeats).toBe(1);
    expect(await third.countInstances()).toBe(0);
  });

  test('a watermark that is not a calendar day is refused, not compared', async () => {
    // Text comparison ranks 'zzz' above every real date, and `shiftDay` returns
    // what it cannot parse — so a cutoff of 'zzz' would delete every ISO date in
    // the store and then be written back to do it again tomorrow. One bad value
    // in a key/value table must not be able to empty the database.
    const raw = new Database(':memory:');
    raw.exec(SCHEMA);
    const shim = new D1OverSqlite(raw);
    const seed = new TelemetryD1({ db: shim, retentionDays: 30 });
    await seed.recordHeartbeat('id-1', 'brokkr', '2026-07-20', 2, payload('a'), '2026-07-20');
    // 'zzz' sorts above every real date; '2026-02-30' has the right SHAPE and
    // is still not a day, so a regex would wave it through.
    for (const bad of ['zzz', '2026-02-30', '2026-7-1', '']) {
      raw
        .query('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('retention_watermark_day', bad);
      const db = new TelemetryD1({ db: shim, retentionDays: 30 });
      const report = await db.pruneRetention('2026-07-28');
      expect(report.effective_day).toBe('2026-07-28'); // today, not the garbage
      expect(report.cutoff_day).toBe('2026-06-29');
      expect(report.expired_heartbeats).toBe(0);
      expect(await db.countHeartbeats('id-1', 'brokkr')).toBe(1);
    }

    // ...and the unusable value is replaced rather than re-read every prune.
    const value = raw
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'retention_watermark_day'")
      .get()?.value;
    expect(value).toBe('2026-07-28');
  });

  test('under a regressed clock the CLAMP moves with the watermark, not with the wrong clock', async () => {
    // Both halves have to use the same day. If the clamp kept using the host's
    // (wrong, earlier) today while the cutoff used the watermark, a row stamped
    // between the two would be clamped DOWN below the cutoff and deleted on the
    // spot — the regression turned into immediate data loss.
    const { attach } = makeShared();
    const first = attach({ retentionDays: 30 });
    await first.recordHeartbeat('id-1', 'brokkr', '2026-07-20', 2, payload('a'), '2026-07-20');
    await first.pruneRetention('2026-07-28'); // watermark := 2026-07-28
    const second = attach({ retentionDays: 30 });
    // A row stamped ahead of the regressed clock but behind the watermark.
    await second.recordHeartbeat('later', 'brokkr', '2026-07-25', 2, payload('b'), '2026-07-26');
    const report = await second.pruneRetention('2026-07-01'); // clock a month behind
    expect(report.effective_day).toBe('2026-07-28');
    expect(report.clamp_day).toBe('2026-07-29'); // from the watermark, not from 2026-07-01
    expect(report.clamped_heartbeats).toBe(0); // so nothing was "corrected"...
    expect(report.clamped_instances).toBe(0); // ...on either table...
    expect(report.expired_heartbeats).toBe(0); // ...and nothing was destroyed
    expect((await second.getHeartbeats('later', 'brokkr'))[0]!.received_day).toBe('2026-07-26');
    expect((await second.getInstance('later', 'brokkr'))!.last_seen_day).toBe('2026-07-26');
  });

  test('pruneRetention REFUSES a day it cannot parse rather than computing a garbage cutoff', async () => {
    // An unparseable day would flow into a text comparison and delete everything
    // or nothing. Both are silent; neither is acceptable in a delete path.
    const db = makeDb();
    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-20', 2, payload('a'), '2026-07-20');
    for (const bad of ['', 'today', '2026-7-1', '2026-02-30', '20260728']) {
      // PORT COST: a synchronous `expect(() => ...).toThrow()` becomes a
      // rejection assertion once the store is async. Mechanical, but it is a
      // real edit in every test that asserts a store throw.
      await expect(db.pruneRetention(bad)).rejects.toThrow(/real UTC calendar day/);
    }
    expect(await db.countHeartbeats('id-1', 'brokkr')).toBe(1);
  });
});

describe('the row cap behind the clock (a pathology bound, NOT retention)', () => {
  test('keeps the newest N rows per (instance, product), drops the oldest', async () => {
    // Note the explicit cap: the retention window no longer doubles as one, so a
    // test about the cap has to say which control it is exercising.
    const db = makeDb({ retentionDays: 90, maxRowsPerInstance: 3 });
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']) {
      await db.recordHeartbeat('id-1', 'brokkr', day, 2, payload(day), day);
      await db.recordHeartbeat('id-1', 'saga', day, 2, payload(day), day);
    }
    await db.recordHeartbeat('id-2', 'brokkr', '2026-06-01', 2, payload('x'), '2026-06-01');

    const report = await db.pruneRetention('2026-07-05');
    expect(report.capped_heartbeats).toBe(4); // 2 per (id-1, product)
    expect(report.expired_heartbeats).toBe(0); // nothing is old enough
    expect((await db.getHeartbeats('id-1', 'brokkr')).map((r) => r.day)).toEqual([
      '2026-07-03', '2026-07-04', '2026-07-05',
    ]);
    // Partitioning is per PRODUCT too — saga's series is not eaten by brokkr's.
    expect((await db.getHeartbeats('id-1', 'saga')).map((r) => r.day)).toEqual([
      '2026-07-03', '2026-07-04', '2026-07-05',
    ]);
    expect((await db.getHeartbeats('id-2', 'brokkr')).map((r) => r.day)).toEqual(['2026-06-01']);
  });

  test('the default cap allows a whole ingest window of backfill, so it cannot pass for retention', async () => {
    // A cap equal to the retention window would trim a backfilling install's
    // oldest days before the clock reached them — the cap doing retention's job,
    // which is the conflation this change exists to end.
    expect(maxRowsFor(90)).toBe(90 + INGEST_DAY_WINDOW_DAYS + 1);
    expect(makeDb({ retentionDays: 90 }).maxRowsPerInstance).toBe(maxRowsFor(90));

    const retentionDays = 5;
    const db = makeDb({ retentionDays });
    // A WHOLE window's worth of days plus a whole ingest window of backfill,
    // every row arriving on the same day — the widest legitimate holding this
    // store allows. A cap that merely matched the retention window, or any
    // number below `maxRowsFor`, would trim the oldest of these.
    const rows = maxRowsFor(retentionDays); // 5 + 30 + 1
    for (let i = 0; i < rows; i++) {
      const day = shiftDay('2026-07-28', -i);
      await db.recordHeartbeat('backfiller', 'brokkr', day, 2, payload(day), '2026-07-28');
    }
    expect(await db.countHeartbeats('backfiller', 'brokkr')).toBe(rows);

    const report = await db.pruneRetention('2026-07-28');
    expect(report.capped_heartbeats).toBe(0);
    expect(report.expired_heartbeats).toBe(0);
    expect(await db.countHeartbeats('backfiller', 'brokkr')).toBe(rows);

    // One row beyond it IS the pathology the cap is for, and only then.
    const extra = shiftDay('2026-07-28', -rows);
    await db.recordHeartbeat('backfiller', 'brokkr', extra, 2, payload(extra), '2026-07-28');
    expect((await db.pruneRetention('2026-07-28')).capped_heartbeats).toBe(1);
    expect((await db.getHeartbeats('backfiller', 'brokkr')).map((r) => r.day)).not.toContain(extra);
  });

  test('a cap below 1 is refused, like a retention below 1', async () => {
    expect(() => makeDb({ maxRowsPerInstance: 0 })).toThrow(/at least 1/);
    expect(() => makeDb({ maxRowsPerInstance: -1 })).toThrow(/at least 1/);
    expect(() => makeDb({ maxRowsPerInstance: 2.5 })).toThrow(/at least 1/);
  });
});

describe('admission control — the decision and the write are one transaction', () => {
  test('an unseen identity beyond the absolute ceiling is refused, and nothing is written', async () => {
    const db = makeDb({ maxInstances: 1 });
    expect(await db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: true,
      existing: false,
    });

    expect(await db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('b'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'instance_capacity',
    });
    // A refusal must leave NO trace — otherwise the refusal itself consumes
    // the capacity it was protecting.
    expect(await db.getInstance('id-2', 'brokkr')).toBeNull();
    expect(await db.countHeartbeats('id-2', 'brokkr')).toBe(0);
    expect(await db.countInstances()).toBe(1);

    // The SAME id under a different product is a different identity, and so is
    // also subject to the ceiling.
    expect(await db.recordHeartbeat('id-1', 'saga', '2026-07-09', 2, payload('c'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'instance_capacity',
    });
    // The established identity keeps writing.
    expect(await db.recordHeartbeat('id-1', 'brokkr', '2026-07-08', 2, payload('d'), '2026-07-09')).toEqual({
      ok: true,
      existing: true,
    });
  });

  test('the daily budget bounds how fast the ceiling can be approached, and resets with the day', async () => {
    const db = makeDb({ maxInstances: 100, newInstancesPerDay: 2 });
    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    await db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    expect(await db.admittedOnDay('2026-07-09')).toBe(2);

    expect(await db.recordHeartbeat('id-3', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
    // Established installs keep writing while the budget is exhausted.
    expect((await db.recordHeartbeat('id-1', 'brokkr', '2026-07-08', 2, payload('a'), '2026-07-09')).ok).toBe(true);
    // A new day restores the budget.
    expect(await db.recordHeartbeat('id-3', 'brokkr', '2026-07-10', 2, payload('a'), '2026-07-10')).toEqual({
      ok: true,
      existing: false,
    });
  });

  test('the ledger is append-only: delete-and-remint cannot buy back budget', async () => {
    // Deriving the daily count from instances.first_seen_day would fall again
    // on delete, so mint → delete → mint would be unbounded.
    const db = makeDb({ maxInstances: 100, newInstancesPerDay: 2 });
    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    await db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');

    await db.deleteInstance('id-1');
    await db.deleteInstance('id-2');
    expect(await db.countInstances()).toBe(0);
    expect(await db.admittedOnDay('2026-07-09')).toBe(2); // ledger unmoved

    expect(await db.recordHeartbeat('id-3', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
  });

  test('the daily budget is durable, not in-memory: a restart does not reset it', async () => {
    const { attach } = makeShared();
    const first = attach({ newInstancesPerDay: 1 });
    await first.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    expect(await first.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
    const second = attach({ newInstancesPerDay: 1 });
    expect(await second.admittedOnDay('2026-07-09')).toBe(1);
    expect(await second.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
  });

  test('a second process on the same file cannot walk past the ceiling', async () => {
    // Two handles on one database are the same shape as two replicas — and on
    // Workers, two isolates. THIS IS THE TEST THAT MATTERS MOST FOR THE PORT.
    // The original passes because the check and the insert share one IMMEDIATE
    // transaction. D1 refuses IMMEDIATE, so the D1 store instead carries the
    // capacity test as a `WHERE` clause on the insert, inside an atomic
    // `batch()`. If that rewrite is wrong, this is where it shows.
    const { attach } = makeShared();
    const a = attach({ maxInstances: 1 });
    const b = attach({ maxInstances: 1 });
    expect((await a.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).ok).toBe(true);
    expect(await b.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'instance_capacity',
    });
    expect(await b.countInstances()).toBe(1);
  });

  test('a zero daily budget disables that check without disabling the ceiling', async () => {
    const db = makeDb({ maxInstances: 2, newInstancesPerDay: 0 });
    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    await db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    expect(await db.recordHeartbeat('id-3', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'instance_capacity',
    });
  });

  test('the ledger is NEVER pruned, so no clock movement can hand back a spent budget', async () => {
    // Pruning it is the only operation that can free budget, and a clock-driven
    // prune is exactly the lever: jump forward past the horizon, let the prune
    // drop a day, move back, and that day is fresh again. The heartbeat and
    // identity prunes ARE clock-driven — they have to be, a time-based promise
    // needs a clock — but neither can refund anything, because the ledger they
    // are checked against only ever increases.
    const db = makeDb({ retentionDays: 1, newInstancesPerDay: 1 });
    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    for (const day of ['2026-07-10', '2026-07-11', '2027-01-01', '2030-01-01']) {
      await db.recordHeartbeat(`id-${day}`, 'brokkr', day, 2, payload('a'), day);
    }
    // Prune far past every one of those days, then move the clock back.
    await db.pruneRetention('2031-01-01');
    await db.pruneRetention('2026-07-09');
    // The original day's row is still there, however far the clock has moved,
    // and every identity admitted on it has long since been expired.
    expect(await db.admittedOnDay('2026-07-09')).toBe(1);
    expect(await db.countInstances()).toBe(0);
    expect(await db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
  });

  test('heartbeat rows ARE pruned while the ledger stays', async () => {
    const db = makeDb({ retentionDays: 2 });
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']) {
      await db.recordHeartbeat('id-1', 'brokkr', day, 2, payload(day), day);
    }
    expect((await db.pruneRetention('2026-07-04')).expired_heartbeats).toBe(2);
    expect((await db.getHeartbeats('id-1', 'brokkr')).map((r) => r.day)).toEqual(['2026-07-03', '2026-07-04']);
    expect(await db.admittedOnDay('2026-07-01')).toBe(1);
  });

  test('a retention of zero is REFUSED, not honoured', async () => {
    // Honouring it would delete every heartbeat on the next prune — "store
    // nothing" is not a supported configuration, and silently doing it would
    // be worse than saying so.
    expect(() => makeDb({ retentionDays: 0 })).toThrow(/at least 1/);
    expect(() => makeDb({ retentionDays: -5 })).toThrow(/at least 1/);
    expect(() => makeDb({ retentionDays: 1.5 })).toThrow(/at least 1/);
  });

  test('the prune cannot be used to reset the CURRENT day budget by restarting', async () => {
    const db = makeDb({ retentionDays: 1,
      newInstancesPerDay: 1,
    });
    await db.recordHeartbeat('id-1', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09');
    await db.pruneRetention('2026-07-09'); // as the boot path does
    expect(await db.admittedOnDay('2026-07-09')).toBe(1);
    expect(await db.recordHeartbeat('id-2', 'brokkr', '2026-07-09', 2, payload('a'), '2026-07-09')).toEqual({
      ok: false,
      reason: 'daily_admission_budget',
    });
  });
});

describe('aggregates', () => {
  test('grouped per product, with an active window, and NO total', async () => {
    const db = makeDb();
    await db.recordHeartbeat('a', 'brokkr', '2026-07-01', 2, payload('x'), '2026-07-01');
    await db.recordHeartbeat('a', 'brokkr', '2026-07-09', 2, payload('x'), '2026-07-09');
    await db.recordHeartbeat('b', 'brokkr', '2026-01-01', 2, payload('x'), '2026-01-01');
    await db.recordHeartbeat('c', 'saga', '2026-07-09', 2, payload('x'), '2026-07-09');

    const rows = await db.aggregates('2026-06-12');
    expect(rows).toEqual([
      { product: 'brokkr', installs_seen: 2, installs_active: 1, days_reported: 3 },
      { product: 'saga', installs_seen: 1, installs_active: 1, days_reported: 1 },
    ]);
  });
});