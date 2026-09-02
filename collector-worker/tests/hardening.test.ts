// `collector/tests/hardening.test.ts`, ported to the Worker's route layer.
//
// Public unauthenticated ingest hardening: per-source throttling, the
// trusted-proxy model, the new-identity budgets, and the operator metrics
// surface.
//
// The threat this addresses is NOT impersonation — the derived identity
// already handles that. It is capacity and data poisoning: anyone can mint
// unlimited fresh secrets and submit schema-valid junk. Every control here is
// about bounding that, and about not turning the bound itself into an easier
// denial of service than the flood it defends against.
//
// Mechanical transform only — store calls gained an `await`. No assertion was
// relaxed, with the one exception called out in `the operator metrics surface`
// below, which is a documented deliberate difference and carries a skipped
// test naming the guarantee it costs.
//
// ── READ THIS BEFORE TRUSTING A THROTTLE TEST HERE ─────────────────────────
//
// Every bound asserted in this file is a bound for ONE PROCESS. `helpers.ts`
// builds one handler, so its three token buckets and its counter set live as
// long as the test does — which is what `collector/`'s single Bun process
// actually gives you. A deployed Worker has no process: Cloudflare runs many
// isolates in many colos and recycles them freely, so in production each of
// these buckets bounds a source PER ISOLATE, and a distributed flood is barely
// bounded at all. The route logic asserted below is right; the operational
// guarantee it implies is weaker in the deployment than in this file. See
// `src/worker.ts` → `getHandler`, which says the same thing at the code.
//
// ── WHAT WAS NOT PORTED, AND WHY ───────────────────────────────────────────
//
// Two bodies of the original stay behind:
//
//  1. The `resolveSourceKey` matrix inside `the trusted-proxy model` — sixteen
//     tests that call `resolveSourceKey` and `addressKey` directly and never
//     touch a route. They exercise `collector/src/{ip,throttle}.ts`, which the
//     Worker imports BY REFERENCE (the same module object, not a copy — see
//     `../../docs/TWO-COLLECTORS.md`). Running them again here would assert the
//     same functions twice. The four tests in that block that go THROUGH a
//     route or through `buildFetchHandler`'s constructor are ported, because
//     that code is the Worker's own duplicate.
//
//  2. `TokenBucketLimiter memory bound` — likewise a unit test of the shared
//     `throttle.ts`, constructing a limiter directly.
//
// AND A STANDING CAVEAT ON THE PROXY MODEL. `worker.ts` pins
// `trustedProxyHops: 0` / `trustedProxies: []` and derives the source from
// `CF-Connecting-IP`, so on the DEPLOYED collector the X-Forwarded-For
// apparatus is dead code. The ported end-to-end tests below still exercise it
// because `buildFetchHandler` still accepts it and an operator wiring this
// module differently would get it — but the configuration the deployment
// actually runs is the `hops=0` one, and `worker-entry.test.ts` is where the
// deployed source-key derivation is proven.

import { describe, expect, test } from 'bun:test';
import { getReq, ingestReq, makeHarness } from './helpers';
import {
  INSTANCE_A,
  INSTANCE_B,
  INSTANCE_C,
  makeHeartbeat,
  SECRET_A,
  SECRET_B,
  SECRET_C,
} from '../../collector/tests/fixtures';

describe('per-source throttle', () => {
  test('a bucket exhausts => 429, refills over a minute, and other sources are unaffected', async () => {
    const h = makeHarness({ rateLimitPerMin: 2 });
    const a = h.serverFor('198.51.100.7');
    const b = h.serverFor('203.0.113.9');

    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A), a)).status).toBe(202);
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-08'), SECRET_A), a)).status).toBe(202);
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-07'), SECRET_A), a)).status).toBe(429);
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_B), b)).status).toBe(202);

    h.advanceMs(61_000);
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-06'), SECRET_A), a)).status).toBe(202);
  });

  test('the secret-presence check precedes the limiter, so keyless floods cost no tokens', async () => {
    const h = makeHarness({ rateLimitPerMin: 1 });
    const a = h.serverFor('198.51.100.7');
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A), a)).status).toBe(202);
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A), a)).status).toBe(429);
    const keyless = await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A)), a);
    expect(keyless.status).toBe(403);
    expect(await keyless.json()).toEqual({ ok: false, error: 'write_key_mismatch' });
  });

  test('the limiter does not mask an authorization failure', async () => {
    const h = makeHarness({ rateLimitPerMin: 2 });
    const r = await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_B), h.serverFor('198.51.100.7'));
    expect(r.status).toBe(403);
  });
});

