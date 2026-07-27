// Route surface. `buildFetchHandler` returns a Bun.serve-compatible fetch
// function, so tests drive every route with a plain Request — no port bind, no
// real network.
//
//   POST   /v1/ingest                  secret + derived-identity (constant-time)
//   GET    /v1/instances/:uuid/stats   secret + derived-identity  ← G6: reads are authenticated
//   DELETE /v1/instances/:uuid         secret + derived-identity; purges EVERY product
//
// Every one of those three is per-source throttled, because anyone can mint a
// valid (secret, id) pair — an authenticated request is not a scarce one here.
//   GET    /v1/stats                   public, AGGREGATE ONLY
//   GET    /                           public, aggregate give-back page
//   GET    /v1/schema                  the published JSON Schema, when the operator wired one
//   GET    /metrics                    operator-gated counters (absent unless configured)
//   GET    /healthz                    200 {ok:true}
//
// GONE: `GET /i/<uuid>`. See page.ts for why it was deleted rather than
// authenticated.
//
// AUTHORIZATION MODEL (gate G6). The instance id is no longer a bearer read
// capability. Every per-install route — read, write and delete alike — proves
// possession of the install's own secret by recomputing the derivation and
// constant-time comparing. There is no shared or baked key anywhere in this
// service, and no route accepts one.
//
// WIRE ANSWERS ARE COARSE ON PURPOSE. Distinct internal rejection reasons
// collapse into a small set of response bodies so no route can be used as an
// oracle: an absent secret and a wrong secret are the same answer; a
// nonexistent instance and one you cannot authenticate for are the same
// answer. Operators get the fine-grained breakdown from the counters, not from
// the response.
//
// PRIVACY INVARIANTS: no IP is ever logged or stored (the throttle bucket is
// in-memory, process-lifetime only); 4xx bodies never echo the request; unknown
// and never-existed instances are indistinguishable.

import { createHash, timingSafeEqual } from 'node:crypto';
import { dayToEpochUtc, MS_PER_DAY, shiftDay } from './day';
import type { TelemetryDb } from './db';
import { authorizesInstance, UUID_V4_RE } from './identity';
import { Counters, type CounterName } from './counters';
import { parseTrustedProxies } from './ip';
import { normalizeToV2 } from './normalize';
import { renderAggregatePage, type AggregateProductView, type AggregateView } from './page';
import { resolveSourceKey, TokenBucketLimiter, type ServerLike } from './throttle';
import { decorateDay, foldTotals, type TotalsValue } from './totals';
import { safeValidate, type HeartbeatValidator } from './validator';

export type { ServerLike } from './throttle';

export const DEFAULT_MAX_BODY_BYTES = 32_768;
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
export const DEFAULT_NEW_INSTANCE_PER_SOURCE_PER_HOUR = 20;
export const DEFAULT_MIN_AGGREGATE_CELL = 5;
export const DEFAULT_ACTIVE_WINDOW_DAYS = 28;

const DAY_WINDOW_DAYS = 30;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * The canonical secret header. `x-mythical-write-key` is the historical name
 * for the same credential and stays accepted: v1 clients send it, and the
 * whole point of the compatibility window is that they keep working. When both
 * are present the canonical one wins — documented, so neither side has to
 * guess.
 */
const SECRET_HEADER = 'x-mythical-instance-secret';
const LEGACY_SECRET_HEADER = 'x-mythical-write-key';
const OPS_KEY_HEADER = 'x-mythical-ops-key';

/**
 * The closed set of products that may create a storage partition.
 *
 * This is NOT payload validation — the canonical validator has already
 * accepted the document. It is an authorization check on the partition key: a
 * validator that one day widens its product enum must not be able to silently
 * create new partitions in a deployed collector, because `product` is half of
 * the primary key and of every aggregate. Widening is a deliberate act here.
 */
export const STORABLE_PRODUCTS: ReadonlySet<string> = new Set(['brokkr', 'saga', 'skuld']);

export type FetchHandler = (req: Request, server?: ServerLike) => Promise<Response> | Response;

