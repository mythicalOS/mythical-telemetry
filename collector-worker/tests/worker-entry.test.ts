// The DEPLOYED wiring — `src/worker.ts`, driven as Cloudflare drives it.
//
// Every other suite in this directory builds a handler with `makeHarness`,
// which injects a stub validator, injected clocks and an explicit config.
// That is the right shape for testing routes, and it is what
// `collector/tests/*` does. But it means nothing in this repository ever
// exercised `worker.ts` itself: the canonical-validator import, the `envInt`
// binding reader, the `CF-Connecting-IP` source derivation, the per-isolate
// memoisation and the Cron entrypoint were all evidence-free.
//
// This file closes that. It calls `worker.fetch(req, env)` and
// `worker.scheduled(controller, env)` directly, over the same `D1OverSqlite`
// shim the rest of the suite uses.
//
// ── WHY THE CANONICAL-VALIDATOR TEST LIVES HERE ────────────────────────────
//
// `collector/tests/ingest.test.ts` ends with "the CANONICAL validator, wired as
// production wires it", built on `loadCanonicalValidator()` — a RUNTIME
// `await import(spec)`. A Worker has no module loader, so `worker.ts` wires the
// canonical validator by STATIC import instead. Rebuilding that adapter inside
// a test would prove a copy of the production wiring rather than the wiring, so
// the test was ported to where the real one is: here.
//
// ── WHAT THIS FILE SHARES, AND WHY IT HAS TO ───────────────────────────────
//
// `worker.ts` memoises its handler and its store in MODULE SCOPE, because an
// isolate is the only lifetime a Worker has. There is no reset hook and there
// should not be one — the memoisation is the behaviour under test. So every
// test below runs against ONE store, ONE set of token buckets and ONE counter
// set, exactly as one isolate would. Consequences, and the rules that follow:
//
//   • The first `env` passed WINS for the lifetime of this file. It is built
//     once, below, with a small rate limit so the throttle is reachable.
//   • Each test uses its OWN `CF-Connecting-IP`, because that value is the
//     bucket key. Tests do not borrow each other's budget.
//   • The clock is REAL — there is no `nowUtcDay` seam through this
//     entrypoint — so payload days are computed from `todayUtc()` rather than
//     written as literals.
//
// And the standing caveat that applies to this file as much as the others: the
// store underneath is SQLite pretending to be D1. See `d1-over-sqlite.ts`.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { todayUtc } from '../../collector/src/day';
import {
  INSTANCE_A,
  INSTANCE_B,
  INSTANCE_C,
  makeHeartbeat,
  makeLegacyShape,
  SECRET_A,
  SECRET_B,
  SECRET_C,
} from '../../collector/tests/fixtures';
import { D1OverSqlite } from './d1-over-sqlite';
import worker, { type Env } from '../src/worker';

const SCHEMA = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');

const raw = new Database(':memory:');
raw.exec(SCHEMA);

/**
 * The bindings, as `wrangler.jsonc` would supply them — and as `envInt` reads
 * them: strings, not numbers.
 *
 * The rate limit is deliberately tiny. The deployed default is 60/min, which
 * would need 61 requests to reach; four makes the bucket observable without
 * turning a unit test into a load test, and it is the same control either way.
 */
const env: Env = {
  DB: new D1OverSqlite(raw),
  MYTHICAL_TELEMETRY_RATE_LIMIT_PER_MIN: '4',
  MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL: '1',
  MYTHICAL_TELEMETRY_OPS_KEY: 'ops-secret',
};

/** One request through the deployed entrypoint, from a named client address. */
function fetchAs(clientIp: string | null, req: Request): Promise<Response> {
  if (clientIp !== null) req.headers.set('cf-connecting-ip', clientIp);
  return worker.fetch(req, env);
}