describe('the trusted-proxy model', () => {
  test('configuring hops without naming the proxies fails at construction, not at runtime', () => {
    // A hop count with no peer list would honour X-Forwarded-For from whoever
    // connected — strictly worse than not configuring it at all. This guard
    // lives in the Worker's own `buildFetchHandler`, so it is ported.
    expect(() => makeHarness({ trustedProxyHops: 1 })).toThrow(/requires trustedProxies/);
    expect(() => makeHarness({ trustedProxyHops: 1, trustedProxies: [] })).toThrow(/requires trustedProxies/);
    // ...and a malformed entry is refused rather than silently dropped.
    expect(() => makeHarness({ trustedProxyHops: 1, trustedProxies: ['10.0.0.0/8', 'not-an-ip'] })).toThrow(
      /trusted-proxy list/,
    );
    expect(() => makeHarness({ trustedProxyHops: 1, trustedProxies: ['10.0.0.0/8'] })).not.toThrow();
  });

  test('end to end: hops=1 throttles per real client, not per proxy', async () => {
    const h = makeHarness({ rateLimitPerMin: 1, trustedProxyHops: 1, trustedProxies: ['10.0.0.0/8'] });
    const proxy = h.serverFor('10.0.0.1');
    const asClient = (id: string, secret: string, client: string, day: string) =>
      h.handler(ingestReq(makeHeartbeat('brokkr', id, day), secret, { 'x-forwarded-for': client }), proxy);

    expect((await asClient(INSTANCE_A, SECRET_A, '203.0.113.9', '2026-07-09')).status).toBe(202);
    expect((await asClient(INSTANCE_A, SECRET_A, '203.0.113.9', '2026-07-08')).status).toBe(429);
    // A different real client behind the SAME proxy still has its own budget —
    // this is the outage the model exists to prevent.
    expect((await asClient(INSTANCE_B, SECRET_B, '198.51.100.7', '2026-07-09')).status).toBe(202);
  });

  test('end to end: a direct connection cannot dodge the limiter with the same header', async () => {
    const h = makeHarness({ rateLimitPerMin: 1, trustedProxyHops: 1, trustedProxies: ['10.0.0.0/8'] });
    const direct = h.serverFor('198.51.100.7'); // NOT one of the operator's proxies
    const spoof = (id: string, secret: string, client: string, day: string) =>
      h.handler(ingestReq(makeHeartbeat('brokkr', id, day), secret, { 'x-forwarded-for': client }), direct);

    expect((await spoof(INSTANCE_A, SECRET_A, '1.1.1.1', '2026-07-09')).status).toBe(202);
    expect((await spoof(INSTANCE_B, SECRET_B, '2.2.2.2', '2026-07-09')).status).toBe(429);
  });

  test('end to end: at hops=0 — the DEPLOYED setting — the header cannot be used to dodge the limiter', async () => {
    const h = makeHarness({ rateLimitPerMin: 1 });
    const peer = h.serverFor('10.0.0.1');
    const spoof = (id: string, secret: string, client: string, day: string) =>
      h.handler(ingestReq(makeHeartbeat('brokkr', id, day), secret, { 'x-forwarded-for': client }), peer);

    expect((await spoof(INSTANCE_A, SECRET_A, '1.1.1.1', '2026-07-09')).status).toBe(202);
    expect((await spoof(INSTANCE_B, SECRET_B, '2.2.2.2', '2026-07-09')).status).toBe(429);
  });
});

