// The ROUTE-test harness — the counterpart of `collector/tests/helpers.ts`.
//
// ─────────────────────────────────────────────────────────────────────────
//  WHAT A GREEN RUN IN THIS DIRECTORY DOES AND DOES NOT PROVE
//
//  Every route suite that uses this harness drives the Worker's real
//  `src/server.ts` over `D1OverSqlite` — SQLite pretending to be D1. Read
//  `d1-over-sqlite.ts` for the full account; the short version is that the
//  shim is STRONGER than the thing it stands in for:
//
//    • it will not refuse a PRAGMA the way D1 does (SQLITE_AUTH);
//    • its `batch()` is a real SQLite transaction, which is stronger than
//      what D1 documents, so nothing here exercises D1's atomicity under
//      contention;
//    • it has no row limits, no response-size limits, no per-query limits;
//    • it has no network in it at all, so no latency, no retry, no partial
//      failure.
//
//  So: a route test passing here means the ROUTING, the CHECK ORDER, the
//  AUTHENTICATION and the HARDENING are right. It does not mean D1 behaves.
//  The end-to-end proof that the deployment works on real (local) D1 stays
//  the `wrangler dev --local` verification recorded in ../README.md.
//
//  Two further things this harness deliberately does not model, both of them
//  properties of the Worker RUNTIME rather than of the route layer:
//
//    • ONE PROCESS. `buildFetchHandler` closes over three token buckets, a
//      counter set and the aggregate cache. Here they are process-lifetime,
//      as the original assumes. In production they are per-ISOLATE, so every
//      throttle bound and every counter total asserted below is a bound and a
//      total for one isolate only. See `src/worker.ts` → `getHandler`.
//    • INJECTED CLOCKS. `nowUtcDay` and `nowMs` are injected here, exactly as
//      in the original harness, so the day window and the token buckets are
//      deterministic.
// ─────────────────────────────────────────────────────────────────────────
//
// The request builders are IMPORTED from `collector/tests/helpers.ts` and
// re-exported rather than copied. They are pure `new Request(...)` shaping —
// no runtime in them — and they encode the header names and the query grammar
// the two collectors must agree on. Copying them would put the canonical
// secret header in a second place, which is the exact drift
// `../../docs/TWO-COLLECTORS.md` is about. `makeHarness` is the only thing
// that genuinely differs, and it is the only thing defined here.

import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { Counters } from '../../collector/src/counters';
import type { ServerLike } from '../../collector/src/throttle';
import type { HeartbeatValidator } from '../../collector/src/validator';
import { StubValidator } from '../../collector/tests/fixtures';
import { TelemetryD1 } from '../src/db';
import { buildFetchHandler, type FetchHandler } from '../src/server';
import { D1OverSqlite } from './d1-over-sqlite';

export { deleteReq, getReq, ingestReq, legacyIngestReq, statsReq } from '../../collector/tests/helpers';

/**
 * The schema, read from the MIGRATION rather than retyped.
 *
 * `tests/db.test.ts` carries its own inline copy, which is a faithful
 * transcription of the same file. This harness reads the real one instead, so a
 * route suite runs against the table shape the deployment is actually brought
 * to — and so a migration that adds, drops or renames a column cannot leave the
 * route tests green against a schema nobody deployed.
 */
const SCHEMA = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');

export interface Harness {
  db: TelemetryD1;
  /**
   * The database underneath the shim.
   *
   * Exposed because a few tests assert against the STORE rather than through a
   * route — the same thing `collector/tests` does with its `TelemetryDb`
   * handle. Nothing in a route path uses it.
   */
  raw: Database;
  counters: Counters;
  handler: FetchHandler;
  setToday: (day: string) => void;
  advanceMs: (ms: number) => void;
  serverFor: (address: string) => ServerLike;
}

/** Field-for-field the original's, so a ported test's options need no translation. */
export interface HarnessOptions {
  today?: string;
  maxBodyBytes?: number;
  rateLimitPerMin?: number;
  newInstancePerSourcePerHour?: number;
  trustedProxyHops?: number;
  trustedProxies?: readonly string[];
  retentionDays?: number;
  maxInstances?: number;
  newInstancesPerDay?: number;
  minAggregateCell?: number;
  opsKey?: string | null;
  schemaJson?: string | null;
  validator?: HeartbeatValidator;
}

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const raw = new Database(':memory:');
  raw.exec(SCHEMA);
  const db = new TelemetryD1({
    db: new D1OverSqlite(raw),
    retentionDays: opts.retentionDays,
    maxInstances: opts.maxInstances,
    newInstancesPerDay: opts.newInstancesPerDay,
  });
  let today = opts.today ?? '2026-07-09';
  let ms = 1_000_000;
  const counters = new Counters();
  const handler = buildFetchHandler({
    db,
    validator: opts.validator ?? new StubValidator(),
    counters,
    schemaJson: opts.schemaJson ?? null,
    maxBodyBytes: opts.maxBodyBytes,
    rateLimitPerMin: opts.rateLimitPerMin,
    newInstancePerSourcePerHour: opts.newInstancePerSourcePerHour,
    trustedProxyHops: opts.trustedProxyHops,
    trustedProxies: opts.trustedProxies,
    minAggregateCell: opts.minAggregateCell ?? 1,
    opsKey: opts.opsKey ?? null,
    nowUtcDay: () => today,
    nowMs: () => ms,
  });
  return {
    db,
    raw,
    counters,
    handler,
    setToday: (d) => { today = d; },
    advanceMs: (n) => { ms += n; },
    serverFor: (address) => ({ requestIP: () => ({ address }) }),
  };
}