export interface TelemetryServerConfig {
  db: TelemetryDb;
  /**
   * The ONE runtime validator, injected. The collector owns no schema
   * knowledge — see validator.ts.
   */
  validator: HeartbeatValidator;
  /** Served verbatim on GET /v1/schema. Omit and the route does not exist. */
  schemaJson?: string | null;
  maxBodyBytes?: number;
  rateLimitPerMin?: number;
  /** Tighter, separate budget for requests that would create a NEW identity. */
  newInstancePerSourcePerHour?: number;
  /** Reverse proxies in the chain. 0 = never trust X-Forwarded-For. */
  trustedProxyHops?: number;
  /**
   * WHICH peers are those proxies (addresses or CIDRs). Required whenever
   * `trustedProxyHops > 0`; construction throws otherwise.
   */
  trustedProxies?: readonly string[];
  /** Gates GET /metrics. Absent/empty ⇒ the route does not exist. */
  opsKey?: string | null;
  /** Accept v1 payloads (the stated compatibility window). */
  acceptWireV1?: boolean;
  /** Small-cell floor for the public aggregate. */
  minAggregateCell?: number;
  /** Injected clock: current UTC day as YYYY-MM-DD. */
  nowUtcDay?: () => string;
  /** Injected clock: milliseconds (throttle refill). */
  nowMs?: () => number;
  /** Shared counters, so a caller can expose them elsewhere. */
  counters?: Counters;
}

// ---- helpers ----

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** The presented instance secret, canonical header first. */
function readSecret(req: Request): string | null {
  return req.headers.get(SECRET_HEADER) ?? req.headers.get(LEGACY_SECRET_HEADER);
}

interface StatsBody {
  ok: true;
  contract_version: 2;
  product: string;
  instance: {
    id: string;
    product: string;
    first_seen_day: string;
    last_seen_day: string;
    days_reported: number;
  };
  days: unknown[];
  totals: Record<string, TotalsValue>;
}