function ingest(payload: unknown, secret?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== undefined) headers['x-mythical-instance-secret'] = secret;
  return new Request('https://telemetry.mythicalos.ai/api/v1/ingest', {
    method: 'POST',
    headers,
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function countRows(instanceId: string, product: string): number {
  const row = raw
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM heartbeats WHERE instance_id = ? AND product = ?',
    )
    .get(instanceId, product);
  return row?.n ?? 0;
}

describe('the canonical validator, wired as the deployment wires it', () => {
  test('the current shape is accepted, the retired one is not, and neither is a stub-only pass', async () => {
    const today = todayUtc();

    // Positive control: without it, a validator that refused EVERYTHING would
    // make the two rejections below look like proof of something.
    const current = makeHeartbeat('brokkr', INSTANCE_A, today);
    expect((await fetchAs('203.0.113.1', ingest(current, SECRET_A))).status).toBe(202);
    expect(countRows(INSTANCE_A, 'brokkr')).toBe(1);

    // Proof this really is the CANONICAL validator and not the stub the other
    // suites inject. The stub only checks that a body carries the right SECTION
    // NAMES, so it accepts this skuld fixture; the canonical validator refuses
    // it on `events.deferrals` (a leaf that does not exist) and on
    // `detection_state` being outside its closed enum.
    const stubWouldAccept = makeHeartbeat('skuld', INSTANCE_A, today);
    expect((await fetchAs('203.0.113.1', ingest(stubWouldAccept, SECRET_A))).status).toBe(400);
    expect(countRows(INSTANCE_A, 'skuld')).toBe(0);

    // ...and the retired shape, carrying the SAME schema_version, is refused on
    // its SHAPE. The version discriminator cannot be what rejects it.
    const legacy = makeLegacyShape(INSTANCE_B, today);
    expect(legacy['schema_version']).toBe(current['schema_version']);
    const r = await fetchAs('203.0.113.1', ingest(legacy, SECRET_B));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'invalid_payload' });
    expect(countRows(INSTANCE_B, 'brokkr')).toBe(0);
  });

  test('the validator seam is reached only AFTER the credential is', async () => {
    // The same ordering the route suites pin, asserted once against the
    // deployed wiring: a document the canonical validator would refuse, sent
    // with no credential, is answered on the credential — not on the schema.
    const r = await fetchAs('203.0.113.2', ingest(makeLegacyShape(INSTANCE_C, todayUtc())));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: 'write_key_mismatch' });
  });
});

describe('CF-Connecting-IP is the source key', () => {
  // On Workers there is no TCP peer to ask: `server.requestIP` does not exist.
  // `CF-Connecting-IP` is written by Cloudflare and cannot be set by the
  // client, so it is the honest analogue — and it is what every throttle in
  // the service is keyed on.
  test('one client address exhausts its own bucket and no one else’s', async () => {
    // Junk bodies with a valid credential: they pass the presence check (so
    // they SPEND a token) and are refused at the parser, which keeps the test
    // about the bucket rather than about the store.
    const spend = (ip: string) => fetchAs(ip, ingest('{{{', SECRET_A));

    for (let i = 0; i < 4; i++) expect((await spend('203.0.113.4')).status, `attempt ${i}`).toBe(400);
    const limited = await spend('203.0.113.4');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, error: 'rate_limited' });

    // A different address is untouched.
    expect((await spend('203.0.113.5')).status).toBe(400);
  });

  test('a request with NO CF-Connecting-IP gets a constant key, never a header-derived one', async () => {
    // `resolveSourceKey` falls back to `peer:unknown`. The property that
    // matters is the negative one: an absent address must not let a caller
    // choose a bucket by sending X-Forwarded-For, which on this deployment is
    // an ordinary client-settable header.
    const spoofed = new Request('https://telemetry.mythicalos.ai/api/v1/ingest', {
      method: 'POST',
      headers: { 'x-mythical-instance-secret': SECRET_A, 'x-forwarded-for': '203.0.113.4' },
      body: '{{{',
    });
    // 203.0.113.4's bucket is already empty from the test above. If the header
    // were believed this would be a 429; it must be a 400 from a different
    // bucket entirely.
    expect((await fetchAs(null, spoofed)).status).toBe(400);
  });
});

