// Collector entrypoint (`bun run start`).
//
// Fixed internal bind 0.0.0.0:7910; outward exposure and TLS are owned by the
// operator's reverse proxy (see README.md — the no-address-logs expectation
// applies there too, and the trusted-proxy setting below must match the real
// deployment or the per-source throttle is either useless or an outage).
//
// This file is the ONE place that names the canonical validator package. See
// src/validator.ts for the seam.

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

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`${name} must be one of 1/0/true/false, got: ${raw}`);
}

const dbPath = process.env.MYTHICAL_TELEMETRY_DB_PATH || '/data/telemetry.db';
const port = envInt('MYTHICAL_TELEMETRY_PORT', DEFAULT_PORT);

const db = new TelemetryDb({
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
  acceptWireV1: envBool('MYTHICAL_TELEMETRY_ACCEPT_V1', true),
  opsKey: process.env.MYTHICAL_TELEMETRY_OPS_KEY ?? null,
});

db.pruneRetention();
setInterval(() => {
  try {
    db.pruneRetention();
  } catch {
    // Retention is best-effort; never take the service down over it.
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
