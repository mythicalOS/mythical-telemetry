// SPIKE — the D1 port of `collector/src/db.ts`.
//
// The SQL is, statement for statement, the SQL of the original: every query
// shape was probed against local D1 (`wrangler d1 execute --local`) and every
// one parsed and ran unchanged, including the `ROW_NUMBER() OVER (PARTITION
// BY …)` row cap and the row-value `WHERE (a,b,c) IN (…)` it sits in. What
// changed is not the SQL. It is these three things:
//
//   1. EVERY METHOD IS ASYNC. D1 has no synchronous read, so the colour change
//      starts here and propagates all the way to the route handlers — see
//      `server-d1.ts`.
//
//   2. THERE IS NO INTERACTIVE TRANSACTION. `BEGIN IMMEDIATE` is refused
//      outright by D1 (measured: "To execute a transaction, please use the
//      state.storage.transaction() … APIs instead of the SQL BEGIN
//      TRANSACTION"). `db.batch()` is atomic, but it is a FIXED list submitted
//      in one go — you cannot read, decide in JavaScript, and then write within
//      the same atomic unit. The original's two read-decide-write transactions
//      (`recordHeartbeat`, `pruneRetention`) therefore had to be re-expressed
//      with the DECISION PUSHED INTO THE SQL, so the guard is evaluated inside
//      the same atomic unit as the write. Where that could not be done exactly,
//      the residual is named at the call site rather than papered over.
//
//   3. NO PRAGMA IS AVAILABLE. Measured against local D1, every one of
//      `journal_mode`, `secure_delete`, `wal_checkpoint`, `busy_timeout` and
//      `user_version` returns `not authorized: SQLITE_AUTH`. Two of those were
//      load-bearing and are addressed where they used to be set.
//      (`PRAGMA table_info` is the one exception — it IS permitted.)

import { dayToEpochUtc, INGEST_DAY_WINDOW_DAYS, shiftDay } from '../../../collector/src/day';

// ── Minimal structural D1 types ────────────────────────────────────────────
// Declared here rather than pulled from `@cloudflare/workers-types` so the
// spike adds no dependency. Only the surface actually used is described.

export interface D1Meta {
  changes?: number;
}
export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  meta?: D1Meta;
  success?: boolean;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

// ── Constants, carried over verbatim ───────────────────────────────────────

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_MAX_INSTANCES = 100_000;
export const DEFAULT_NEW_INSTANCES_PER_DAY = 5_000;

export function maxRowsFor(retentionDays: number): number {
  return retentionDays + INGEST_DAY_WINDOW_DAYS + 1;
}

const WATERMARK_KEY = 'retention_watermark_day';

export interface TelemetryD1Config {
  db: D1Database;
  retentionDays?: number;
  maxRowsPerInstance?: number;
  maxInstances?: number;
  newInstancesPerDay?: number;
}

/**
 * As the original, MINUS `wal_truncated`.
 *
 * That field is not merely unset here, it is meaningless: D1 exposes no write-
 * ahead log and refuses `PRAGMA wal_checkpoint`. Leaving the key present and
 * permanently `false` would put a standing false negative on the operator
 * metrics route — an operator watching it would read "the log was never folded
 * back" for ever. Removing it says the honest thing, which is that this storage
 * hygiene step has no D1 equivalent AT ALL.
 */
export interface PruneReportD1 {
  effective_day: string;
  cutoff_day: string;
  clamp_day: string;
  clamped_heartbeats: number;
  clamped_instances: number;
  expired_heartbeats: number;
  capped_heartbeats: number;
  expired_instances: number;
}

export interface InstanceRow {
  instance_id: string;
  product: string;
  first_seen_day: string;
  last_seen_day: string;
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

/** `meta.changes` for a batch member, defensively — D1 may omit it. */
function changesOf(result: D1Result | undefined): number {
  return result?.meta?.changes ?? 0;
}

export class TelemetryD1 {
  private readonly db: D1Database;
  readonly retentionDays: number;
  readonly maxRowsPerInstance: number;
  readonly maxInstances: number;
  readonly newInstancesPerDay: number;
  lastPrune: PruneReportD1 | null = null;