export function buildFetchHandler(config: TelemetryServerConfig): FetchHandler {
  const { db, validator } = config;
  const schemaJson = config.schemaJson ?? null;
  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const acceptWireV1 = config.acceptWireV1 ?? true;
  const minCell = config.minAggregateCell ?? DEFAULT_MIN_AGGREGATE_CELL;
  const trustedProxyHops = config.trustedProxyHops ?? 0;
  // Throws on a malformed entry — a silently dropped proxy means the header is
  // ignored and the whole population shares one bucket.
  const trustedProxies = parseTrustedProxies(config.trustedProxies ?? []);
  if (trustedProxyHops > 0 && trustedProxies.length === 0) {
    // Fail at construction rather than serve. A hop count with no peer list
    // would honour X-Forwarded-For from whoever connected, which is strictly
    // worse than not configuring it at all.
    throw new Error(
      'trustedProxyHops > 0 requires trustedProxies: naming how many proxies are in the chain without ' +
        'naming WHICH peers they are would let anyone reaching this listener directly choose their own ' +
        'throttle bucket.',
    );
  }
  const opsKey = config.opsKey && config.opsKey.length > 0 ? config.opsKey : null;
  const nowUtcDay = config.nowUtcDay ?? (() => new Date().toISOString().slice(0, 10));
  const nowMs = config.nowMs ?? Date.now;
  const counters = config.counters ?? new Counters();

  const limiter = new TokenBucketLimiter(config.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN, MINUTE_MS, nowMs);
  // Anomaly isolation: minting fresh identities is the expensive, poisoning
  // shape, and it is throttled SEPARATELY and far more tightly than ordinary
  // traffic. An established install is never touched by this budget, so a
  // mint-flood cannot degrade service for anyone already reporting.
  const newInstanceLimiter = new TokenBucketLimiter(
    config.newInstancePerSourcePerHour ?? DEFAULT_NEW_INSTANCE_PER_SOURCE_PER_HOUR,
    HOUR_MS,
    nowMs,
  );

  /**
   * Hard intake cap: read the body chunk by chunk with a running byte count;
   * the moment it exceeds `cap`, cancel the reader and bail — the service never
   * buffers more than cap plus one chunk, even when the request declares no
   * content-length. Returns null when the cap was exceeded.
   */
  async function readBodyCapped(req: Request, cap: number): Promise<Uint8Array | null> {
    if (!req.body) return new Uint8Array(0);
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  function rejectIngest(status: number, error: string, counter: CounterName): Response {
    counters.inc('ingest_rejected_total');
    counters.inc(counter);
    return json(status, { ok: false, error });
  }

  async function handleIngest(req: Request, server?: ServerLike): Promise<Response> {
    // Pinned check order — each step is cheaper than or a precondition of the
    // next, and nothing touches the database before identity is proven:
    //   secret PRESENCE ⇒ 403, per-source throttle ⇒ 429, intake cap ⇒ 413,
    //   JSON parse ⇒ 400, wire version + normalize ⇒ 400, schema ⇒ 400,
    //   storable product ⇒ 400, day window ⇒ 400, derived identity ⇒ 403,
    //   new-identity throttle ⇒ 429, admission ⇒ 429, upsert ⇒ 202.

    // (1) the secret header must be PRESENT before anything else.
    const secret = readSecret(req);
    if (secret === null || secret.length === 0) {
      return rejectIngest(403, 'write_key_mismatch', 'ingest_rejected_missing_secret');
    }

    // (2) per-source throttle. The address is the bucket key and nothing else:
    // never logged, never stored.
    const source = resolveSourceKey(req, server, trustedProxyHops, trustedProxies);
    if (!limiter.allow(source)) {
      return rejectIngest(429, 'rate_limited', 'ingest_rejected_rate_limited');
    }

    // (3) hard intake cap. A declared over-cap length 413s without reading a
    // byte; otherwise the capped streaming read aborts the moment the running
    // count crosses the cap.
    const declaredLength = req.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > maxBody) {
      return rejectIngest(413, 'payload_too_large', 'ingest_rejected_body_too_large');
    }
    const raw = await readBodyCapped(req, maxBody);
    if (raw === null) {
      return rejectIngest(413, 'payload_too_large', 'ingest_rejected_body_too_large');
    }

    // (4) JSON.
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return rejectIngest(400, 'invalid_payload', 'ingest_rejected_malformed_json');
    }

    // (5) wire version + structural normalization into the v2 shape.
    const normalized = normalizeToV2(parsed);
    if (!normalized.ok) {
      return rejectIngest(400, 'invalid_payload', 'ingest_rejected_unsupported_schema_version');
    }
    if (normalized.wireVersion === 1 && !acceptWireV1) {
      return rejectIngest(400, 'invalid_payload', 'ingest_rejected_v1_window_closed');
    }

    // (6) the ONE validator. Everything past this point treats the document as
    // schema-valid; nothing before it does.
    const validated = safeValidate(validator, normalized.value);
    if (!validated.ok) {
      const internal = validated.error.startsWith('validator_')
        ? 'ingest_rejected_validator_error'
        : 'ingest_rejected_schema_invalid';
      return rejectIngest(400, 'invalid_payload', internal);
    }
    const hb = validated.value;

    // (7) storable product — the partition key must be one this service knows.
    const product = hb.product.name;
    if (!STORABLE_PRODUCTS.has(product)) {
      return rejectIngest(400, 'invalid_payload', 'ingest_rejected_unknown_product');
    }

    // (8) day window: day ≤ today UTC and ≥ today−30. Heartbeats are recent by
    // construction, and this also rejects regex-passing non-calendar days.
    const today = nowUtcDay();
    const dayEpoch = dayToEpochUtc(hb.day);
    const todayEpoch = dayToEpochUtc(today);
    if (dayEpoch === null || todayEpoch === null) {
      return rejectIngest(400, 'invalid_payload', 'ingest_rejected_day_out_of_window');
    }
    const age = (todayEpoch - dayEpoch) / MS_PER_DAY;
    if (age < 0 || age > DAY_WINDOW_DAYS) {
      return rejectIngest(400, 'invalid_payload', 'ingest_rejected_day_out_of_window');
    }

    // (9) stateless derived-identity check, constant-time. No registration, no
    // stored key material, no first-writer claim race.
    if (!authorizesInstance(secret, hb.instance_id)) {
      return rejectIngest(403, 'write_key_mismatch', 'ingest_rejected_identity_mismatch');
    }

    // (10) admission control for never-seen identities. The first database read
    // of the request happens HERE, after identity is proven, so it cannot be
    // used as an existence oracle.
    const known = db.isKnownInstance(hb.instance_id, product);
    if (!known && !newInstanceLimiter.allow(source)) {
      return rejectIngest(429, 'rate_limited', 'ingest_rejected_new_instance_source_limit');
    }
    // (11) the authoritative admission decision and the write are ONE
    // transaction — see TelemetryDb.recordHeartbeat. `schema_version` records
    // the WIRE version; the payload is always the normalized v2 document.
    const admission = db.recordHeartbeat(
      hb.instance_id,
      product,
      hb.day,
      normalized.wireVersion,
      JSON.stringify(hb),
      today,
    );
    if (!admission.ok) {
      counters.inc(
        admission.reason === 'instance_capacity'
          ? 'ingest_rejected_instance_capacity'
          : 'ingest_rejected_daily_admission_budget',
      );
      counters.inc('ingest_rejected_total');
      return json(429, { ok: false, error: 'instance_capacity' });
    }

    counters.inc('ingest_accepted_total');
    counters.inc(normalized.wireVersion === 1 ? 'ingest_accepted_wire_v1' : 'ingest_accepted_wire_v2');
    if (!admission.existing) counters.inc('ingest_accepted_new_instance');
    return json(202, { ok: true });
  }

  /** The authenticated per-install read body, or null when there is nothing stored. */
  function buildStatsBody(uuid: string, product: string, recentDays?: number): StatsBody | null {
    const inst = db.getInstance(uuid, product);
    if (!inst) return null;
    const rows = db.getHeartbeats(uuid, product, recentDays);

    const days = rows.map((row) => {
      // A returned day is the stored document with (a) instance_id omitted —
      // it is hoisted to `instance.id` — and (b) brokkr's computed
      // spine.tokens_saved added. Everything else exactly as stored. A stored
      // payload that will not parse yields a placeholder rather than a 500:
      // one bad row must not deny an owner their whole history.
      let payload: Record<string, unknown>;
      try {
        const doc = JSON.parse(row.payload) as unknown;
        payload = typeof doc === 'object' && doc !== null && !Array.isArray(doc)
          ? (doc as Record<string, unknown>)
          : { day: row.day, unreadable: true };
      } catch {
        payload = { day: row.day, unreadable: true };
      }
      delete payload['instance_id'];
      decorateDay(product, payload);
      return payload;
    });

    return {
      ok: true,
      contract_version: 2,
      product,
      instance: {
        id: uuid,
        product,
        first_seen_day: inst.first_seen_day,
        last_seen_day: inst.last_seen_day,
        days_reported: db.countHeartbeats(uuid, product),
      },
      days,
      totals: foldTotals(product, days),
    };
  }

  /**
   * GET /v1/instances/:uuid/stats?product=… — AUTHENTICATED (gate G6).
   *
   * Pinned order, and the order is the security property: path hygiene, then
   * the query parameter, then the secret, and only then any database read. An
   * unauthenticated caller therefore cannot distinguish "this id exists" from
   * "this id does not", because neither answer is ever reached.
   */
  function handleStats(uuid: string, url: URL, req: Request, server?: ServerLike): Response {
    if (!UUID_V4_RE.test(uuid)) {
      counters.inc('read_stats_unauthorized');
      return json(403, { ok: false, error: 'unauthorized' });
    }

    const product = url.searchParams.get('product');
    if (product === null || !STORABLE_PRODUCTS.has(product)) {
      counters.inc('read_stats_unauthorized');
      return json(403, { ok: false, error: 'unauthorized' });
    }

    if (!authorizesInstance(readSecret(req), uuid)) {
      counters.inc('read_stats_unauthorized');
      return json(403, { ok: false, error: 'unauthorized' });
    }

    // Throttled AFTER the identity proof and BEFORE any database work. Anyone
    // can mint valid (secret, id) pairs, so an authenticated request is not a
    // scarce one — without this, unlimited reads reach the store while costing
    // the caller nothing. Proving identity is a single hash and stays cheap,
    // so it is safe to do first.
    if (!limiter.allow(resolveSourceKey(req, server, trustedProxyHops, trustedProxies))) {
      counters.inc('read_stats_rate_limited');
      return json(429, { ok: false, error: 'rate_limited' });
    }

    let recentDays: number | undefined;
    const daysParam = url.searchParams.get('days');
    if (daysParam !== null) {
      if (!/^\d+$/.test(daysParam)) return json(400, { ok: false, error: 'invalid_request' });
      const n = Number(daysParam);
      if (n < 1 || n > 400) return json(400, { ok: false, error: 'invalid_request' });
      recentDays = n;
    }

    const body = buildStatsBody(uuid, product, recentDays);
    if (!body) {
      // Reached only by an authenticated owner, so this reveals nothing to
      // anyone else: you learn your own identity has no data.
      counters.inc('read_stats_unknown');
      return json(404, { ok: false, error: 'unknown_instance' });
    }
    counters.inc('read_stats_ok');
    return json(200, body);
  }

  /**
   * DELETE /v1/instances/:uuid — purges the identity across EVERY product.
   *
   * Pinned order (no existence oracle): (1) UUID shape else the same shaped
   * reject, (2) stateless secret check with NO database read, (3) idempotent
   * purge ⇒ 204 whether rows existed or not.
   */
  function handleDelete(uuid: string, req: Request, server?: ServerLike): Response {
    if (!UUID_V4_RE.test(uuid)) {
      counters.inc('delete_unauthorized');
      return json(403, { ok: false, error: 'unauthorized' });
    }
    if (!authorizesInstance(readSecret(req), uuid)) {
      counters.inc('delete_unauthorized');
      return json(403, { ok: false, error: 'unauthorized' });
    }
    // Same reasoning as the read route, and more pressing: every delete opens
    // a write transaction, so an unthrottled stream of no-op purges is lock
    // pressure on the whole service for the price of a hash per request.
    if (!limiter.allow(resolveSourceKey(req, server, trustedProxyHops, trustedProxies))) {
      counters.inc('delete_rate_limited');
      return json(429, { ok: false, error: 'rate_limited' });
    }
    db.deleteInstance(uuid);
    counters.inc('delete_ok');
    return new Response(null, { status: 204 });
  }

  /** Per-product aggregate with the small-cell floor applied. Never per-install. */
  function buildAggregate(): AggregateView {
    const today = nowUtcDay();
    const since = shiftDay(today, -(DEFAULT_ACTIVE_WINDOW_DAYS - 1));
    const rows = db.aggregates(since);

    const products: AggregateProductView[] = [];
    let suppressed = 0;
    for (const row of rows) {
      if (row.installs_seen < minCell) {
        suppressed += 1;
        continue;
      }
      products.push({
        product: row.product,
        installs_seen: row.installs_seen,
        installs_active: row.installs_active >= minCell ? row.installs_active : null,
        days_reported: row.days_reported,
      });
    }

    counters.inc('read_aggregate_ok');
    return {
      generated_day: today,
      active_window_days: DEFAULT_ACTIVE_WINDOW_DAYS,
      min_cell: minCell,
      products,
      suppressed_products: suppressed,
    };
  }

  function handleAggregateJson(): Response {
    const view = buildAggregate();
    return json(200, {
      ok: true,
      contract_version: 2,
      generated_day: view.generated_day,
      active_window_days: view.active_window_days,
      min_cell: view.min_cell,
      products: view.products,
      suppressed_products: view.suppressed_products,
      // Stated in the payload, not only in prose, so a consumer cannot treat
      // these as measurements by accident.
      data_quality: 'untrusted-public-ingest',
      // Explicitly null rather than absent: each product derives its own
      // identity, so no family figure is computable without double-counting.
      // A null someone has to reason about is safer than a gap someone fills.
      family_total_installs: null,
    });
  }

  function handleMetrics(req: Request): Response | null {
    if (opsKey === null) return null; // route does not exist unless configured
    const presented = req.headers.get(OPS_KEY_HEADER);
    if (presented === null || !constantTimeStringEqual(presented, opsKey)) {
      return json(403, { ok: false, error: 'unauthorized' });
    }
    return json(200, {
      ok: true,
      counters: counters.snapshot(),
      store: {
        instances_total: db.countInstances(),
        new_instances_today: db.admittedOnDay(nowUtcDay()),
        max_instances: db.maxInstances,
        new_instances_per_day: db.newInstancesPerDay,
        retention_days: db.retentionDays,
      },
      throttle: {
        trusted_proxy_hops: trustedProxyHops,
        trusted_proxies_configured: trustedProxies.length,
        rate_limit_keys: limiter.size(),
        new_instance_keys: newInstanceLimiter.size(),
      },
      migration: db.migration,
      accept_wire_v1: acceptWireV1,
    });
  }

  return async function fetchHandler(req: Request, server?: ServerLike): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === '/healthz' && req.method === 'GET') return json(200, { ok: true });
      if (path === '/' && req.method === 'GET') return html(200, renderAggregatePage(buildAggregate()));
      if (path === '/v1/stats' && req.method === 'GET') return handleAggregateJson();
      if (path === '/v1/schema' && req.method === 'GET' && schemaJson !== null) {
        return new Response(schemaJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/metrics' && req.method === 'GET') {
        const res = handleMetrics(req);
        if (res) return res;
      }
      if (path === '/v1/ingest' && req.method === 'POST') return handleIngest(req, server);

      const statsMatch = /^\/v1\/instances\/([^/]+)\/stats$/.exec(path);
      if (statsMatch && req.method === 'GET') return handleStats(statsMatch[1] ?? '', url, req, server);

      const instanceMatch = /^\/v1\/instances\/([^/]+)$/.exec(path);
      if (instanceMatch && req.method === 'DELETE') return handleDelete(instanceMatch[1] ?? '', req, server);

      return json(404, { ok: false, error: 'not_found' });
    } catch {
      // Never leak internals, and never log bodies or addresses.
      counters.inc('internal_error');
      return json(500, { ok: false, error: 'internal' });
    }
  };
}

/**
 * Constant-time comparison for the operator key.
 *
 * Kept local rather than reusing the identity helper because this compares a
 * shared operator credential of arbitrary length, where the length IS
 * potentially secret — so it hashes both sides to a fixed width first, and
 * compares those.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