describe('the operator surface, gated by the binding', () => {
  test('a wrong ops key => 403; the configured one => 200, reporting no migration', async () => {
    const wrong = await fetchAs(
      '203.0.113.6',
      new Request('https://telemetry.mythicalos.ai/metrics', { headers: { 'x-mythical-ops-key': 'nope' } }),
    );
    expect(wrong.status).toBe(403);

    const ok = await fetchAs(
      '203.0.113.6',
      new Request('https://telemetry.mythicalos.ai/metrics', { headers: { 'x-mythical-ops-key': 'ops-secret' } }),
    );
    expect(ok.status).toBe(200);
    const body = await ok.json() as any;
    // The bindings were read once, at isolate start, and they took effect.
    expect(body.store.retention_days).toBe(90);       // the envInt default
    expect(body.throttle.trusted_proxy_hops).toBe(0); // pinned in worker.ts, not configurable
    // The Worker does not migrate; see `src/server.ts` and the skipped test in
    // `hardening.test.ts`.
    expect(body.migration).toBeNull();
  });
});

describe('the retired per-install page is gone from the deployment too', () => {
  test('GET /i/<uuid> is 404 through the real entrypoint', async () => {
    const r = await fetchAs('203.0.113.7', new Request(`https://telemetry.mythicalos.ai/i/${INSTANCE_A}`));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ ok: false, error: 'not_found' });
  });

  test('GET /health is 200 and needs nothing (C5 triple)', async () => {
    const r = await fetchAs('203.0.113.7', new Request('https://telemetry.mythicalos.ai/health'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime_s).toBe('number');
    expect(Object.keys(body).sort()).toEqual(['ok', 'uptime_s', 'version']);
  });
});

describe('the Cron entrypoint', () => {
  test('scheduled() prunes, and the receipt is visible to /metrics IN THE SAME ISOLATE', async () => {
    // The qualifier is the finding, not a caveat on the test. `lastPrune` is a
    // field on the store object, and the store object belongs to one isolate.
    // Here `fetch` and `scheduled` genuinely share one, so the receipt is
    // readable — which is precisely what will NOT be true in production, where
    // a `/metrics` request lands on whatever isolate the edge picks and reads
    // `null`. See the skipped test in `hardening.test.ts`.
    await worker.scheduled(null, env);

    const r = await fetchAs(
      '203.0.113.8',
      new Request('https://telemetry.mythicalos.ai/metrics', { headers: { 'x-mythical-ops-key': 'ops-secret' } }),
    );
    const body = await r.json() as any;
    expect(body.store.last_prune).not.toBeNull();
    expect(body.store.last_prune.effective_day).toBe(todayUtc());
    // The receipt carries counts and days, never an identity.
    expect(Object.keys(body.store.last_prune).sort()).toEqual([
      'capped_heartbeats',
      'clamp_day',
      'clamped_heartbeats',
      'clamped_instances',
      'cutoff_day',
      'effective_day',
      'expired_heartbeats',
      'expired_instances',
    ]);
    // Today's heartbeat is nowhere near the 90-day cutoff, so nothing went.
    expect(countRows(INSTANCE_A, 'brokkr')).toBe(1);
  });
});

describe('the handler is built ONCE per isolate, and the bindings with it', () => {
  test('a later invocation with different bindings keeps the first ones', async () => {
    // Not a curiosity: it is the operational rule for this deployment. Changing
    // a `MYTHICAL_TELEMETRY_*` variable — or the D1 binding — does not take
    // effect on an isolate that has already served a request. New values reach
    // only isolates created after the change, which is why a config change and
    // a deploy are the same operation here.
    const otherDb = new Database(':memory:');
    otherDb.exec(SCHEMA);
    const otherEnv: Env = {
      DB: new D1OverSqlite(otherDb),
      MYTHICAL_TELEMETRY_OPS_KEY: 'a-different-key',
    };

    // The ORIGINAL key still works...
    const withOldKey = await worker.fetch(
      new Request('https://telemetry.mythicalos.ai/metrics', {
        headers: { 'x-mythical-ops-key': 'ops-secret', 'cf-connecting-ip': '203.0.113.9' },
      }),
      otherEnv,
    );
    expect(withOldKey.status).toBe(200);
    // ...and it is still reading the FIRST database, which has data in it.
    expect((await withOldKey.json() as any).store.instances_total).toBeGreaterThan(0);

    // ...while the new key does not authenticate at all.
    const withNewKey = await worker.fetch(
      new Request('https://telemetry.mythicalos.ai/metrics', {
        headers: { 'x-mythical-ops-key': 'a-different-key', 'cf-connecting-ip': '203.0.113.9' },
      }),
      otherEnv,
    );
    expect(withNewKey.status).toBe(403);
  });
});