  constructor(config: TelemetryD1Config) {
    this.db = config.db;
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
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
    // NOTE what is NOT here: `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout`
    // and `PRAGMA secure_delete = ON`. All three are refused by D1
    // (SQLITE_AUTH). The first two are D1's own concern and losing them costs
    // nothing. The THIRD IS A PRIVACY CONTROL the original sets deliberately so
    // that a pruned payload is overwritten rather than left legible in a freed
    // page — see the comment it carries in `db.ts`. On D1 that guarantee simply
    // cannot be asserted from here; it becomes a property of Cloudflare's
    // storage that this service can neither set nor verify. Recorded, not
    // solved.
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async getInstance(instanceId: string, product: string): Promise<InstanceRow | null> {
    return await this.db
      .prepare(
        'SELECT instance_id, product, first_seen_day, last_seen_day, first_report_day FROM instances WHERE instance_id = ?1 AND product = ?2',
      )
      .bind(instanceId, product)
      .first<InstanceRow>();
  }

  async isKnownInstance(instanceId: string, product: string): Promise<boolean> {
    return (await this.getInstance(instanceId, product)) !== null;
  }

  async countInstances(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM instances').first<{ n: number }>();
    return row?.n ?? 0;
  }

  async countHeartbeats(instanceId: string, product: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM heartbeats WHERE instance_id = ?1 AND product = ?2')
      .bind(instanceId, product)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async admittedOnDay(day: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT admitted FROM admissions WHERE day = ?1')
      .bind(day)
      .first<{ admitted: number }>();
    return row?.admitted ?? 0;
  }

  async getHeartbeats(instanceId: string, product: string, recentDays?: number): Promise<HeartbeatRow[]> {
    const stmt =
      recentDays === undefined
        ? this.db
            .prepare(
              'SELECT day, schema_version, payload, received_day FROM heartbeats WHERE instance_id = ?1 AND product = ?2 ORDER BY day ASC',
            )
            .bind(instanceId, product)
        : this.db
            .prepare(
              `SELECT day, schema_version, payload, received_day FROM (
                 SELECT day, schema_version, payload, received_day
                 FROM heartbeats WHERE instance_id = ?1 AND product = ?2 ORDER BY day DESC LIMIT ?3
               ) ORDER BY day ASC`,
            )
            .bind(instanceId, product, recentDays);
    const res = await stmt.all<HeartbeatRow>();
    return res.results ?? [];
  }

  async aggregates(activeSinceDay: string): Promise<ProductAggregate[]> {
    const res = await this.db
      .prepare(`
        SELECT i.product                                                AS product,
               COUNT(*)                                                 AS installs_seen,
               SUM(CASE WHEN i.last_seen_day >= ?1 THEN 1 ELSE 0 END)   AS installs_active,
               COALESCE((SELECT COUNT(*) FROM heartbeats h WHERE h.product = i.product), 0) AS days_reported
        FROM instances i
        GROUP BY i.product
        ORDER BY i.product ASC
      `)
      .bind(activeSinceDay)
      .all<ProductAggregate>();
    return res.results ?? [];
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Admit and store one heartbeat.
   *
   * THE ORIGINAL'S GUARANTEE, AND WHAT SURVIVES IT. `db.ts` wraps the check and
   * the write in one `BEGIN IMMEDIATE` transaction precisely so two processes
   * cannot each observe capacity and each insert. D1 refuses `BEGIN IMMEDIATE`,
   * so that construction is not available. What replaces it is a `batch()` —
   * which IS atomic — in which the budget test is a `WHERE` clause on the
   * insert itself. The guard is therefore evaluated inside the same atomic unit
   * as the write it guards, and a racing request that commits first is visible
   * to the loser's guard. The capacity ceiling and the daily budget are exact.
   *
   * WHERE IT IS NOT EXACT, stated rather than buried. The `existing` flag is
   * read BEFORE the batch, because the caller needs it (it decides whether the
   * request spends a per-source mint token) and a batch cannot branch. If a
   * concurrent request creates the same identity in that gap, the admissions
   * ledger is bumped twice for one identity. That over-counts a monotonic
   * counter, which SPENDS budget rather than refunding it — the conservative
   * direction, and the direction the original's own comment says matters ("the
   * ledger is only ever incremented"). It cannot be used to gain admissions.
   *
   * The heartbeat insert is guarded on the identity row EXISTING, so it lands
   * if and only if the identity was admitted — by this batch or earlier. That
   * is what keeps a rejected admission from storing a row anyway.
   */
  async recordHeartbeat(
    instanceId: string,
    product: string,
    day: string,
    wireVersion: number,
    payloadJson: string,
    receivedDay: string,
  ): Promise<Admission> {
    const existing = (await this.getInstance(instanceId, product)) !== null;

    if (existing) {
      // No budget applies to an established install — as the original: they must
      // never be throttled by a flood of fresh ones. Two statements, atomic.
      const results = await this.db.batch([
        this.db
          .prepare(`
            INSERT INTO instances (instance_id, product, first_seen_day, last_seen_day, first_report_day)
            VALUES (?1, ?2, ?3, ?3, ?4)
            ON CONFLICT(instance_id, product) DO UPDATE SET
              last_seen_day = MAX(instances.last_seen_day, excluded.last_seen_day)
          `)
          .bind(instanceId, product, receivedDay, day),
        this.db
          .prepare(`
            INSERT INTO heartbeats (instance_id, product, day, schema_version, payload, received_day)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(instance_id, product, day) DO UPDATE SET
              schema_version = excluded.schema_version,
              payload = excluded.payload,
              received_day = excluded.received_day
          `)
          .bind(instanceId, product, day, wireVersion, payloadJson, receivedDay),
      ]);
      if (changesOf(results[1]) === 0) {
        // The heartbeat did not land, and there is no budget in this branch that
        // could legitimately have refused it. Never swallow that.
        throw new Error(
          `heartbeat upsert affected no row for an established identity (product=${product}, day=${day})`,
        );
      }
      return { ok: true, existing: true };
    }

    // A never-seen identity. Read the two budget inputs up front so a rejection
    // can be attributed to the right counter; the AUTHORITATIVE test is the
    // WHERE clause inside the batch, not these numbers.
    const [instanceCount, admittedToday] = await Promise.all([
      this.countInstances(),
      this.admittedOnDay(receivedDay),
    ]);

    const results = await this.db.batch([
      // (1) Insert the identity only while BOTH budgets hold. `INSERT … SELECT
      //     … WHERE … ON CONFLICT` parses on D1 (probed).
      this.db
        .prepare(`
          INSERT INTO instances (instance_id, product, first_seen_day, last_seen_day, first_report_day)
          SELECT ?1, ?2, ?3, ?3, ?4
           WHERE (SELECT COUNT(*) FROM instances) < ?5
             -- A budget of 0 DISABLES the daily check, exactly as the
             -- original's "newInstancesPerDay > 0 &&" guard does. Expressed in
             -- SQL rather than in JavaScript because the whole point of this
             -- rewrite is that the test travels with the write; a zero handled
             -- on the JS side would be a second place the rule lives. Written
             -- as a plain disjunction so a budget of 0 short-circuits before
             -- the subquery runs.
             AND (?6 = 0 OR COALESCE((SELECT admitted FROM admissions WHERE day = ?3), 0) < ?6)
          ON CONFLICT(instance_id, product) DO UPDATE SET
            last_seen_day = MAX(instances.last_seen_day, excluded.last_seen_day)
        `)
        .bind(instanceId, product, receivedDay, day, this.maxInstances, this.newInstancesPerDay),
      // (2) Spend a day's budget iff the identity now exists. Ordered AFTER (1)
      //     so "now exists" means "(1) admitted it" — see the over-count
      //     residual in the doc comment.
      this.db
        .prepare(`
          INSERT INTO admissions (day, admitted)
          SELECT ?1, 1
           WHERE EXISTS (SELECT 1 FROM instances WHERE instance_id = ?2 AND product = ?3)
          ON CONFLICT(day) DO UPDATE SET admitted = admissions.admitted + 1
        `)
        .bind(receivedDay, instanceId, product),
      // (3) Store the heartbeat iff the identity was admitted.
      this.db
        .prepare(`
          INSERT INTO heartbeats (instance_id, product, day, schema_version, payload, received_day)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE EXISTS (SELECT 1 FROM instances WHERE instance_id = ?1 AND product = ?2)
          ON CONFLICT(instance_id, product, day) DO UPDATE SET
            schema_version = excluded.schema_version,
            payload = excluded.payload,
            received_day = excluded.received_day
        `)
        .bind(instanceId, product, day, wireVersion, payloadJson, receivedDay),
    ]);

    if (changesOf(results[0]) === 0) {
      // Refused. Which budget bit is reported from the pre-read — advisory, and
      // used only to pick a counter name, exactly as the original does.
      return {
        ok: false,
        reason: instanceCount >= this.maxInstances ? 'instance_capacity' : 'daily_admission_budget',
      };
    }
    if (changesOf(results[2]) === 0) {
      throw new Error(
        `identity was admitted but its heartbeat stored no row (product=${product}, day=${day})`,
      );
    }
    void admittedToday; // read for symmetry with the original's reporting; the guard is authoritative
    return { ok: true, existing: false };
  }

  /** Idempotent purge of one identity across EVERY product. Two writes, no read — batch is an exact fit. */
  async deleteInstance(instanceId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM heartbeats WHERE instance_id = ?1').bind(instanceId),
      this.db.prepare('DELETE FROM instances WHERE instance_id = ?1').bind(instanceId),
    ]);
  }

  /**
   * Enforce retention as of `today`. Same clamp → expire → cap → drop-orphans
   * ordering as the original, and the ordering is still the guarantee.
   *
   * THE WATERMARK READ IS OUTSIDE THE ATOMIC UNIT. The original reads
   * `meta.retention_watermark_day`, computes the cutoff in JavaScript, and
   * writes back — all inside one `IMMEDIATE` transaction, so two replicas
   * pruning one file cannot both read the old value. On D1 the cutoff
   * arithmetic has to happen between the read and the batch, so that window
   * exists. It is acceptable HERE and only here because the prune is driven by
   * a Cron Trigger rather than by every boot: concurrent prunes are not the
   * normal shape any more. It is still a real weakening of a documented
   * one-way property and is reported as such.
   *
   * `wal_truncated` is gone entirely — see `PruneReportD1`.
   */
  async pruneRetention(today: string): Promise<PruneReportD1> {
    if (dayToEpochUtc(today) === null) {
      throw new Error(`pruneRetention needs a real UTC calendar day as YYYY-MM-DD, got: ${String(today)}`);
    }
    const stored =
      (await this.db.prepare('SELECT value FROM meta WHERE key = ?1').bind(WATERMARK_KEY).first<{ value: string }>())
        ?.value ?? null;
    const watermark = stored !== null && dayToEpochUtc(stored) !== null ? stored : null;
    const effective = watermark !== null && watermark > today ? watermark : today;
    const cutoff = shiftDay(effective, -(this.retentionDays - 1));
    const believable = shiftDay(effective, 1);

    const results = await this.db.batch([
      this.db
        .prepare('UPDATE heartbeats SET received_day = ?1 WHERE received_day > ?2')
        .bind(effective, believable),
      this.db
        .prepare('UPDATE instances SET last_seen_day = ?1 WHERE last_seen_day > ?2')
        .bind(effective, believable),
      this.db.prepare('DELETE FROM heartbeats WHERE received_day < ?1').bind(cutoff),
      this.db
        .prepare(`
          DELETE FROM heartbeats WHERE (instance_id, product, day) IN (
            SELECT instance_id, product, day FROM (
              SELECT instance_id, product, day,
                     ROW_NUMBER() OVER (PARTITION BY instance_id, product ORDER BY day DESC) AS rn
              FROM heartbeats
            ) WHERE rn > ?1
          )
        `)
        .bind(this.maxRowsPerInstance),
      this.db.prepare(`
        DELETE FROM instances
         WHERE NOT EXISTS (
                 SELECT 1 FROM heartbeats h
                  WHERE h.instance_id = instances.instance_id
                    AND h.product = instances.product
               )
      `),
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(WATERMARK_KEY, effective),
    ]);

    const report: PruneReportD1 = {
      effective_day: effective,
      cutoff_day: cutoff,
      clamp_day: believable,
      clamped_heartbeats: changesOf(results[0]),
      clamped_instances: changesOf(results[1]),
      expired_heartbeats: changesOf(results[2]),
      capped_heartbeats: changesOf(results[3]),
      expired_instances: changesOf(results[4]),
    };
    this.lastPrune = report;
    return report;
  }
}
