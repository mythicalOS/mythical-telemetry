// Storage + privacy posture. bun:sqlite (WAL), prepared statements ONLY —
// never string interpolation of a value. Two tables:
//
//   instances (instance_id, product, first_seen_day, last_seen_day)
//              PRIMARY KEY (instance_id, product)
//   heartbeats(instance_id, product, day, schema_version, payload, received_day)
//              PRIMARY KEY (instance_id, product, day)
//
// `product` is part of both keys (plan §11). Each product derives its OWN
// identity, so the same id appearing under two products is not expected — but
// without the column in the key, one product's heartbeat would overwrite
// another's for the same day, and that is a data-loss bug, not a theoretical
// one.
//
// `schema_version` records which heartbeat schema the stored `payload` is.
// There is exactly one, so today the column only ever holds 1. It is kept
// because it is the durable evidence a future second schema would need: a
// store whose rows cannot say what shape they are is a store that has to guess.
// Nothing is normalized on the way in or at rest — a document is stored as the
// validator accepted it.
//
// Privacy properties, all schema-level rather than promises:
//   • NO IP COLUMN ANYWHERE. The rate limiter's per-source state is in-memory
//     and process-lifetime only; it is never written here.
//   • No key material at rest. Authorization is recomputed per request from
//     the presented secret; nothing derived from it is stored.
//   • `received_day` is DAY granularity. An exact receive timestamp would
//     fingerprint an installation's check-in cadence.
//   • BOTH tables expire. `pruneRetention` is an age-based clock on
//     `received_day`, and an `instances` row — a stable id plus the days it was
//     active, which is pseudonymous personal data in its own right — goes with
//     the last heartbeat of that identity rather than living for ever. The only
//     thing that outlives an installation here is the `admissions` ledger, which
//     holds day-by-day COUNTS and no identity at all.
//
// Bounded growth: the age-based retention clock below, a per-instance row cap
// behind it, and admission control on never-seen identities (see `admit`).

import { Database, type Statement } from 'bun:sqlite';
import { dayToEpochUtc, INGEST_DAY_WINDOW_DAYS, shiftDay } from './day';
import { migrate, type MigrationReport } from './migrate';

/**
 * The retention window, in days. This is an AGE — how long a row may be held
 * after it arrives — and it is a DECLARED privacy commitment, not a capacity
 * tuning knob: the published notice states this number, so lengthening it
 * silently would make that notice false. Change it only alongside the notice.
 *
 * The trade was made deliberately: 400 days would allow year-on-year comparison,
 * 90 does not. The shorter window was chosen because it also makes the opt-out
 * honest — telemetry off stops collection and everything already held expires
 * within a quarter, which is a sentence worth being able to write.
 *
 * It was NOT a sentence worth writing until 2026-07: this number used to be the
 * per-(instance, product) ROW CAP and nothing else. An install reporting daily
 * kept its newest 90 rows, which coincidentally resembled 90 days — but an
 * install that reported for a fortnight and then stopped had fewer rows than the
 * cap, so no row of it was ever deleted and its data was kept indefinitely. The
 * commitment had no clock. `pruneRetention` is that clock; the cap survives
 * behind it as a bound on pathological row counts and is NOT the retention
 * control.
 */
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_MAX_INSTANCES = 100_000;
export const DEFAULT_NEW_INSTANCES_PER_DAY = 5_000;

/**
 * The default row cap for a given retention window.
 *
 * Derived, never a second literal. Within one window an install can hold one row
 * per distinct `day` it reports, and ingest accepts a `day` up to
 * INGEST_DAY_WINDOW_DAYS old — so an install backfilling as hard as ingest allows
 * legitimately holds `retentionDays + INGEST_DAY_WINDOW_DAYS + 1` rows. A cap set
 * at the retention window itself would trim that install's oldest days before the
 * clock reached them: the cap would be doing retention's job again, exactly the
 * conflation this whole change exists to end.
 */
export function maxRowsFor(retentionDays: number): number {
  return retentionDays + INGEST_DAY_WINDOW_DAYS + 1;
}

