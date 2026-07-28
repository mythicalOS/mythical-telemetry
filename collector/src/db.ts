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
//
// Bounded growth: per-instance row cap via retention prune, plus admission
// control on never-seen identities (see `admit`).

import { Database, type Statement } from 'bun:sqlite';
import { migrate, type MigrationReport } from './migrate';

/**
 * How many daily rows are kept per (instance, product) before the oldest are
 * pruned. 90 days is a DECLARED privacy commitment, not a capacity tuning knob
 * — the published notice states this number, so lengthening it silently would
 * make that notice false. Change it only alongside the notice.
 *
 * The trade was made deliberately: 400 days would allow year-on-year comparison,
 * 90 does not. The shorter window was chosen because it also makes the opt-out
 * honest — telemetry off stops collection and everything already held expires
 * within a quarter, which is a sentence worth being able to write.
 */
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_MAX_INSTANCES = 100_000;
export const DEFAULT_NEW_INSTANCES_PER_DAY = 5_000;

export interface TelemetryDbConfig {
  /** SQLite file path, or ':memory:' for tests. */
  path: string;
  /** Per-(instance, product) row cap. Must be at least 1 — see the constructor. */
  retentionDays?: number;
  /** Absolute ceiling on distinct (instance_id, product) identities. */
  maxInstances?: number;
  /** Global budget on identities admitted for the FIRST time on one UTC day. */
  newInstancesPerDay?: number;
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
  readonly maxInstances: number;
  readonly newInstancesPerDay: number;
  /** What the boot-time migration did. Surfaced on the operator metrics route. */
  readonly migration: MigrationReport;

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
  private readonly stmtPrune: Statement;
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
    this.maxInstances = config.maxInstances ?? DEFAULT_MAX_INSTANCES;
    this.newInstancesPerDay = config.newInstancesPerDay ?? DEFAULT_NEW_INSTANCES_PER_DAY;
    this.db = new Database(config.path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');

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
    this.stmtPrune = this.db.query(`
      DELETE FROM heartbeats WHERE (instance_id, product, day) IN (
        SELECT instance_id, product, day FROM (
          SELECT instance_id, product, day,
                 ROW_NUMBER() OVER (PARTITION BY instance_id, product ORDER BY day DESC) AS rn
          FROM heartbeats
        ) WHERE rn > ?1
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
   * Per-(instance, product) row cap: drop everything older than the newest
   * retentionDays rows.
   *
   * THE ADMISSION LEDGER IS DELIBERATELY NOT PRUNED. It holds one small row per
   * UTC day the service has ever seen — a few tens of kilobytes per decade,
   * next to nothing beside the heartbeat rows — and deleting from it is the
   * only operation that can hand back a spent budget. A prune driven by the
   * system clock reintroduces exactly that: jump the clock forward past the
   * horizon, let the prune drop a day, then move it back, and that day's budget
   * is fresh again. Not pruning removes the whole class for a cost that does
   * not matter.
   */
  pruneRetention(): number {
    return this.stmtPrune.run(this.retentionDays).changes;
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
