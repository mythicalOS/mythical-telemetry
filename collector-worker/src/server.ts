// The Worker's route surface — the deployed counterpart of
// `collector/src/server.ts`.
//
// THESE TWO FILES ARE A KNOWN DUPLICATE PAIR AND MUST BE CHANGED TOGETHER.
// Read `../../docs/TWO-COLLECTORS.md` before editing either of them.
//
// The ROUTING, the check ORDER, the coarse wire answers and every privacy
// invariant are untouched. What changed is colour: D1 has no synchronous read,
// so every function that reaches the store became `async`, and so did every
// function that calls one. That chain is the real cost of this port and it is
// deliberately visible in the diff against the original.
//
// Route surface. `buildFetchHandler` returns a fetch function — which is
// already the shape a Worker exports, so the entrypoint change is genuinely
// trivial. Tests drive every route with a plain Request: no port bind, no
// real network.
//
//   POST   /api/v1/ingest                  secret + derived-identity (constant-time)
//   GET    /api/v1/instances/:uuid/stats   secret + derived-identity  ← G6: reads are authenticated
//   DELETE /api/v1/instances/:uuid         secret + derived-identity; purges EVERY product
//
// Every one of those three is per-source throttled, because anyone can mint a
// valid (secret, id) pair — an authenticated request is not a scarce one here.
//   GET    /api/v1/stats                   public, AGGREGATE ONLY
//   GET    /                               public, aggregate give-back page (HTML)
//   GET    /api/v1/schema                  the published JSON Schema, when the operator wired one
//   GET    /metrics                        operator-gated counters (absent unless configured)
//   GET    /health, HEAD /health           200 {ok, version, uptime_s} — C5 liveness (was /healthz)
//   GET    /openapi.json                   the committed OpenAPI document, served verbatim (C9)
//
// API-M3: the versioned surface moved /v1/* -> /api/v1/* and /healthz -> /health as a HARD CUT
// (no aliases — the old paths 404). This Worker shares ONE document with the collector twin.
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
import { dayToEpochUtc, INGEST_DAY_WINDOW_DAYS, MS_PER_DAY, shiftDay } from '../../collector/src/day';
import type { TelemetryD1 } from './db';
import { authorizesInstance, UUID_V4_RE } from '../../collector/src/identity';
import { Counters, type CounterName } from '../../collector/src/counters';
import { parseTrustedProxies } from '../../collector/src/ip';
import { renderAggregatePage, type AggregateProductView, type AggregateView } from '../../collector/src/page';
import { STORABLE_PRODUCTS } from '../../collector/src/products';
import { resolveSourceKey, TokenBucketLimiter, type ServerLike } from '../../collector/src/throttle';
import { decorateDay, foldRates, foldTotals, type TotalsValue } from '../../collector/src/totals';
import { HEARTBEAT_SCHEMA_VERSION, safeValidate, type HeartbeatValidator } from '../../collector/src/validator';
// The committed OpenAPI document, served verbatim at GET /openapi.json (C9/C13 clause 6). The
// collector imports the SAME file, so both twins serve identical bytes — the route-parity test
// and the byte-equality test bind that. esbuild inlines this JSON into the Worker bundle.
import openapiDocument from '../../api/openapi.json' with { type: 'json' };

export type { ServerLike } from '../../collector/src/throttle';

export const DEFAULT_MAX_BODY_BYTES = 32_768;
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
export const DEFAULT_NEW_INSTANCE_PER_SOURCE_PER_HOUR = 20;
export const DEFAULT_MIN_AGGREGATE_CELL = 5;
export const DEFAULT_ACTIVE_WINDOW_DAYS = 28;
/**
 * How long a computed public aggregate is reused.
 *
 * The figures move at DAY granularity, so recomputing them per request is pure
 * waste — and on a public, unauthenticated route that waste is an
 * amplification lever: a flood of `GET /` would otherwise run a grouped count
 * over the store for every request. With the cache the database work is
 * bounded to once per window no matter how many requests arrive. Staleness of
 * up to this long is immaterial for a population figure, and the page already
 * says the numbers are an upper bound rather than a measurement.
 */