export interface TelemetryDbConfig {
  /** SQLite file path, or ':memory:' for tests. */
  path: string;
  /** Age-based retention window in days. Must be at least 1 — see the constructor. */
  retentionDays?: number;
  /**
   * Pathology bound on rows per (instance, product). Defaults to
   * `maxRowsFor(retentionDays)`. Setting it below that makes the cap — not the
   * clock — the control that decides when history disappears.
   */
  maxRowsPerInstance?: number;
  /** Absolute ceiling on distinct (instance_id, product) identities. */
  maxInstances?: number;
  /** Global budget on identities admitted for the FIRST time on one UTC day. */
  newInstancesPerDay?: number;
}

/**
 * What one prune actually deleted. Returned rather than summed into a single
 * number because "the clock deleted this" and "the pathology cap deleted this"
 * are different facts, and a test — or an operator on /metrics — must be able to
 * tell which control is doing the work. A single total is precisely how a row cap
 * passed for a retention clock for as long as it did.
 */
export interface PruneReport {
  /** Oldest `received_day` retained by this prune. */
  cutoff_day: string;
  /** Newest arrival day still believed; anything above it was corrected to today. */
  clamp_day: string;
  /** Heartbeat rows whose impossible (future) arrival day was corrected to today. */
  clamped_heartbeats: number;
  /** `instances` rows whose impossible last-seen day was corrected to today. */
  clamped_instances: number;
  /** Heartbeat rows deleted because they aged out — THE retention control. */
  expired_heartbeats: number;
  /** Heartbeat rows deleted by the per-(instance, product) cap. Not retention. */
  capped_heartbeats: number;
  /** `instances` rows deleted because nothing of that identity is held any more. */
  expired_instances: number;
}

export interface InstanceRow {
  instance_id: string;
  product: string;
  first_seen_day: string;
  last_seen_day: string;
  /**
   * The `day` of this identity's FIRST heartbeat — the one day that is not a
   * one-day delta, because a counter with no prior snapshot emits its whole
   * lifetime value. NULL only for rows carried over from a database that
   * predates the column and whose heartbeats have all been pruned.
   *
   * IT IS LOST when the row expires (see `pruneRetention`), and that is the
   * accepted cost of not keeping a tombstone: retaining a stable id for years
   * after everything it described was deleted, purely to annotate rates, would
   * re-create the indefinite record this store now expires. The cost is small
   * and mostly cancels: an identity's row is only dropped once every heartbeat of
   * it has gone too, so no surviving row loses its annotation, and an install
   * that returns after that long has been diffing against its own stale snapshot
   * — for the products that normalise cumulative counters, its first day back
   * really is another whole-gap accumulation, so treating it as a fresh
   * first-report day is right rather than merely convenient. Where it is not
   * right (a product already emitting completed-day deltas), one representative
   * day is excluded from that installation's rates, and the read says so out loud
   * in `rates.excluded_day` rather than quietly.
   */
  first_report_day: string | null;
}

export interface HeartbeatRow {
  day: string;
  schema_version: number;
  payload: string;
  received_day: string;
}

export interface ProductAggregate {
  product: string;
  installs_seen: number;
  installs_active: number;
  days_reported: number;
}

export type Admission =
  | { ok: true; existing: boolean }
  | { ok: false; reason: 'instance_capacity' | 'daily_admission_budget' };

export class TelemetryDb {
  private readonly db: Database;
  readonly retentionDays: number;
  readonly maxRowsPerInstance: number;
  readonly maxInstances: number;
  readonly newInstancesPerDay: number;
  /** What the boot-time migration did. Surfaced on the operator metrics route. */
  readonly migration: MigrationReport;
  /**
   * What the last prune deleted, or null if none has run in this process.
   *
   * Surfaced on /metrics so the clock's operation is OBSERVABLE. A retention
   * promise whose enforcement leaves no trace is a promise nobody can check —
   * and the defect this replaced was invisible for exactly that reason.
   */
  lastPrune: PruneReport | null = null;