describe('new-identity admission', () => {
  test('a per-source mint budget throttles fresh identities without touching established ones', async () => {
    const h = makeHarness({ rateLimitPerMin: 1000, newInstancePerSourcePerHour: 1 });
    const src = h.serverFor('198.51.100.7');

    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A), src)).status).toBe(202);
    // Second FRESH identity from the same source is refused...
    const second = await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_B), src);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(h.counters.get('ingest_rejected_new_instance_source_limit')).toBe(1);
    // ...while the identity already established from that source keeps going.
    expect(
      (await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-08'), SECRET_A), src)).status,
    ).toBe(202);
    // ...and a different source is unaffected.
    expect(
      (await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_B), h.serverFor('203.0.113.9'))).status,
    ).toBe(202);
  });

  test('the mint budget refills over an hour, not a minute', async () => {
    const h = makeHarness({ rateLimitPerMin: 1000, newInstancePerSourcePerHour: 1 });
    const src = h.serverFor('198.51.100.7');
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A), src);
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_B), src)).status).toBe(429);
    h.advanceMs(61_000);
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_B), src)).status).toBe(429);
    h.advanceMs(3_600_000);
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_B), src)).status).toBe(202);
  });

  test('the absolute ceiling refuses unseen identities and never established ones', async () => {
    const h = makeHarness({ maxInstances: 1 });
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);
    const r = await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_B));
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ ok: false, error: 'instance_capacity' });
    expect(h.counters.get('ingest_rejected_instance_capacity')).toBe(1);
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-08'), SECRET_A))).status).toBe(202);
  });

  test('the global daily budget bounds the mint rate and reports separately from the ceiling', async () => {
    const h = makeHarness({ maxInstances: 100, newInstancesPerDay: 1, newInstancePerSourcePerHour: 100 });
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);
    const r = await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_B), h.serverFor('203.0.113.9'));
    expect(r.status).toBe(429);
    // Same wire answer as the ceiling — operators get the distinction, callers
    // do not.
    expect(await r.json()).toEqual({ ok: false, error: 'instance_capacity' });
    expect(h.counters.get('ingest_rejected_daily_admission_budget')).toBe(1);
    expect(h.counters.get('ingest_rejected_instance_capacity')).toBe(0);

    // A new day restores it — this is what makes the exhaustion bounded rather
    // than permanent.
    h.setToday('2026-07-10');
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B, '2026-07-10'), SECRET_B))).status).toBe(202);
  });

  test('admission is checked AFTER identity, so it cannot be used as an existence oracle', async () => {
    const h = makeHarness({ maxInstances: 1 });
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    // Wrong secret at a full collector answers 403, not 429 — the caller
    // learns nothing about capacity or about which ids exist.
    const r = await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_A));
    expect(r.status).toBe(403);
    expect(h.counters.get('ingest_rejected_identity_mismatch')).toBe(1);
    expect(h.counters.get('ingest_rejected_instance_capacity')).toBe(0);
  });
});

