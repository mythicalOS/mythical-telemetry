// Gate G6 — reads became authenticated, and the per-install page was removed.
//
// The property under test is a NEGATIVE one: there must be no route anywhere
// on this service that returns one installation's data to a caller holding
// only its id. These tests try the obvious ways around it.

import { describe, expect, test } from 'bun:test';
import { deleteReq, getReq, ingestReq, makeHarness, statsReq } from './helpers';
import { INSTANCE_A, INSTANCE_B, INSTANCE_C, makeHeartbeat, SECRET_A, SECRET_B, SECRET_C } from './fixtures';

async function seed(h: ReturnType<typeof makeHarness>): Promise<void> {
  expect((await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);
}

describe('the instance id is no longer a bearer read capability', () => {
  test('stats WITHOUT a secret => 403, even for an id that exists', async () => {
    const h = makeHarness();
    await seed(h);
    const r = await h.handler(statsReq(INSTANCE_A, 'brokkr'));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  test('stats with SOMEONE ELSE’s secret => 403', async () => {
    const h = makeHarness();
    await seed(h);
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_B }))).status).toBe(403);
  });

  test('stats with the owning secret => 200', async () => {
    const h = makeHarness();
    await seed(h);
    const r = await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A }));
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.instance.id).toBe(INSTANCE_A);
    expect(body.product).toBe('brokkr');
    expect(body.contract_version).toBe(2);
  });

  test('the historical header name authorizes a read too', async () => {
    const h = makeHarness();
    await seed(h);
    const req = new Request(`http://telemetry.local/api/v1/instances/${INSTANCE_A}/stats?product=brokkr`, {
      headers: { 'x-mythical-write-key': SECRET_A },
    });
    expect((await h.handler(req)).status).toBe(200);
  });

  test('presenting the id itself as the secret does not authorize', async () => {
    const h = makeHarness();
    await seed(h);
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: INSTANCE_A }))).status).toBe(403);
  });

  test('an unauthenticated caller cannot tell an existing id from a never-seen one', async () => {
    const h = makeHarness();
    await seed(h);
    const known = await h.handler(statsReq(INSTANCE_A, 'brokkr'));
    const unknown = await h.handler(statsReq(INSTANCE_B, 'brokkr'));
    const malformed = await h.handler(statsReq('not-a-uuid', 'brokkr'));
    expect([known.status, unknown.status, malformed.status]).toEqual([403, 403, 403]);
    const bodies = await Promise.all([known.json(), unknown.json(), malformed.json()]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  test('an authenticated owner with no data gets 404 — the only place existence is revealed', async () => {
    const h = makeHarness();
    await seed(h);
    const r = await h.handler(statsReq(INSTANCE_C, 'brokkr', { secret: SECRET_C }));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ ok: false, error: 'unknown_instance' });
  });

  test('authorization does not cross products: the secret proves the id, the query names the partition', async () => {
    const h = makeHarness();
    await seed(h);
    // The owner asking for a product they never reported gets 404, not
    // another installation's data.
    const r = await h.handler(statsReq(INSTANCE_A, 'saga', { secret: SECRET_A }));
    expect(r.status).toBe(404);
  });

  test('an absent or unknown product parameter is refused before any lookup', async () => {
    const h = makeHarness();
    await seed(h);
    expect((await h.handler(statsReq(INSTANCE_A, undefined, { secret: SECRET_A }))).status).toBe(403);
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr; DROP', { secret: SECRET_A }))).status).toBe(403);
    expect((await h.handler(statsReq(INSTANCE_A, '', { secret: SECRET_A }))).status).toBe(403);
  });

  test('no CORS header rides an authenticated read', async () => {
    // The previous collector put `Access-Control-Allow-Origin: *` on this
    // route while the id was a bearer capability. Now that the route is
    // credentialed, a wildcard would be the wrong shape entirely.
    const h = makeHarness();
    await seed(h);
    const r = await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A }));
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the per-install page is GONE, not merely unlinked', () => {
  test('GET /i/<uuid> is a plain 404 for a real, populated id', async () => {
    const h = makeHarness();
    await seed(h);
    const r = await h.handler(getReq(`/i/${INSTANCE_A}`));
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({ ok: false, error: 'not_found' });
  });

  test('neither does any adjacent spelling of it exist', async () => {
    const h = makeHarness();
    await seed(h);
    for (const path of [
      `/i/${INSTANCE_A}/`,
      `/instances/${INSTANCE_A}`,
      `/api/v1/instances/${INSTANCE_A}`,
      `/api/v1/instances/${INSTANCE_A}/page`,
      `/api/v1/stats/${INSTANCE_A}`,
    ]) {
      const r = await h.handler(getReq(path));
      const text = await r.text();
      expect(r.status, path).toBe(404);
      expect(text, path).not.toContain(INSTANCE_A);
    }
  });

  test('the aggregate route ignores an instance query parameter rather than honouring it', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h);
    const withParam = await h.handler(getReq(`/api/v1/stats?instance=${INSTANCE_A}`));
    const without = await h.handler(getReq('/api/v1/stats'));
    expect(withParam.status).toBe(200);
    const text = await withParam.text();
    expect(text).not.toContain(INSTANCE_A);
    expect(text).toBe(await without.text());
  });

  test('the public aggregate never names an installation', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h);
    for (const path of ['/', '/api/v1/stats']) {
      const text = await (await h.handler(getReq(path))).text();
      expect(text, path).not.toContain(INSTANCE_A);
    }
  });
});

