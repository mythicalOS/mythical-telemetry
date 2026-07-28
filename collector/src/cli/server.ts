// Collector entrypoint (`bun run start`).
//
// Fixed internal bind 0.0.0.0:7910; outward exposure and TLS are owned by the
// operator's reverse proxy (see README.md — the no-address-logs expectation
// applies there too, and the trusted-proxy setting below must match the real
// deployment or the per-source throttle is either useless or an outage).
//
// This file is the ONE place that names the canonical validator package. See
// src/validator.ts for the seam.

import { todayUtc } from '../day';
import { TelemetryDb, DEFAULT_MAX_INSTANCES, DEFAULT_NEW_INSTANCES_PER_DAY, DEFAULT_RETENTION_DAYS } from '../db';
import {
  buildFetchHandler,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MIN_AGGREGATE_CELL,
  DEFAULT_NEW_INSTANCE_PER_SOURCE_PER_HOUR,
  DEFAULT_RATE_LIMIT_PER_MIN,
} from '../server';
import { loadCanonicalValidator } from '../validator';

const DEFAULT_PORT = 7910;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How long the service may keep serving after retention last succeeded.
 *
 * Two missed daily prunes. A single failure is worth riding out — a lock, a
 * transient IO error — but a persistent one means the window is no longer being
 * enforced while data keeps arriving, and a collector that cannot delete must
 * not go on collecting. At the deadline the process exits non-zero rather than
 * quietly becoming a store with no retention.
 */
const PRUNE_FAILURE_DEADLINE_MS = 2 * PRUNE_INTERVAL_MS;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  }
  return n;
}

/** Comma-separated list; empty entries dropped. Malformed values fail in the server. */
function envList(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

const dbPath = process.env.MYTHICAL_TELEMETRY_DB_PATH || '/data/telemetry.db';
const port = envInt('MYTHICAL_TELEMETRY_PORT', DEFAULT_PORT);

const db = new TelemetryDb({
  // A retention of 0 is rejected by TelemetryDb rather than honoured — it
  // would delete every heartbeat on the next prune.
  path: dbPath,
  retentionDays: envInt('MYTHICAL_TELEMETRY_RETENTION_DAYS', DEFAULT_RETENTION_DAYS),
  maxInstances: envInt('MYTHICAL_TELEMETRY_MAX_INSTANCES', DEFAULT_MAX_INSTANCES),
  newInstancesPerDay: envInt('MYTHICAL_TELEMETRY_NEW_INSTANCES_PER_DAY', DEFAULT_NEW_INSTANCES_PER_DAY),
});

// ── MERGE POINT ───────────────────────────────────────────────────────────
// The canonical validator is loaded here and nowhere else. A failure to load
// is fatal on purpose: the collector must never fall back to accepting
// payloads it cannot validate.
const validator = await loadCanonicalValidator();
// ──────────────────────────────────────────────────────────────────────────

const handler = buildFetchHandler({
  db,
  validator,
  maxBodyBytes: envInt('MYTHICAL_TELEMETRY_MAX_BODY', DEFAULT_MAX_BODY_BYTES),
  rateLimitPerMin: envInt('MYTHICAL_TELEMETRY_RATE_LIMIT_PER_MIN', DEFAULT_RATE_LIMIT_PER_MIN),
  newInstancePerSourcePerHour: envInt(
    'MYTHICAL_TELEMETRY_NEW_INSTANCE_PER_SOURCE_PER_HOUR',
    DEFAULT_NEW_INSTANCE_PER_SOURCE_PER_HOUR,
  ),
  trustedProxyHops: envInt('MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS', 0),
  trustedProxies: envList('MYTHICAL_TELEMETRY_TRUSTED_PROXIES'),
  minAggregateCell: envInt('MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL', DEFAULT_MIN_AGGREGATE_CELL),
  opsKey: process.env.MYTHICAL_TELEMETRY_OPS_KEY ?? null,
});

// Retention runs BEFORE the first request is served, and a failure here is
// deliberately fatal: a collector that cannot delete must not start accepting
// data it has promised to delete. `todayUtc()` is read per tick, never captured —
// a cutoff frozen at boot would stop moving and the clock would stall silently,
// which is the whole failure this prune exists to end.
db.pruneRetention(todayUtc());
let lastPruneOkMs = Date.now();
setInterval(() => {
  try {
    db.pruneRetention(todayUtc());
    lastPruneOkMs = Date.now();
  } catch (err) {
    // One failure is survivable — a lock, a transient IO error — but it is never
    // swallowed: an unreported failure leaves data past the window with nothing
    // to show for it. No request data or address is involved in this line.
    console.error(`retention prune failed: ${err instanceof Error ? err.message : String(err)}`);
    if (Date.now() - lastPruneOkMs > PRUNE_FAILURE_DEADLINE_MS) {
      // Fail closed, exactly as the start-up prune does. Serving on would mean
      // accepting data under a retention promise nothing is enforcing, and the
      // longer it ran the more indefensible the promise would get. Exiting is
      // loud: a supervisor restarts, the start-up prune runs, and either it
      // works or the service stays down where someone will notice.
      console.error(
        'retention has not succeeded within the failure deadline; exiting rather than collecting ' +
          'data this service can no longer promise to delete',
      );
      process.exit(1);
    }
  }
}, PRUNE_INTERVAL_MS).unref();

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch: (req, server) => handler(req, server),
});

// Startup lines only — this service never logs request data or addresses.
console.log(`collector listening on 0.0.0.0:${port} (db: ${dbPath})`);
console.log(
  `migration: ${JSON.stringify(db.migration)} · trusted proxy hops: ${envInt('MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS', 0)}`,
);
