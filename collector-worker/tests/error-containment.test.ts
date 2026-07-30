// Does a store failure stay INSIDE this service?
//
// `src/server.ts` wraps its whole router in a catch-all whose comment states
// the intent exactly:
//
//     } catch {
//       // Never leak internals, and never log bodies or addresses.
//       counters.inc('internal_error');
//       return json(500, { ok: false, error: 'internal' });
//     }
//
// Three things are promised there: the caller gets the same coarse shape every
// other refusal uses, the operator gets a counter, and nothing internal
// escapes. This file tests that promise per route, by making the store throw.
//
// It has no counterpart in `collector/tests/` — the property is untested there
// too. It was written during the route port because the port is what made the
// gap reachable, and it is the file that found the defect recorded below.
//
// ─────────────────────────────────────────────────────────────────────────
//  KNOWN DEFECT — THREE ROUTES ARE NOT COVERED BY THAT CATCH
//
//  The router returns the per-route handlers WITHOUT awaiting them:
//
//      if (path === '/v1/ingest' && req.method === 'POST') return handleIngest(req, server);
//      if (statsMatch    && req.method === 'GET')    return handleStats(...);
//      if (instanceMatch && req.method === 'DELETE') return handleDelete(...);
//
//  In an async function, `return p` COMPLETES the try block; the promise is
//  settled afterwards, outside it. So a rejection from any of those three
//  never reaches the catch. `return await p` would be caught; `return p` is
//  not.
//
//  In the REFERENCE collector `handleStats` and `handleDelete` are ordinary
//  SYNCHRONOUS functions, so their throws are synchronous throws inside the
//  try and ARE caught — measured. This port made both of them `async` (D1 has
//  no synchronous read), and that colour change silently moved them out of
//  the catch's reach. It is a port-introduced regression on those two routes.
//  `/v1/ingest` has the same gap in BOTH collectors and is therefore not a
//  regression — but it is the route most likely to trip it here, because
//  `TelemetryD1.recordHeartbeat` deliberately THROWS on two conditions it
//  treats as impossible, and both of them are "`meta.changes` was not what I
//  expected" — a value `db.ts`'s own helper says D1 "may omit".
//
//  What it costs on the deployment, none of which is theoretical:
//    • the caller gets Cloudflare's own exception response instead of
//      `500 {"ok":false,"error":"internal"}`, so the wire answer for an
//      internal failure is no longer one of this service's shapes;
//    • `internal_error` never increments, so /metrics — the only place an
//      operator watches for this — reports zero while the route is failing;
//    • the throw is reported to Workers observability WITH ITS MESSAGE, and
//      `recordHeartbeat`'s message is built from the request:
//      `…(product=${product}, day=${day})`. That is per-request metadata
//      leaving the service through the one path the catch exists to close.
//
//  The fix is `return await` in three places. It is NOT applied here: this
//  branch ports tests, the Worker is deployed and serving, and a route-layer
//  change belongs in its own commit against both collectors together (see
//  ../../docs/TWO-COLLECTORS.md). The three tests below are written as they
//  SHOULD pass and are skipped, so they name the defect on every run and
//  become its regression test the moment the `await`s land.
// ─────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from 'bun:test';
import { deleteReq, getReq, ingestReq, makeHarness, statsReq } from './helpers';
import { INSTANCE_A, makeHeartbeat, SECRET_A } from '../../collector/tests/fixtures';

/** A store failure carrying a detail that must never reach a caller or a log. */
const BOOM = 'BOOM /srv/data/telemetry.db instance=leaky';

/** Replace one store method with one that rejects. */
function breakStore(h: ReturnType<typeof makeHarness>, method: string): void {
  (h.db as unknown as Record<string, unknown>)[method] = async () => {
    throw new Error(BOOM);
  };
}

async function expectContained(h: ReturnType<typeof makeHarness>, res: Response): Promise<void> {
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ ok: false, error: 'internal' });
  expect(text).not.toContain('BOOM');
  expect(text).not.toContain('telemetry.db');
  expect(h.counters.get('internal_error')).toBe(1);
}

describe('a failing store is contained: coarse 500, counted, nothing internal on the wire', () => {
  test('the public aggregate — GET /v1/stats', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    breakStore(h, 'aggregates');
    await expectContained(h, await h.handler(getReq('/v1/stats')));
  });

  test('the give-back page — GET /', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    breakStore(h, 'aggregates');
    await expectContained(h, await h.handler(getReq('/')));
  });

  test('the operator surface — GET /metrics', async () => {
    const h = makeHarness({ opsKey: 'ops-secret' });
    breakStore(h, 'countInstances');
    await expectContained(h, await h.handler(getReq('/metrics', { 'x-mythical-ops-key': 'ops-secret' })));
  });

  test('a failed aggregate is not recorded as a SERVED one', async () => {
    // The counter ordering the route layer is explicit about: `read_aggregate_ok`
    // is incremented only after the snapshot is in hand.
    const h = makeHarness({ minAggregateCell: 1 });
    breakStore(h, 'aggregates');
    await h.handler(getReq('/v1/stats'));
    expect(h.counters.get('read_aggregate_ok')).toBe(0);
  });
});

describe('KNOWN DEFECT — routes whose failures escape the catch (see this file’s header)', () => {
  test.skip('POST /v1/ingest — FAILS TODAY: `return handleIngest(...)` is not awaited, so the rejection escapes', async () => {
    const h = makeHarness();
    breakStore(h, 'recordHeartbeat');
    await expectContained(h, await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A)));
  });

  test.skip('GET /v1/instances/:uuid/stats — FAILS TODAY: `return handleStats(...)` is not awaited (REGRESSION: caught in the reference)', async () => {
    const h = makeHarness();
    breakStore(h, 'getInstance');
    await expectContained(h, await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A })));
  });

  test.skip('DELETE /v1/instances/:uuid — FAILS TODAY: `return handleDelete(...)` is not awaited (REGRESSION: caught in the reference)', async () => {
    const h = makeHarness();
    breakStore(h, 'deleteInstance');
    await expectContained(h, await h.handler(deleteReq(INSTANCE_A, SECRET_A)));
  });

  // The defect is asserted POSITIVELY here, so this file proves the claim it
  // makes rather than only describing it. If someone lands the three `await`s,
  // this test starts failing and the three above start passing — which is the
  // signal to delete this one and un-skip those.
  test('the three routes above currently REJECT instead of answering 500 — this is the defect, pinned', async () => {
    const cases: Array<[string, string, () => Request]> = [
      ['ingest', 'recordHeartbeat', () => ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A)],
      ['stats', 'getInstance', () => statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A })],
      ['delete', 'deleteInstance', () => deleteReq(INSTANCE_A, SECRET_A)],
    ];
    for (const [label, method, mk] of cases) {
      const h = makeHarness();
      breakStore(h, method);
      let rejected = false;
      try {
        await h.handler(mk());
      } catch (err) {
        rejected = true;
        // ...and the message that escapes is the internal one.
        expect(err instanceof Error ? err.message : String(err), label).toContain('BOOM');
      }
      expect(rejected, `${label} should currently reject (it does not, so the defect is fixed)`).toBe(true);
      expect(h.counters.get('internal_error'), label).toBe(0);
    }
  });
});