export const DEFAULT_AGGREGATE_CACHE_MS = 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * The canonical secret header. `x-mythical-write-key` is the historical name
 * for the same credential and stays accepted, so a client built against the
 * older name keeps working. When both are present the canonical one wins —
 * documented, so neither side has to guess.
 */
const SECRET_HEADER = 'x-mythical-instance-secret';
const LEGACY_SECRET_HEADER = 'x-mythical-write-key';
const OPS_KEY_HEADER = 'x-mythical-ops-key';

/**
 * The closed set of products that may create a storage partition.
 *
 * SHARED WITH `collector/`, not copied. Of everything these two route layers
 * duplicate, this is the one constant whose drift would change what a
 * deployment ACCEPTS: a product added on one side only means heartbeats that
 * one collector stores and the other refuses as `unknown_product`. Re-exported
 * so this module's surface matches the original's exactly.
 */
export { STORABLE_PRODUCTS };

export type FetchHandler = (req: Request, server?: ServerLike) => Promise<Response> | Response;

export interface TelemetryServerConfig {
  db: TelemetryD1;
  /**
   * The ONE runtime validator, injected. The collector owns no schema
   * knowledge — see validator.ts.
   */
  validator: HeartbeatValidator;
  /** Reported by GET /health (C5 liveness triple). Defaults to '0.0.0'. */
  version?: string;
  /** Served verbatim on GET /api/v1/schema. Omit and the route does not exist. */
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
  /** Small-cell floor for the public aggregate. */
  minAggregateCell?: number;
  /** How long a computed aggregate is reused. 0 recomputes every request (tests). */
  aggregateCacheMs?: number;
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
    /** The day that is NOT a one-day delta. See `rates`. */
    first_report_day: string | null;
    days_reported: number;
  };
  days: unknown[];
  /** Sums and gauges over the WHOLE window, first-report day included. */
  totals: Record<string, TotalsValue>;
  /**
   * Per-day rates, over the window MINUS the first-report day.
   *
   * Exposed as its own object — rather than left for a consumer to compute as
   * `totals.x / days.length` — precisely because that computation is the bug:
   * it averages in a row that carries an installation's entire pre-telemetry
   * history.
   */
  rates: {
    days_counted: number;
    excluded_day: string | null;
    excluded_reason: 'first_report_is_not_a_daily_delta' | null;
    /** null for the object when there is no representative day; null for a leaf whose value is not representable. */
    per_day: Record<string, number | null> | null;
  };
}

/** One entry in the route inventory: an HTTP method and an OpenAPI-style path template. */
export interface RouteSignature {
  readonly method: string;
  readonly path: string;
}

/**
 * The WORKER's route inventory — declared INDEPENDENTLY of the collector's (this file is the
 * deliberate duplicate twin), so the route-parity test comparing the two is a real check: a
 * route added to one and not the other makes the sets differ and the test fails. Kept identical
 * to `collector/src/server.ts`'s ROUTES by that test, not by a shared import. `{id}` is the one
 * path parameter (an instance UUID).
 */
export const ROUTES: readonly RouteSignature[] = [
  { method: 'GET', path: '/health' },
  { method: 'HEAD', path: '/health' },
  { method: 'GET', path: '/openapi.json' },
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/api/v1/stats' },
  { method: 'GET', path: '/api/v1/schema' },
  { method: 'GET', path: '/metrics' },
  { method: 'POST', path: '/api/v1/ingest' },
  { method: 'GET', path: '/api/v1/instances/{id}/stats' },
  { method: 'DELETE', path: '/api/v1/instances/{id}' },
];

/** A route handler; resolving to `null` means "not active in this configuration" → falls to 404. */
type RouteHandler = (
  m: RegExpExecArray,
  req: Request,
  url: URL,
  server?: ServerLike,
) => Response | null | Promise<Response | null>;