describe('DELETE — authenticated, idempotent, no existence oracle', () => {
  test('a malformed uuid answers exactly like a wrong secret', async () => {
    const h = makeHarness();
    const malformed = await h.handler(deleteReq('not-a-uuid', SECRET_A));
    const wrong = await h.handler(deleteReq(INSTANCE_A, SECRET_B));
    expect(malformed.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(await malformed.json()).toEqual(await wrong.json());
  });

  test('a wrong or absent secret => 403; known and never-seen ids look identical', async () => {
    const h = makeHarness();
    await seed(h);
    expect((await h.handler(deleteReq(INSTANCE_A, SECRET_B))).status).toBe(403);
    expect((await h.handler(deleteReq(INSTANCE_B, SECRET_A))).status).toBe(403);
    expect((await h.handler(deleteReq(INSTANCE_A))).status).toBe(403);
    // The failed attempts touched nothing.
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A }))).status).toBe(200);
  });

  test('the owner purges => 204 with no body; the read then 404s', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-08'), SECRET_A));
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-09'), SECRET_A));
    const r = await h.handler(deleteReq(INSTANCE_A, SECRET_A));
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A }))).status).toBe(404);
  });

  test('the purge spans EVERY product for that identity', async () => {
    const h = makeHarness();
    for (const product of ['brokkr', 'saga', 'skuld'] as const) {
      await h.handler(ingestReq(makeHeartbeat(product, INSTANCE_A), SECRET_A));
    }
    expect((await h.handler(deleteReq(INSTANCE_A, SECRET_A))).status).toBe(204);
    for (const product of ['brokkr', 'saga', 'skuld'] as const) {
      expect(h.db.countHeartbeats(INSTANCE_A, product)).toBe(0);
      expect(h.db.getInstance(INSTANCE_A, product)).toBeNull();
    }
    expect(h.db.countInstances()).toBe(0);
  });

  test('idempotent: 204 for a never-seen id with its owning secret, and again after a purge', async () => {
    const h = makeHarness();
    expect((await h.handler(deleteReq(INSTANCE_C, SECRET_C))).status).toBe(204);
    await seed(h);
    expect((await h.handler(deleteReq(INSTANCE_A, SECRET_A))).status).toBe(204);
    expect((await h.handler(deleteReq(INSTANCE_A, SECRET_A))).status).toBe(204);
  });

  test('the purge is scoped: deleting A leaves B intact', async () => {
    const h = makeHarness();
    await seed(h);
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B, '2026-07-08'), SECRET_B));
    await h.handler(deleteReq(INSTANCE_A, SECRET_A));
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A }))).status).toBe(404);
    expect((await h.handler(statsReq(INSTANCE_B, 'brokkr', { secret: SECRET_B }))).status).toBe(200);
  });
});