  private readonly stmtUpsertInstance: Statement;
  private readonly stmtUpsertHeartbeat: Statement;
  private readonly stmtGetInstance: Statement<InstanceRow, [string, string]>;
  private readonly stmtCountInstances: Statement<{ n: number }, []>;
  private readonly stmtAdmittedOnDay: Statement<{ admitted: number }, [string]>;
  private readonly stmtBumpAdmissions: Statement;
  private readonly stmtCountHeartbeats: Statement<{ n: number }, [string, string]>;
  private readonly stmtHeartbeatsAsc: Statement<HeartbeatRow, [string, string]>;
  private readonly stmtHeartbeatsRecent: Statement<HeartbeatRow, [string, string, number]>;
  private readonly stmtDeleteHeartbeats: Statement;
  private readonly stmtDeleteInstance: Statement;
  private readonly stmtClampHeartbeats: Statement;
  private readonly stmtExpireHeartbeats: Statement;
  private readonly stmtCapHeartbeats: Statement;
  private readonly stmtClampInstances: Statement;
  private readonly stmtExpireInstances: Statement;
  private readonly stmtAggregate: Statement<ProductAggregate, [string]>;

  constructor(config: TelemetryDbConfig) {
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    // A retention of zero is refused rather than honoured. `pruneRetention`
    // runs at boot and daily; at zero it would delete every heartbeat on the
    // next tick. "Store nothing" is not a supported configuration, and
    // silently doing it would be worse than saying so.
    if (!Number.isInteger(this.retentionDays) || this.retentionDays < 1) {
      throw new Error(`retentionDays must be an integer of at least 1, got: ${String(config.retentionDays)}`);
    }
    this.maxRowsPerInstance = config.maxRowsPerInstance ?? maxRowsFor(this.retentionDays);
    if (!Number.isInteger(this.maxRowsPerInstance) || this.maxRowsPerInstance < 1) {
      throw new Error(
        `maxRowsPerInstance must be an integer of at least 1, got: ${String(config.maxRowsPerInstance)}`,
      );
    }
    this.maxInstances = config.maxInstances ?? DEFAULT_MAX_INSTANCES;
    this.newInstancesPerDay = config.newInstancesPerDay ?? DEFAULT_NEW_INSTANCES_PER_DAY;
    this.db = new Database(config.path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    // Deleted content is OVERWRITTEN, not merely unlinked from the b-tree.
    // Without this, a pruned payload stays legible in a freed page until
    // something happens to reuse it — so a store that had "deleted" a year of
    // heartbeats could still hand them to anyone who read the file. It is not a
    // full answer (see the README: a backup taken before the prune is the
    // operator's problem, and so is the WAL until it checkpoints), but the live
    // volume is the part this process controls, and the cost on a store whose
    // write path is one row per installation per day is immaterial.
    this.db.exec('PRAGMA secure_delete = ON;');

    // Every statement below is prepared AFTER the migration, because the
    // migration drops and renames the tables they reference.
    this.migration = migrate(this.db);

    // `first_report_day` is written ONLY on insert. Filling it in later from
    // a subsequent heartbeat would stamp an ordinary day as the first-report
    // day and exclude it from every rate for the rest of that install's life.
    this.stmtUpsertInstance = this.db.query(`
      INSERT INTO instances (instance_id, product, first_seen_day, last_seen_day, first_report_day)
      VALUES (?1, ?2, ?3, ?3, ?4)
      ON CONFLICT(instance_id, product) DO UPDATE SET
        last_seen_day = MAX(instances.last_seen_day, excluded.last_seen_day)
    `);
    this.stmtUpsertHeartbeat = this.db.query(`
      INSERT INTO heartbeats (instance_id, product, day, schema_version, payload, received_day)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(instance_id, product, day) DO UPDATE SET
        schema_version = excluded.schema_version,
        payload = excluded.payload,
        received_day = excluded.received_day
    `);
    this.stmtGetInstance = this.db.query(
      'SELECT instance_id, product, first_seen_day, last_seen_day, first_report_day FROM instances WHERE instance_id = ?1 AND product = ?2',
    );
    this.stmtCountInstances = this.db.query('SELECT COUNT(*) AS n FROM instances');
    this.stmtAdmittedOnDay = this.db.query('SELECT admitted FROM admissions WHERE day = ?1');
    this.stmtBumpAdmissions = this.db.query(`
      INSERT INTO admissions (day, admitted) VALUES (?1, 1)
      ON CONFLICT(day) DO UPDATE SET admitted = admissions.admitted + 1
    `);
    this.stmtCountHeartbeats = this.db.query(
      'SELECT COUNT(*) AS n FROM heartbeats WHERE instance_id = ?1 AND product = ?2',
    );
    this.stmtHeartbeatsAsc = this.db.query(
      'SELECT day, schema_version, payload, received_day FROM heartbeats WHERE instance_id = ?1 AND product = ?2 ORDER BY day ASC',
    );
    this.stmtHeartbeatsRecent = this.db.query(`
      SELECT day, schema_version, payload, received_day FROM (
        SELECT day, schema_version, payload, received_day
        FROM heartbeats WHERE instance_id = ?1 AND product = ?2 ORDER BY day DESC LIMIT ?3
      ) ORDER BY day ASC
    `);
    // Deletion is per IDENTITY, across every product. The secret proves
    // ownership of the id itself, and erasure that left rows behind under some
    // other product would be erasure in name only.
    this.stmtDeleteHeartbeats = this.db.query('DELETE FROM heartbeats WHERE instance_id = ?1');
    this.stmtDeleteInstance = this.db.query('DELETE FROM instances WHERE instance_id = ?1');

    // ── THE RETENTION CLOCK ────────────────────────────────────────────────
    // Two statements, in this order, and the order is the guarantee:
    //
    //   1. CLAMP an unbelievable arrival day back to today. A row cannot have
    //      arrived after today, and believing that it did is how a record
    //      outlives its window — the cutoff would have to climb past the stamp
    //      before it even started counting. Deleting such a row instead would
    //      make one day of skew between two replicas destroy a heartbeat that
    //      did nothing wrong, so it is corrected rather than punished. Anything
    //      that is not a date at all ('not-a-day', 'zzz') sorts above every real
    //      day and is caught by the very same comparison, which is what makes
    //      the rule TOTAL: after this statement every stored arrival day is one
    //      the cutoff will reach.
    //   2. EXPIRE anything that arrived before the cutoff. One indexed range —
    //      see idx_heartbeats_received_day.
    //
    // A malformed value that happens to sort INSIDE the window ('2026-07-2X')
    // is left for the cutoff, which passes it within a day or two of when a
    // well-formed neighbour would have gone. Catching it sooner would need a
    // shape test (`GLOB '[0-9][0-9][0-9][0-9]-...'`), and that costs a FULL
    // TABLE SCAN on every prune for ever because it defeats the index — measured
    // with EXPLAIN QUERY PLAN. Nothing in this service can write such a value
    // (`received_day` is always the server's own UTC day), so the scan would buy
    // two days on a row that cannot exist.
    //
    // WHY `received_day` AND NOT `day`. The promise is about how long WE hold a
    // record, so its clock has to start when the record reaches us. Keying on
    // `day` — the day the data describes — breaks that in both directions: a
    // heartbeat backfilled for an older day (ingest accepts up to
    // INGEST_DAY_WINDOW_DAYS back) would arrive with part of its window already
    // spent, or none of it left, so two installations reporting identically
    // would get different retention purely from delivery latency. `day` is not
    // ignored: because ingest bounds it to `today − INGEST_DAY_WINDOW_DAYS …
    // today`, keying on arrival still bounds the AGE OF THE DATA at
    // retentionDays + INGEST_DAY_WINDOW_DAYS, and ingest already refuses a
    // future `day` outright — so a clock-skewed client cannot park a row beyond
    // the window under either basis. Arrival is the honest basis; `day` would
    // be the flattering one.
    this.stmtClampHeartbeats = this.db.query(
      'UPDATE heartbeats SET received_day = ?1 WHERE received_day > ?2',
    );
    this.stmtExpireHeartbeats = this.db.query('DELETE FROM heartbeats WHERE received_day < ?1');
    // The pathology cap, and NOT the retention control — see `maxRowsFor`. It
    // bounds what one (instance, product) can hold irrespective of dates, which
    // matters for rows the clock cannot reason about: an operator's bulk import,
    // a hand-edited volume, or a future widening of the ingest window that
    // forgets this cap exists. Ordered by `day` so the most recent data is what
    // survives.
    this.stmtCapHeartbeats = this.db.query(`
      DELETE FROM heartbeats WHERE (instance_id, product, day) IN (
        SELECT instance_id, product, day FROM (
          SELECT instance_id, product, day,
                 ROW_NUMBER() OVER (PARTITION BY instance_id, product ORDER BY day DESC) AS rn
          FROM heartbeats
        ) WHERE rn > ?1
      )
    `);
    // An `instances` row is itself pseudonymous personal data — a stable id with
    // the days it was active — so it expires too, on the same arrival clock, once
    // NOTHING of that identity is held any more. The NOT EXISTS guard is what
    // makes that safe: the row is the only way to read the heartbeats keyed to
    // it, so it must outlive every one of them. `last_seen_day` is itself a
    // received day (see `recordHeartbeat`), hence MAX over the rows' own
    // `received_day`, so the guard is belt to the clock's braces rather than a
    // second, disagreeing rule. It is clamped on the same terms, for the same
    // reason: an identity stamped in the future would otherwise look active for
    // ever, both to retention and to the aggregate's active window.
    this.stmtClampInstances = this.db.query(
      'UPDATE instances SET last_seen_day = ?1 WHERE last_seen_day > ?2',
    );
    this.stmtExpireInstances = this.db.query(`
      DELETE FROM instances
       WHERE last_seen_day < ?1
         AND NOT EXISTS (
               SELECT 1 FROM heartbeats h
                WHERE h.instance_id = instances.instance_id
                  AND h.product = instances.product
             )
    `);
    this.stmtAggregate = this.db.query(`
      SELECT i.product                                                AS product,
             COUNT(*)                                                 AS installs_seen,
             SUM(CASE WHEN i.last_seen_day >= ?1 THEN 1 ELSE 0 END)   AS installs_active,
             COALESCE((SELECT COUNT(*) FROM heartbeats h WHERE h.product = i.product), 0) AS days_reported
      FROM instances i
      GROUP BY i.product
      ORDER BY i.product ASC
    `);
  }

  /** Current journal mode (test hook: file-backed databases must report 'wal'). */
  journalMode(): string {
    const row = this.db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    return row?.journal_mode ?? '';
  }

  /**
   * Admit and store one heartbeat, ATOMICALLY.
   *
   * The check and the write are one `IMMEDIATE` transaction on purpose. Split
   * apart, two processes sharing this database could each observe capacity
   * available and each insert, walking straight past both budgets — and the
   * whole point of deriving them from the database rather than from memory is
   * that they hold across replicas. IMMEDIATE takes the write lock before the
   * first read, so the second process blocks (busy_timeout) and then re-reads
   * the winner's state.
   *
   * An identity that already exists is always admitted — established installs
   * must never be throttled by a flood of fresh ones. A never-seen identity is
   * admitted only while BOTH budgets hold:
   *
   *   • the absolute ceiling (`maxInstances`) — total storage bound;
   *   • the daily budget (`newInstancesPerDay`) — how fast the ceiling may be
   *     approached.
   *
   * The daily budget reads the append-only `admissions` ledger, NOT a count of
   * `instances.first_seen_day`: that count falls again when an installation
   * exercises its right to delete, so mint-delete-repeat would have bought
   * unlimited admissions. The ledger is only ever incremented.
   *
   * Its honest limit is stated in the README: it converts "one flood
   * permanently exhausts the ceiling" into "one flood exhausts one day's
   * budget". It does not remove the lever.
   */
  recordHeartbeat(
    instanceId: string,
    product: string,
    day: string,
    wireVersion: number,
    payloadJson: string,
    receivedDay: string,
  ): Admission {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.stmtGetInstance.get(instanceId, product) !== null;
      if (!existing) {
        if ((this.stmtCountInstances.get()?.n ?? 0) >= this.maxInstances) {
          this.db.exec('ROLLBACK');
          return { ok: false, reason: 'instance_capacity' };
        }
        if (this.newInstancesPerDay > 0 && this.admittedOnDay(receivedDay) >= this.newInstancesPerDay) {
          this.db.exec('ROLLBACK');
          return { ok: false, reason: 'daily_admission_budget' };
        }
        this.stmtBumpAdmissions.run(receivedDay);
      }
      this.stmtUpsertInstance.run(instanceId, product, receivedDay, day);
      this.stmtUpsertHeartbeat.run(instanceId, product, day, wireVersion, payloadJson, receivedDay);
      this.db.exec('COMMIT');
      return { ok: true, existing };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already resolved; the original error is what matters.
      }
      throw err;
    }
  }

  /**
   * True when this identity already has an instances row for that product.
   *
   * ADVISORY ONLY — used to decide whether a request should spend a
   * per-source mint token. It is not an authorization or admission decision,
   * and a race here costs at most one token in either direction. The
   * authoritative check lives inside `recordHeartbeat`'s transaction.
   */
  isKnownInstance(instanceId: string, product: string): boolean {
    return this.stmtGetInstance.get(instanceId, product) !== null;
  }

  getInstance(instanceId: string, product: string): InstanceRow | null {
    return this.stmtGetInstance.get(instanceId, product) ?? null;
  }

  countHeartbeats(instanceId: string, product: string): number {
    return this.stmtCountHeartbeats.get(instanceId, product)?.n ?? 0;
  }

  countInstances(): number {
    return this.stmtCountInstances.get()?.n ?? 0;
  }

  /** Identities admitted for the first time on `day`, from the append-only ledger. */
  admittedOnDay(day: string): number {
    return this.stmtAdmittedOnDay.get(day)?.admitted ?? 0;
  }

  /** Day-ascending heartbeat rows; `recentDays` trims to the most recent N (still ascending). */
  getHeartbeats(instanceId: string, product: string, recentDays?: number): HeartbeatRow[] {
    if (recentDays !== undefined) return this.stmtHeartbeatsRecent.all(instanceId, product, recentDays);
    return this.stmtHeartbeatsAsc.all(instanceId, product);
  }

  /** Idempotent purge of one identity across EVERY product. */
  deleteInstance(instanceId: string): void {
    const tx = this.db.transaction(() => {
      this.stmtDeleteHeartbeats.run(instanceId);
      this.stmtDeleteInstance.run(instanceId);
    });
    tx();
  }

  /**
   * Enforce retention as of `today` (UTC, YYYY-MM-DD): expire everything that
   * has aged out, then apply the pathology cap, then drop the `instances` rows
   * nothing is left of. One transaction, so no reader ever sees a heartbeat
   * whose identity row has already gone.
   *
   * `today` is a PARAMETER, not a call to the clock. Every date this store
   * handles arrives from its caller (see `recordHeartbeat`'s `receivedDay`), a
   * hidden clock cannot be tested, and the caller is the one place that knows
   * whether it is serving requests or replaying a fixture.
   *
   * THE WINDOW. `cutoff` is `today − (retentionDays − 1)`, so retentionDays
   * counts the arrival day itself: at 90, a row that arrived today is held
   * through the 89 following days and deleted by the first prune of the 90th.
   * Same convention as the aggregate's active window, deliberately — the
   * tighter reading of "90 days" is the one a privacy notice can defend.
   *
   * A FUTURE ARRIVAL DAY IS CORRECTED, NOT DELETED AND NOT BELIEVED. A stamp
   * ahead of `today` cannot be true, and believing one is how a record outlives
   * its window: the cutoff would have to climb past the stamp before the clock
   * even reached it, so a row stamped a year out would be held for a year plus
   * the window. Deleting such a row instead is the other error — one day of
   * clock skew between two replicas would destroy a heartbeat that had done
   * nothing wrong. So the prune CLAMPS: anything stamped beyond tomorrow is
   * rewritten to `today`, which is the earliest arrival the store can still
   * defend, and it then expires one ordinary window later. Tomorrow itself is
   * left alone — that is a replica a few minutes fast, it costs at most a day,
   * and rewriting it would be pedantry with a write cost.
   *
   * Only `received_day` and `last_seen_day` are ever rewritten. NO STORED
   * PAYLOAD IS TOUCHED, here or anywhere else in this service.
   *
   * ON BEING CLOCK-DRIVEN AT ALL. A time-based promise cannot be kept without a
   * clock, so the failure modes are worth naming: a clock jumped FORWARD deletes
   * early (loss for us, never a privacy failure), and a clock moved BACK deletes
   * late — which is no worse than the unconditional behaviour this replaced.
   * Neither hands anything back to an attacker, which is exactly why the
   * ADMISSION LEDGER IS STILL DELIBERATELY NOT PRUNED: it holds one small row
   * per UTC day the service has ever seen — a few tens of kilobytes per decade,
   * nothing beside the heartbeat rows — and deleting from it is the only
   * operation that can REFUND a spent budget. Jump the clock past the horizon,
   * let a prune drop a day, move it back, and that day's admissions are free
   * again. Expiring identity rows cannot be abused that way: the ledger counts
   * admissions and never falls, so a pruned identity has still spent its day's
   * budget for ever. It does return capacity against `maxInstances` — correctly,
   * because that ceiling bounds what is STORED and the storage really is gone.
   */
  pruneRetention(today: string): PruneReport {
    // An unparseable day would flow into `shiftDay` (which returns its input
    // unchanged) and then into a text comparison, quietly deleting everything or
    // nothing. Refuse it instead of guessing.
    if (dayToEpochUtc(today) === null) {
      throw new Error(`pruneRetention needs a real UTC calendar day as YYYY-MM-DD, got: ${String(today)}`);
    }
    const cutoff = shiftDay(today, -(this.retentionDays - 1));
    // Beyond tomorrow is not a clock difference, it is a wrong clock.
    const believable = shiftDay(today, 1);
    const report: PruneReport = {
      cutoff_day: cutoff,
      clamp_day: believable,
      clamped_heartbeats: 0,
      clamped_instances: 0,
      expired_heartbeats: 0,
      capped_heartbeats: 0,
      expired_instances: 0,
    };
    const tx = this.db.transaction(() => {
      // Correct first, expire second — a row clamped to `today` in this same
      // transaction must be judged on the corrected value, and a value the store
      // cannot place on the calendar at all ('not-a-day') sorts above every real
      // date, so it is caught here and given a real clock rather than living for
      // ever.
      report.clamped_heartbeats = this.stmtClampHeartbeats.run(today, believable).changes;
      report.clamped_instances = this.stmtClampInstances.run(today, believable).changes;
      report.expired_heartbeats = this.stmtExpireHeartbeats.run(cutoff).changes;
      report.capped_heartbeats = this.stmtCapHeartbeats.run(this.maxRowsPerInstance).changes;
      // Last, and inside the same transaction, so NOT EXISTS sees the store as
      // the deletes above left it.
      report.expired_instances = this.stmtExpireInstances.run(cutoff).changes;
    });
    tx();
    // Checkpoint after a prune that actually deleted something. The delete lands
    // in the WAL, and until the WAL is folded back into the database the removed
    // rows are still sitting in it — `secure_delete` overwrites pages in the main
    // file, not history in the log. PASSIVE, so a busy reader is never blocked
    // and a failure to checkpoint is not a failure to delete; the next one
    // catches up.
    if (report.expired_heartbeats + report.capped_heartbeats + report.expired_instances > 0) {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    }
    this.lastPrune = report;
    return report;
  }

  /**
   * Per-product aggregate counts for the public give-back page.
   *
   * Per product ONLY. There is no identifier joining an installation across
   * products — each derives its own — so a family-wide figure cannot be
   * computed without double-counting anyone running two products. This method
   * deliberately offers no total; see `page.ts` and the README.
   */
  aggregates(activeSinceDay: string): ProductAggregate[] {
    return this.stmtAggregate.all(activeSinceDay);
  }

  close(): void {
    this.db.close();
  }
}