describe('authenticated reads and deletes are throttled too', () => {
  // Anyone can mint a valid (secret, id) pair, so an authenticated request is
  // not a scarce one. Without a per-source budget on these routes, unlimited
  // reads and no-op purges reach the store for the price of a hash.
  test('a flood of authenticated reads from one source exhausts its bucket', async () => {
    const h = makeHarness({ rateLimitPerMin: 2 });
    const src = h.serverFor('198.51.100.7');
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A), src);

    const read = () =>
      h.handler(
        new Request(`http://telemetry.local/api/v1/instances/${INSTANCE_A}/stats?product=brokkr`, {
          headers: { 'x-mythical-instance-secret': SECRET_A },
        }),
        src,
      );
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
    const limited = await read();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(h.counters.get('read_stats_rate_limited')).toBe(1);
  });

  test('a read flood does NOT deny heartbeat delivery from the same source', async () => {
    // Anyone can mint a valid (secret, id) pair, so authenticated reads are
    // cheap to produce. Sharing one bucket with ingest would let that flood
    // stop every installation behind the same address from reporting.
    const h = makeHarness({ rateLimitPerMin: 2 });
    const src = h.serverFor('198.51.100.7');
    const read = () =>
      h.handler(
        new Request(`http://telemetry.local/api/v1/instances/${INSTANCE_C}/stats?product=brokkr`, {
          headers: { 'x-mythical-instance-secret': SECRET_C },
        }),
        src,
      );
    expect((await read()).status).toBe(404);
    expect((await read()).status).toBe(404);
    expect((await read()).status).toBe(429); // read budget spent
    // ...and ingest from that same source is untouched.
    expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A), src)).status).toBe(202);
  });

  test('a flood of no-op deletes from one source exhausts its bucket', async () => {
    const h = makeHarness({ rateLimitPerMin: 2 });
    const src = h.serverFor('198.51.100.7');
    const purge = () =>
      h.handler(
        new Request(`http://telemetry.local/api/v1/instances/${INSTANCE_C}`, {
          method: 'DELETE',
          headers: { 'x-mythical-instance-secret': SECRET_C },
        }),
        src,
      );
    expect((await purge()).status).toBe(204);
    expect((await purge()).status).toBe(204);
    const limited = await purge();
    expect(limited.status).toBe(429);
    expect(h.counters.get('delete_rate_limited')).toBe(1);
  });

  test('the throttle sits AFTER the identity proof, so it cannot mask a 403', async () => {
    const h = makeHarness({ rateLimitPerMin: 1 });
    const src = h.serverFor('198.51.100.7');
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A), src); // spends the token
    // An unauthenticated caller still gets 403, not 429 — the answer must not
    // depend on someone else's traffic.
    const r = await h.handler(
      new Request(`http://telemetry.local/api/v1/instances/${INSTANCE_A}/stats?product=brokkr`),
      src,
    );
    expect(r.status).toBe(403);
    expect(h.counters.get('read_stats_unauthorized')).toBe(1);
    expect(h.counters.get('read_stats_rate_limited')).toBe(0);
  });

  test('a different source is unaffected, and the bucket refills', async () => {
    const h = makeHarness({ rateLimitPerMin: 1 });
    const a = h.serverFor('198.51.100.7');
    const b = h.serverFor('203.0.113.9');
    const purge = (server: ReturnType<typeof h.serverFor>) =>
      h.handler(
        new Request(`http://telemetry.local/api/v1/instances/${INSTANCE_C}`, {
          method: 'DELETE',
          headers: { 'x-mythical-instance-secret': SECRET_C },
        }),
        server,
      );
    expect((await purge(a)).status).toBe(204);
    expect((await purge(a)).status).toBe(429);
    expect((await purge(b)).status).toBe(204);
    h.advanceMs(61_000);
    expect((await purge(a)).status).toBe(204);
  });

  test('the public aggregate is not throttled — it touches no per-installation data', async () => {
    const h = makeHarness({ rateLimitPerMin: 1, minAggregateCell: 1 });
    const src = h.serverFor('198.51.100.7');
    for (let i = 0; i < 5; i++) {
      expect((await h.handler(getReq('/api/v1/stats'), src)).status).toBe(200);
      expect((await h.handler(getReq('/health'), src)).status).toBe(200);
    }
  });
});

