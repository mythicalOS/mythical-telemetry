// Shared service-test harness: pure fetch handlers driven with `new Request`
// — no port bind, no real network. A `:memory:` bun:sqlite per harness, and
// injected clocks (nowUtcDay for the day window, nowMs for the throttles).

import { TelemetryDb } from '../src/db';
import { Counters } from '../src/counters';
import { buildFetchHandler, type FetchHandler } from '../src/server';
import type { ServerLike } from '../src/throttle';
import type { HeartbeatValidator } from '../src/validator';
import { StubValidator } from './fixtures';

export interface Harness {
  db: TelemetryDb;
  counters: Counters;
  handler: FetchHandler;
  setToday: (day: string) => void;
  advanceMs: (ms: number) => void;
  serverFor: (address: string) => ServerLike;
}

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
  acceptWireV1?: boolean;
  opsKey?: string | null;
  schemaJson?: string | null;
  validator?: HeartbeatValidator;
}

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const db = new TelemetryDb({
    path: ':memory:',
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
    acceptWireV1: opts.acceptWireV1,
    opsKey: opts.opsKey ?? null,
    nowUtcDay: () => today,
    nowMs: () => ms,
  });
  return {
    db,
    counters,
    handler,
    setToday: (d) => { today = d; },
    advanceMs: (n) => { ms += n; },
    serverFor: (address) => ({ requestIP: () => ({ address }) }),
  };
}

export function ingestReq(payload: unknown, secret?: string, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
  if (secret !== undefined) h['x-mythical-instance-secret'] = secret;
  return new Request('http://telemetry.local/v1/ingest', {
    method: 'POST',
    headers: h,
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

/** Ingest using the historical header name, as a v1 client would. */
export function legacyIngestReq(payload: unknown, secret: string): Request {
  return new Request('http://telemetry.local/v1/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mythical-write-key': secret },
    body: JSON.stringify(payload),
  });
}

export function statsReq(uuid: string, product?: string, opts: { secret?: string; days?: string } = {}): Request {
  const params = new URLSearchParams();
  if (product !== undefined) params.set('product', product);
  if (opts.days !== undefined) params.set('days', opts.days);
  const q = params.toString();
  const headers: Record<string, string> = {};
  if (opts.secret !== undefined) headers['x-mythical-instance-secret'] = opts.secret;
  return new Request(`http://telemetry.local/v1/instances/${uuid}/stats${q ? `?${q}` : ''}`, { headers });
}

export function deleteReq(uuid: string, secret?: string): Request {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers['x-mythical-instance-secret'] = secret;
  return new Request(`http://telemetry.local/v1/instances/${uuid}`, { method: 'DELETE', headers });
}

export function getReq(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://telemetry.local${path}`, { headers });
}