/** Compile an OpenAPI-style path template (`/v1/instances/{id}`) to an anchored matcher. */
function compileRoutePattern(path: string): RegExp {
  const body = path.replace(/[.]/g, '\\.').replace(/\{[^}]+\}/g, '([^/]+)');
  return new RegExp(`^${body}$`);
}

export function buildFetchHandler(config: TelemetryServerConfig): FetchHandler {
  const { db, validator } = config;
  const schemaJson = config.schemaJson ?? null;
  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
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
  const version = config.version ?? '0.0.0';
  // Liveness uptime is measured from handler construction, on the injected clock so tests can
  // advance it. Serialized once, since both twins serve identical bytes at /openapi.json.
  const startedAtMs = nowMs();
  const openapiText = JSON.stringify(openapiDocument);

  const rateLimitPerMin = config.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN;
  const aggregateCacheMs = config.aggregateCacheMs ?? DEFAULT_AGGREGATE_CACHE_MS;
  const limiter = new TokenBucketLimiter(rateLimitPerMin, MINUTE_MS, nowMs);
  // Reads and deletes get their OWN budget rather than sharing the ingest one.
  // Anyone can mint a valid (secret, id) pair, so a flood of authenticated
  // reads is cheap to produce; sharing one bucket would let that flood deny
  // HEARTBEAT DELIVERY for every installation behind the same address. It
  // cannot fully isolate callers who share a source — that needs an upstream
  // identity this service does not have, and it is documented as a residual —
  // but it does keep the ingest path out of the blast radius.
  const readLimiter = new TokenBucketLimiter(rateLimitPerMin, MINUTE_MS, nowMs);
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
    //   JSON parse ⇒ 400, schema ⇒ 400, storable product ⇒ 400,
    //   day window ⇒ 400, derived identity ⇒ 403, new-identity throttle ⇒ 429,
    //   admission ⇒ 429, upsert ⇒ 202.

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

    // (5) the ONE validator. Everything past this point treats the document as
    // schema-valid; nothing before it does.
    //
    // There is no pre-check on `schema_version` and no shape negotiation ahead
    // of this line. ONE schema exists, so a document that is not it — including
    // the pre-collapse shape, which declared the SAME version number while
    // putting the body at the top level — is refused here, by the validator,
    // on `metrics` being required and every undeclared section being refused.
    // A version pre-check would be schema knowledge in a service that
    // deliberately holds none, and a second place a payload could be accepted.
    const validated = safeValidate(validator, parsed);
    if (!validated.ok) {
      const internal = validated.error.startsWith('validator_')
        ? 'ingest_rejected_validator_error'
        : 'ingest_rejected_schema_invalid';
      return rejectIngest(400, 'invalid_payload', internal);
    }
    const hb = validated.value;

    // (6) storable product — the partition key must be one this service knows.
    const product = hb.product.name;
    if (!STORABLE_PRODUCTS.has(product)) {
      return rejectIngest(400, 'invalid_payload', 'ingest_rejected_unknown_product');
    }

    // (7) day window: day ≤ today UTC and ≥ today − INGEST_DAY_WINDOW_DAYS.
    // Heartbeats are recent by construction, and this also rejects
    // regex-passing non-calendar days. The bound is shared with the retention
    // arithmetic (see day.ts) because the row cap has to allow for it.
    const today = nowUtcDay();
    const dayEpoch = dayToEpochUtc(hb.day);
    const todayEpoch = dayToEpochUtc(today);
    if (dayEpoch === null || todayEpoch === null) {
      return rejectIngest(400, 'invalid_payload', 'ingest_rejected_day_out_of_window');
    }
    const age = (todayEpoch - dayEpoch) / MS_PER_DAY;
    if (age < 0 || age > INGEST_DAY_WINDOW_DAYS) {
      return rejectIngest(400, 'invalid_payload', 'ingest_rejected_day_out_of_window');
    }

    // (8) stateless derived-identity check, constant-time. No registration, no
    // stored key material, no first-writer claim race.
    if (!authorizesInstance(secret, hb.instance_id)) {
      return rejectIngest(403, 'write_key_mismatch', 'ingest_rejected_identity_mismatch');
    }

    // (9) admission control for never-seen identities. The first database read
    // of the request happens HERE, after identity is proven, so it cannot be
    // used as an existence oracle.
    const known = await db.isKnownInstance(hb.instance_id, product);
    if (!known && !newInstanceLimiter.allow(source)) {
      return rejectIngest(429, 'rate_limited', 'ingest_rejected_new_instance_source_limit');
    }
    // (10) the authoritative admission decision and the write are ONE
    // transaction — see TelemetryDb.recordHeartbeat. `schema_version` records
    // which schema the stored document is; there is one, so it is a constant.
    const admission = await db.recordHeartbeat(
      hb.instance_id,
      product,
      hb.day,
      HEARTBEAT_SCHEMA_VERSION,
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
    if (!admission.existing) counters.inc('ingest_accepted_new_instance');
    return json(202, { ok: true });
  }

  /** The authenticated per-install read body, or null when there is nothing stored. */
  async function buildStatsBody(uuid: string, product: string, recentDays?: number): Promise<StatsBody | null> {
    const inst = await db.getInstance(uuid, product);
    if (!inst) return null;
    const rows = await db.getHeartbeats(uuid, product, recentDays);

    const rendered = rows.map((row) => {
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
      // The ROW key travels alongside the document. Which day a row is for is
      // a fact about the store, not a claim inside a payload that may be
      // corrupt or disagree — and it is what the first-report exclusion below
      // must match on.
      return { rowDay: row.day, payload };
    });
    const days = rendered.map((r) => r.payload);

    // The first heartbeat from an identity is not a one-day delta: a counter
    // with no prior snapshot emits its LIFETIME value, so an install that ran
    // for months before telemetry was enabled reports months as one day. It is
    // stored (the total is real and useful) but excluded from every rate.
    const firstReportDay = inst.first_report_day;
    const rateDays = firstReportDay === null
      ? days
      : rendered.filter((r) => r.rowDay !== firstReportDay).map((r) => r.payload);
    const excluded = firstReportDay !== null && rateDays.length !== days.length;

    return {
      ok: true,
      contract_version: 2,
      product,
      instance: {
        id: uuid,
        product,
        first_seen_day: inst.first_seen_day,
        last_seen_day: inst.last_seen_day,
        first_report_day: firstReportDay,
        days_reported: await db.countHeartbeats(uuid, product),
      },
      days,
      totals: foldTotals(product, days),
      rates: {
        days_counted: rateDays.length,
        excluded_day: excluded ? firstReportDay : null,
        excluded_reason: excluded ? 'first_report_is_not_a_daily_delta' : null,
        per_day: foldRates(product, rateDays),
      },
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
  async function handleStats(uuid: string, url: URL, req: Request, server?: ServerLike): Promise<Response> {
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
    if (!readLimiter.allow(resolveSourceKey(req, server, trustedProxyHops, trustedProxies))) {
      counters.inc('read_stats_rate_limited');
      return json(429, { ok: false, error: 'rate_limited' });
    }

    let recentDays: number | undefined;
    const daysParam = url.searchParams.get('days');
    if (daysParam !== null) {
      if (!/^\d+$/.test(daysParam)) return json(400, { ok: false, error: 'invalid_request' });
      const n = Number(daysParam);
      // Capped at the CONFIGURED retention rather than a second hardcoded
      // number: the window a caller may ask for and the window we actually keep
      // are the same fact, and two literals would drift the moment one moved.
      // Accepting `days` beyond retention would promise a window that cannot be
      // satisfied and quietly return a shorter one.
      if (n < 1 || n > db.retentionDays) return json(400, { ok: false, error: 'invalid_request' });
      recentDays = n;
    }

    const body = await buildStatsBody(uuid, product, recentDays);
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
  async function handleDelete(uuid: string, req: Request, server?: ServerLike): Promise<Response> {
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
    if (!readLimiter.allow(resolveSourceKey(req, server, trustedProxyHops, trustedProxies))) {
      counters.inc('delete_rate_limited');
      return json(429, { ok: false, error: 'rate_limited' });
    }
    await db.deleteInstance(uuid);
    counters.inc('delete_ok');
    return new Response(null, { status: 204 });
  }

  /** Per-product aggregate with the small-cell floor applied. Never per-install. */
  async function buildAggregate(): Promise<AggregateView> {
    const today = nowUtcDay();
    const since = shiftDay(today, -(DEFAULT_ACTIVE_WINDOW_DAYS - 1));
    const rows = await db.aggregates(since);

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

    counters.inc('read_aggregate_recomputed');
    return {
      generated_day: today,
      active_window_days: DEFAULT_ACTIVE_WINDOW_DAYS,
      // Published because it changes what the figures MEAN. Identity rows expire
      // with the last heartbeat of that identity, so "installations seen" counts
      // installations seen within the retention window — not since the beginning.
      // An unqualified "seen" would read as all-time and quietly overstate.
      retention_days: db.retentionDays,
      min_cell: minCell,
      products,
    };
  }

  /**
   * The rendered aggregate, recomputed at most once per cache window.
   *
   * Both public routes serve precomputed bytes, so a request flood costs no
   * database work — see DEFAULT_AGGREGATE_CACHE_MS.
   */
  let aggregateCache: { atMs: number; json: string; html: string } | null = null;
  async function aggregateSnapshot(): Promise<{ json: string; html: string }> {
    const now = nowMs();
    if (aggregateCache !== null && now - aggregateCache.atMs < aggregateCacheMs) return aggregateCache;
    const view = await buildAggregate();
    const body = {
      ok: true,
      contract_version: 2,
      generated_day: view.generated_day,
      active_window_days: view.active_window_days,
      retention_days: view.retention_days,
      min_cell: view.min_cell,
      products: view.products,
      // Stated in the payload, not only in prose, so a consumer cannot treat
      // these as measurements by accident.
      data_quality: 'untrusted-public-ingest',
      // Explicitly null rather than absent: each product derives its own
      // identity, so no family figure is computable without double-counting.
      // A null someone has to reason about is safer than a gap someone fills.
      family_total_installs: null,
    };
    aggregateCache = { atMs: now, json: JSON.stringify(body), html: renderAggregatePage(view) };
    return aggregateCache;
  }

  async function handleMetrics(req: Request, server?: ServerLike): Promise<Response | null> {
    if (opsKey === null) return null; // route does not exist unless configured
    const presented = req.headers.get(OPS_KEY_HEADER);
    if (presented === null || !constantTimeStringEqual(presented, opsKey)) {
      return json(403, { ok: false, error: 'unauthorized' });
    }
    // Counting queries are not free; the key holder is trusted, not unlimited.
    if (!readLimiter.allow(resolveSourceKey(req, server, trustedProxyHops, trustedProxies))) {
      return json(429, { ok: false, error: 'rate_limited' });
    }
    return json(200, {
      ok: true,
      counters: counters.snapshot(),
      store: {
        instances_total: await db.countInstances(),
        new_instances_today: await db.admittedOnDay(nowUtcDay()),
        max_instances: db.maxInstances,
        new_instances_per_day: db.newInstancesPerDay,
        retention_days: db.retentionDays,
        max_rows_per_instance: db.maxRowsPerInstance,
        // The retention clock's own receipt: what the last prune deleted, and the
        // window it used. Null until one has run in this process. Without this an
        // operator has no way to see whether retention is actually happening —
        // and a retention control nobody can observe is how the previous one went
        // years without deleting anything.
        //
        // ON WORKERS THIS IS MUCH WEAKER THAN IT LOOKS. `lastPrune` lives on the
        // store object, which lives in ONE isolate. The prune runs in the
        // Cron Trigger's invocation; a `/metrics` request almost certainly
        // lands on a different isolate and will read `null` for ever. Making
        // this observable again means persisting the receipt (a `meta` row) and
        // reading it back — small, but it is work this port has NOT done, and
        // until it is done the retention clock is unobservable in production.
        last_prune: db.lastPrune,
      },
      throttle: {
        trusted_proxy_hops: trustedProxyHops,
        trusted_proxies_configured: trustedProxies.length,
        rate_limit_keys: limiter.size(),
        read_limit_keys: readLimiter.size(),
        new_instance_keys: newInstanceLimiter.size(),
      },
      // `migration: db.migration` is GONE, and its absence is a real loss.
      //
      // The original surfaces the boot migration's own receipt here — which
      // tables were rebuilt, how many rows were carried, whether the admission
      // ledger was seeded, how many `first_report_day` values were derived.
      // That receipt exists because `migrate.ts` runs INSIDE the service and
      // reports what it did.
      //
      // On D1 the service does not migrate at all: schema changes are applied
      // out of band by `wrangler d1 migrations apply`, and the record of what
      // ran lives in D1's own `d1_migrations` table, which says nothing about
      // rows carried. So an operator loses the ability to ask a RUNNING
      // collector what shape its store was brought to and at what cost.
      // Reporting a fabricated or empty object here would be worse than
      // reporting nothing.
      migration: null,
    });
  }

  // Handlers, keyed by "<method> <path>" to match ROUTES exactly. A handler returning null means
  // the route is not active in this configuration (no ops key, no wired schema) and the dispatch
  // falls through to 404 — the same behaviour the previous if-chain had for /metrics and /v1/schema.
  const routeHandlers: Record<string, RouteHandler> = {
    // C5 liveness triple. Nothing here needs protecting, so it stays unauthenticated.
    'GET /health': () =>
      json(200, { ok: true, version, uptime_s: Math.floor((nowMs() - startedAtMs) / 1000) }),
    // HEAD answers with the same status and headers and an empty body (C5).
    'HEAD /health': () => new Response(null, { status: 200, headers: { 'content-type': 'application/json' } }),
    // C9/C13 clause 6 — the served document IS the committed one (imported above).
    'GET /openapi.json': () =>
      new Response(openapiText, { status: 200, headers: { 'content-type': 'application/json' } }),
    'GET /': async () => {
      // The counter is incremented only AFTER the snapshot is in hand: a failed cache build must
      // not be recorded as a served aggregate.
      const page = (await aggregateSnapshot()).html;
      counters.inc('read_aggregate_ok');
      return html(200, page);
    },
    'GET /api/v1/stats': async () => {
      const body = (await aggregateSnapshot()).json;
      counters.inc('read_aggregate_ok');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    },
    'GET /api/v1/schema': () =>
      schemaJson === null
        ? null
        : new Response(schemaJson, { status: 200, headers: { 'content-type': 'application/json' } }),
    'GET /metrics': (_m, req, _url, server) => handleMetrics(req, server),
    'POST /api/v1/ingest': (_m, req, _url, server) => handleIngest(req, server),
    'GET /api/v1/instances/{id}/stats': (m, req, url, server) => handleStats(m[1] ?? '', url, req, server),
    'DELETE /api/v1/instances/{id}': (m, req, _url, server) => handleDelete(m[1] ?? '', req, server),
  };
  // The dispatcher and the inventory cannot drift: every ROUTES entry must have exactly one
  // handler and vice versa, or construction throws (caught by every test that builds a handler).
  const expectedKeys = ROUTES.map((r) => `${r.method} ${r.path}`);
  if (
    Object.keys(routeHandlers).length !== expectedKeys.length ||
    expectedKeys.some((k) => !(k in routeHandlers))
  ) {
    throw new Error('worker route table drift: ROUTES and routeHandlers disagree');
  }
  const compiled = ROUTES.map((r) => ({ ...r, re: compileRoutePattern(r.path) }));

  return async function fetchHandler(req: Request, server?: ServerLike): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      for (const route of compiled) {
        if (route.method !== req.method) continue;
        const m = route.re.exec(path);
        if (m === null) continue;
        const res = await routeHandlers[`${route.method} ${route.path}`]!(m, req, url, server);
        if (res === null) break; // route not active in this configuration → 404
        return res;
      }
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