describe('the operator metrics surface', () => {
  test('the route does not exist unless a key is configured', async () => {
    const h = makeHarness();
    const r = await h.handler(getReq('/metrics'));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ ok: false, error: 'not_found' });
  });

  test('a wrong or absent key => 403', async () => {
    const h = makeHarness({ opsKey: 'ops-secret' });
    expect((await h.handler(getReq('/metrics'))).status).toBe(403);
    expect((await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'nope' }))).status).toBe(403);
    expect((await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'ops-secre' }))).status).toBe(403);
    expect((await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'ops-secrets' }))).status).toBe(403);
  });

  test('an absent ops key and a wrong one are the SAME answer', async () => {
    // Not in the original as its own test. Same rule as ingest's two 403s: the
    // wire must not say which guard fired. `/metrics` matters more than most
    // because the credential it gates is a SHARED operator secret rather than a
    // per-install derivation — a distinguishable "wrong" is a confirmation
    // oracle for a guesser.
    const h = makeHarness({ opsKey: 'ops-secret' });
    const absent = await h.handler(getReq('/metrics'));
    const wrong = await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'nope' }));
    const empty = await h.handler(getReq('/metrics', { 'x-mythical-ops-key': '' }));
    expect([absent.status, wrong.status, empty.status]).toEqual([403, 403, 403]);
    const texts = await Promise.all([absent.text(), wrong.text(), empty.text()]);
    expect(texts[0]).toBe(texts[1]);
    expect(texts[1]).toBe(texts[2]);
  });

  test('an unconfigured /metrics answers like any unknown route, not like a refusal', async () => {
    // "The route does not exist" and "you may not have it" are different
    // disclosures: a 403 from an unconfigured deployment would tell a stranger
    // there is an operator surface here to go looking for.
    const unconfigured = makeHarness();
    const metrics = await unconfigured.handler(getReq('/metrics'));
    const nonsense = await unconfigured.handler(getReq('/nothing-here'));
    expect(metrics.status).toBe(nonsense.status);
    expect(await metrics.text()).toBe(await nonsense.text());
  });

  test('the operator key grants NO data access — only counters', async () => {
    const h = makeHarness({ opsKey: 'ops-secret' });
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    // It is not a write credential...
    const write = await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), 'ops-secret'));
    expect(write.status).toBe(403);
    // ...nor a read one.
    const read = await h.handler(
      new Request(`http://telemetry.local/api/v1/instances/${INSTANCE_A}/stats?product=brokkr`, {
        headers: { 'x-mythical-ops-key': 'ops-secret' },
      }),
    );
    expect(read.status).toBe(403);
  });

  test('the snapshot carries every counter and the store gauges — and reports NO migration', async () => {
    const h = makeHarness({ opsKey: 'ops-secret' });
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    await h.handler(ingestReq('{{{', SECRET_A));

    const body = await (await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'ops-secret' }))).json() as any;
    expect(body.counters.ingest_accepted_total).toBe(1);
    expect(body.counters.ingest_rejected_malformed_json).toBe(1);
    expect(body.counters.ingest_rejected_instance_capacity).toBe(0); // present as a zero
    expect(body.store.instances_total).toBe(1);
    expect(body.store.new_instances_today).toBe(1);
    expect(body.throttle.trusted_proxy_hops).toBe(0);
    // THE ONE CHANGED EXPECTATION IN THIS FILE. The original asserts
    // `body.migration.createdFresh === true`, because `collector/` runs
    // `migrate.ts` inside the service and reports its receipt here. The Worker
    // does not migrate at all — `wrangler d1 migrations apply` does, out of
    // band — so the field is deliberately `null` rather than a fabricated
    // object. It is a documented difference, not a relaxation; the guarantee it
    // costs is named in the skipped test at the bottom of this file.
    expect(Object.hasOwn(body, 'migration')).toBe(true);
    expect(body.migration).toBeNull();
    // No wire-version gauge exists: there is one schema, so there is nothing
    // for an operator to switch on or watch drain.
    expect(body).not.toHaveProperty('accept_wire_v1');
    expect(Object.keys(body.counters).filter((k) => /wire_v|window_closed/.test(k))).toEqual([]);
    // No installation identity appears anywhere in it.
    expect(JSON.stringify(body)).not.toContain(INSTANCE_A);
  });

  test('the retention clock is OBSERVABLE: the last prune is reported, receipts and all', async () => {
    // A retention control whose operation leaves no trace is a control nobody
    // can check — which is how a row cap passed for a 90-day clock for as long
    // as it did. `last_prune` is the receipt.
    //
    // ON THIS STORE THE RECEIPT HAS NO `wal_truncated`, and that is deliberate:
    // D1 exposes no write-ahead log and refuses `PRAGMA wal_checkpoint`, so a
    // permanently-`false` key would be a standing false negative on this very
    // route. See `PruneReportD1` and the skipped WAL tests in `db.test.ts`.
    const h = makeHarness({ opsKey: 'ops-secret', retentionDays: 30 });
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));

    const before = await (await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'ops-secret' }))).json() as any;
    expect(before.store.retention_days).toBe(30);
    expect(before.store.max_rows_per_instance).toBe(30 + 31);
    expect(before.store.last_prune).toBeNull(); // nothing has run yet in this process

    await h.db.recordHeartbeat('long-gone', 'brokkr', '2026-01-01', 1, '{}', '2026-01-01');
    expect(await h.db.countHeartbeats('long-gone', 'brokkr')).toBe(1);
    await h.db.pruneRetention('2026-07-09');
    // The receipt is checked against the STORE, not just against itself — a
    // report saying rows went while the rows stayed would be the worst of both.
    expect(await h.db.countHeartbeats('long-gone', 'brokkr')).toBe(0);
    expect(await h.db.getInstance('long-gone', 'brokkr')).toBeNull();

    const after = await (await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'ops-secret' }))).json() as any;
    expect(after.store.last_prune).toEqual({
      effective_day: '2026-07-09',
      cutoff_day: '2026-06-10',
      clamp_day: '2026-07-10',
      clamped_heartbeats: 0,
      clamped_instances: 0,
      expired_heartbeats: 1,
      capped_heartbeats: 0,
      expired_instances: 1,
    });
    // The identity that is still reporting is untouched by the same prune.
    expect(after.store.instances_total).toBe(1);
    // Still counts only — no identity travels in the receipt.
    expect(JSON.stringify(after)).not.toContain('long-gone');
  });

  test('the metrics response never contains an address', async () => {
    const h = makeHarness({ opsKey: 'ops-secret' });
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_C), SECRET_C), h.serverFor('198.51.100.7'));
    const text = await (await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'ops-secret' }))).text();
    expect(text).not.toContain('198.51.100.7');
  });
});

