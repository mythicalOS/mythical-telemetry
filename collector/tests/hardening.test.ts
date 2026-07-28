// Public unauthenticated ingest hardening: per-source throttling, the
// trusted-proxy model, the new-identity budgets, and the operator metrics
// surface.
//
// The threat this addresses is NOT impersonation — the derived identity
// already handles that. It is capacity and data poisoning: anyone can mint
// unlimited fresh secrets and submit schema-valid junk. Every control here is
// about bounding that, and about not turning the bound itself into an easier
// denial of service than the flood it defends against.

import { describe, expect, test } from 'bun:test';
import { addressKey, parseTrustedProxies } from '../src/ip';
import { resolveSourceKey, TokenBucketLimiter } from '../src/throttle';
import { getReq, ingestReq, makeHarness } from './helpers';
import { INSTANCE_A, INSTANCE_B, INSTANCE_C, makeHeartbeat, SECRET_A, SECRET_B, SECRET_C } from './fixtures';

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
  const req = (xff?: string) =>
    new Request('http://telemetry.local/v1/ingest', { headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  const server = (address: string) => ({ requestIP: () => ({ address }) });
  // The operator's own proxies. Nothing outside this list is ever believed.
  const PROXIES = parseTrustedProxies(['10.0.0.0/8', '2001:db8:1::/48']);
  // The bucket key is CANONICAL bytes, not the text that produced them.
  const key = (address: string) => addressKey(address)!;

  test('at the default of ZERO hops, X-Forwarded-For is ignored entirely', () => {
    expect(resolveSourceKey(req('1.2.3.4'), server('10.0.0.1'), 0, PROXIES)).toBe(key('10.0.0.1'));
    expect(resolveSourceKey(req('1.2.3.4, 5.6.7.8'), server('10.0.0.1'), 0, PROXIES)).toBe(key('10.0.0.1'));
  });

  test('an UNTRUSTED peer can never choose its own bucket, however plausible the header', () => {
    // The finding this closes: a hop count alone would honour the header from
    // whoever connected, so anyone with a direct route to the listener could
    // hand themselves any bucket they liked.
    expect(resolveSourceKey(req('203.0.113.9'), server('198.51.100.7'), 1, PROXIES)).toBe(key('198.51.100.7'));
    expect(resolveSourceKey(req('1.1.1.1, 2.2.2.2'), server('198.51.100.7'), 2, PROXIES)).toBe(key('198.51.100.7'));
    // Empty allowlist means no peer is trusted at all.
    expect(resolveSourceKey(req('203.0.113.9'), server('10.0.0.1'), 1, [])).toBe(key('10.0.0.1'));
  });

  test('with one trusted hop, the client address is taken and a spoofed prefix is ignored', () => {
    expect(resolveSourceKey(req('203.0.113.9'), server('10.0.0.1'), 1, PROXIES)).toBe(key('203.0.113.9'));
    expect(resolveSourceKey(req('evil.spoof, 203.0.113.9'), server('10.0.0.1'), 1, PROXIES)).toBe(key('203.0.113.9'));
    expect(resolveSourceKey(req('1.1.1.1, 2.2.2.2, 203.0.113.9'), server('10.0.0.1'), 1, PROXIES)).toBe(key('203.0.113.9'));
  });

  test('with two trusted hops the second-from-right entry is taken', () => {
    // The intermediate hop is 10.0.0.2 — INSIDE the trusted range, because a
    // two-hop chain is only a chain the operator described if both of its
    // proxies are ones the operator named. See the bypass test below.
    expect(resolveSourceKey(req('203.0.113.9, 10.0.0.2'), server('10.0.0.1'), 2, PROXIES)).toBe(key('203.0.113.9'));
    expect(resolveSourceKey(req('spoof, 203.0.113.9, 10.0.0.2'), server('10.0.0.1'), 2, PROXIES)).toBe(key('203.0.113.9'));
  });

  test('a DECLARED HOP that is not one of the operator\'s proxies is not taken on faith', () => {
    // The bypass this closes. At two or more hops, verifying only the immediate
    // peer left the inner positions of the chain unverified. An attacker who
    // can reach an INNER proxy directly — skipping an outer one — writes those
    // entries himself, and the entry the resolver then selects is one he chose:
    //
    //   attacker 198.51.100.7 -> P2 (10.0.0.1, trusted) -> collector
    //   attacker sends:  "EVIL, <anything>"
    //   P2 appends him:  "EVIL, <anything>, 198.51.100.7"
    //   index = len - 2  ⇒  <anything>
    //
    // which is a freely rotatable throttle bucket, defeating the ingest, read
    // and new-identity limiters at once. Every one of these must now come back
    // as the peer instead.
    for (const chosen of ['1.2.3.4', '5.6.7.8', '9.9.9.9', '203.0.113.9']) {
      expect(
        resolveSourceKey(req(`EVIL, ${chosen}, 198.51.100.7`), server('10.0.0.1'), 2, PROXIES),
        chosen,
      ).toBe(key('10.0.0.1'));
    }
    // The same shape one level deeper.
    expect(resolveSourceKey(req('a, 1.2.3.4, 172.16.0.1, 198.51.100.7'), server('10.0.0.1'), 3, PROXIES)).toBe(
      key('10.0.0.1'),
    );
    // An operator who declares two hops but lists only the inner proxy has not
    // described a chain this code can verify, so it degrades to the peer — the
    // safe direction — rather than trusting an unverifiable hop.
    expect(resolveSourceKey(req('203.0.113.9, 172.16.0.1'), server('10.0.0.1'), 2, PROXIES)).toBe(key('10.0.0.1'));
  });

  test('one hop is unaffected — there is nothing to the right of the selected entry', () => {
    // Guards against the new check over-reaching into the common configuration.
    expect(resolveSourceKey(req('1.2.3.4, 198.51.100.7'), server('10.0.0.1'), 1, PROXIES)).toBe(key('198.51.100.7'));
    expect(resolveSourceKey(req('203.0.113.9'), server('10.0.0.1'), 1, PROXIES)).toBe(key('203.0.113.9'));
  });

  test('an IPv4-mapped IPv6 peer still matches an IPv4 CIDR', () => {
    // A dual-stack listener commonly reports an IPv4 peer this way.
    expect(resolveSourceKey(req('203.0.113.9'), server('::ffff:10.0.0.1'), 1, PROXIES)).toBe(key('203.0.113.9'));
  });

  test('an IPv6 proxy inside its prefix is trusted; one outside it is not', () => {
    expect(resolveSourceKey(req('203.0.113.9'), server('2001:db8:1::5'), 1, PROXIES)).toBe(key('203.0.113.9'));
    expect(resolveSourceKey(req('203.0.113.9'), server('2001:db8:9::5'), 1, PROXIES)).toBe(key('2001:db8:9::5'));
  });

  test('every failure falls back to the peer address, never to a header value', () => {
    // Chain shorter than declared: the request did not arrive the expected way.
    expect(resolveSourceKey(req('203.0.113.9'), server('10.0.0.1'), 2, PROXIES)).toBe(key('10.0.0.1'));
    // No header at all.
    expect(resolveSourceKey(req(), server('10.0.0.1'), 1, PROXIES)).toBe(key('10.0.0.1'));
    // Empty / whitespace-only chain.
    expect(resolveSourceKey(req(' , , '), server('10.0.0.1'), 1, PROXIES)).toBe(key('10.0.0.1'));
    // Implausible values: with a MISCONFIGURED hop count an attacker-supplied
    // entry could be selected, and must not be able to mint arbitrary keys.
    expect(resolveSourceKey(req('not an address'), server('10.0.0.1'), 1, PROXIES)).toBe(key('10.0.0.1'));
    expect(resolveSourceKey(req('999'), server('10.0.0.1'), 1, PROXIES)).toBe(key('10.0.0.1'));
    expect(resolveSourceKey(req('x'.repeat(400)), server('10.0.0.1'), 1, PROXIES)).toBe(key('10.0.0.1'));
    expect(resolveSourceKey(req('<script>'), server('10.0.0.1'), 1, PROXIES)).toBe(key('10.0.0.1'));
    // "Address-ish" near misses must not become keys either — this is what
    // makes the misconfigured-hop-count case bounded rather than unbounded.
    for (const nearMiss of ['a:a', '1.2.3', '::ffff:', '2001:db8:192.0.2.1::', 'fe80::1%', 'fe80::1%a%b']) {
      expect(resolveSourceKey(req(nearMiss), server('10.0.0.1'), 1, PROXIES), nearMiss).toBe(key('10.0.0.1'));
    }
  });

  test('the bucket key is canonical, so one source cannot spell itself two ways', () => {
    expect(resolveSourceKey(req('::ffff:203.0.113.9'), server('10.0.0.1'), 1, PROXIES)).toBe(key('203.0.113.9'));
    expect(resolveSourceKey(req('2001:0db8:0000::0001'), server('10.0.0.1'), 1, PROXIES)).toBe(key('2001:db8::1'));
  });

  test('IPv6 client forms are accepted', () => {
    expect(resolveSourceKey(req('2001:db8::1'), server('10.0.0.1'), 1, PROXIES)).toBe(key('2001:db8::1'));
    expect(resolveSourceKey(req('fe80::1%eth0'), server('10.0.0.1'), 1, PROXIES)).toBe(key('fe80::1%eth0'));
  });

  test('with no peer address available at all, the key is a constant rather than a header value', () => {
    expect(resolveSourceKey(req('1.2.3.4'), undefined, 0, PROXIES)).toBe('peer:unknown');
    expect(resolveSourceKey(req(), undefined, 1, PROXIES)).toBe('peer:unknown');
    // "unknown" is not an address, so it is never trusted as a proxy either.
    expect(resolveSourceKey(req('1.2.3.4'), undefined, 1, PROXIES)).toBe('peer:unknown');
  });

  test('configuring hops without naming the proxies fails at construction, not at runtime', () => {
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

  test('end to end: at hops=0 the same header cannot be used to dodge the limiter', async () => {
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

describe('TokenBucketLimiter memory bound', () => {
  test('idle keys are swept, so ordinary churn does not grow the map without bound', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(10, 60_000, () => now, 8);
    for (let i = 0; i < 8; i++) limiter.allow(`k${i}`);
    expect(limiter.size()).toBe(8);
    now += 60_000 * 11; // past the idle horizon
    limiter.allow('fresh');
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });

  test('when nothing is idle, the least-recently-seen keys are evicted to the ceiling', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(10, 60_000, () => now, 8);
    for (let i = 0; i < 8; i++) {
      now += 1;
      limiter.allow(`k${i}`);
    }
    now += 1;
    limiter.allow('newcomer');
    expect(limiter.size()).toBeLessThanOrEqual(8);
    expect(limiter.size()).toBeGreaterThan(0);
  });

  test('a non-positive limit disables the bucket entirely', () => {
    const limiter = new TokenBucketLimiter(0, 60_000, () => 0);
    for (let i = 0; i < 1000; i++) expect(limiter.allow('k')).toBe(true);
    expect(limiter.size()).toBe(0);
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
        new Request(`http://telemetry.local/v1/instances/${INSTANCE_A}/stats?product=brokkr`, {
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
        new Request(`http://telemetry.local/v1/instances/${INSTANCE_C}/stats?product=brokkr`, {
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
        new Request(`http://telemetry.local/v1/instances/${INSTANCE_C}`, {
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
      new Request(`http://telemetry.local/v1/instances/${INSTANCE_A}/stats?product=brokkr`),
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
        new Request(`http://telemetry.local/v1/instances/${INSTANCE_C}`, {
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
      expect((await h.handler(getReq('/v1/stats'), src)).status).toBe(200);
      expect((await h.handler(getReq('/healthz'), src)).status).toBe(200);
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

  test('the operator key grants NO data access — only counters', async () => {
    const h = makeHarness({ opsKey: 'ops-secret' });
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    // It is not a write credential...
    const write = await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), 'ops-secret'));
    expect(write.status).toBe(403);
    // ...nor a read one.
    const read = await h.handler(
      new Request(`http://telemetry.local/v1/instances/${INSTANCE_A}/stats?product=brokkr`, {
        headers: { 'x-mythical-ops-key': 'ops-secret' },
      }),
    );
    expect(read.status).toBe(403);
  });

  test('the snapshot carries every counter, the store gauges, and the migration report', async () => {
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
    expect(body.migration.createdFresh).toBe(true);
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
    const h = makeHarness({ opsKey: 'ops-secret', retentionDays: 30 });
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));

    const before = await (await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'ops-secret' }))).json() as any;
    expect(before.store.retention_days).toBe(30);
    expect(before.store.max_rows_per_instance).toBe(30 + 31);
    expect(before.store.last_prune).toBeNull(); // nothing has run yet in this process

    h.db.recordHeartbeat('long-gone', 'brokkr', '2026-01-01', 1, '{}', '2026-01-01');
    expect(h.db.countHeartbeats('long-gone', 'brokkr')).toBe(1);
    h.db.pruneRetention('2026-07-09');
    // The receipt is checked against the STORE, not just against itself — a
    // report saying rows went while the rows stayed would be the worst of both.
    expect(h.db.countHeartbeats('long-gone', 'brokkr')).toBe(0);
    expect(h.db.getInstance('long-gone', 'brokkr')).toBeNull();

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
      // The flag records that the checkpoint RAN without error, not that bytes
      // were reclaimed — this harness is an in-memory store with no log to fold
      // back, and the pragma succeeds there with nothing to do.
      wal_truncated: true,
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