// ── Unportable to the Worker runtime ───────────────────────────────────────
//
// Same convention as `db.test.ts`: a guarantee this deployment does not have is
// declared here, named and skipped, so the runner reports it on every run.
// Deleting it would make a lost guarantee look like one nobody wanted.
describe('UNPORTABLE — /metrics guarantees the reference collector has and this one does not', () => {
  test.skip(
    'the migration receipt is served on /metrics — UNPORTABLE: the Worker does not migrate',
    () => {
      // `collector/tests/hardening.test.ts` asserts `body.migration.createdFresh`.
      // The reference collector runs `migrate.ts` at boot and reports what it
      // did: which tables were rebuilt, how many rows were carried, whether the
      // admission ledger was seeded, how many `first_report_day` values were
      // derived. An operator can ask a RUNNING collector what shape its store
      // was brought to and at what cost.
      //
      // On D1 the schema is applied out of band by
      // `wrangler d1 migrations apply`, and D1's own `d1_migrations` table
      // records only WHICH migration ran — nothing about rows carried. There is
      // no receipt to serve, and fabricating one would be worse than none, so
      // `migration` is `null`. See `src/server.ts` for the same note at the code.
    },
  );

  test.skip(
    'last_prune is observable in production — UNPORTABLE: it lives in ONE isolate, and the prune runs in another',
    () => {
      // The ported test above passes, and it is honest about the ROUTE: given a
      // store whose `lastPrune` is set, /metrics reports it faithfully.
      //
      // What it cannot show is that a deployed operator will ever SEE one.
      // `lastPrune` is a field on the store object, which lives in the isolate
      // that created it. The prune runs inside the Cron Trigger's invocation; a
      // `/metrics` request almost certainly lands on a different isolate and
      // reads `null` — for ever, no matter how many prunes have run.
      //
      // So on this deployment the retention clock is running and UNOBSERVABLE,
      // which is the precondition of the failure `last_prune` was added to
      // prevent. Fixing it means persisting the receipt (a `meta` row) and
      // reading it back — small, and not done. Nothing in a single-process bun
      // test can assert the loss, which is exactly why it is written down here.
    },
  );
});
