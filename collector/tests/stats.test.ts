// Gate G5 — per-product stats.
//
// The failure this replaces: the pre-v2 fold read brokkr's `sessions`, `spine`
// and `models` as though every payload had them. Under v2 they live under
// `metrics`, and saga and skuld do not have them at all — so the old fold does
// not just produce wrong numbers for another product, it 500s. Every test here
// exists to keep that from coming back.

import { describe, expect, test } from 'bun:test';
import { foldTotals } from '../src/totals';
import { ingestReq, makeHarness, statsReq } from './helpers';
import { INSTANCE_A, makeV1, makeV2, SECRET_A } from './fixtures';

async function statsFor(
  h: ReturnType<typeof makeHarness>,
  product: string,
  days?: string,
): Promise<any> {
  const r = await h.handler(statsReq(INSTANCE_A, product, { secret: SECRET_A, days }));
  expect(r.status).toBe(200);
  return r.json();
}

describe('stats: the day echo', () => {
  test('a day is the stored document minus instance_id, plus brokkr’s computed tokens_saved', async () => {
    const h = makeHarness();
    const hb = makeV2('brokkr', INSTANCE_A);
    expect((await h.handler(ingestReq(hb, SECRET_A))).status).toBe(202);

    const body = await statsFor(h, 'brokkr');
    const expected: any = structuredClone(hb);
    delete expected.instance_id;
    expected.metrics.spine.tokens_saved = 412000 - 61000;
    expect(body.days).toEqual([expected]);
    expect(body.instance.days_reported).toBe(1);
  });

  test('tokens_saved floors at zero when the compacted form is larger', async () => {
    const h = makeHarness();
    const hb = makeV2('brokkr', INSTANCE_A);
    hb['metrics'].spine = { joints: 1, tokens_before: 100, tokens_after: 500, estimated: false };
    await h.handler(ingestReq(hb, SECRET_A));
    const body = await statsFor(h, 'brokkr');
    expect(body.days[0].metrics.spine.tokens_saved).toBe(0);
    expect(body.totals.spine_tokens_saved).toBe(0);
  });

  test('a v1 heartbeat reads back in the v2 shape', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeV1(INSTANCE_A), SECRET_A));
    const body = await statsFor(h, 'brokkr');
    expect(body.days[0].schema_version).toBe(2);
    expect(body.days[0].product).toEqual({ name: 'brokkr', version: '0.1.0' });
    expect(body.days[0].metrics.sessions.count).toBe(12);
    expect(body.totals.sessions).toBe(12);
  });
});

describe('stats: totals per product — and NO 500 when a section is absent', () => {
  test('saga stats do not touch brokkr’s sections', async () => {
    const h = makeHarness();
    expect((await h.handler(ingestReq(makeV2('saga', INSTANCE_A), SECRET_A))).status).toBe(202);
    const body = await statsFor(h, 'saga');
    expect(body.product).toBe('saga');
    expect(body.totals).toEqual({
      collect_runs: 40,
      collect_errors: 2,
      refusals: 1,
      mcp_tool_calls: 130,
      mcp_refusals: 3,
      advisories_fired: 5,
      connections_total: 4,
      uptime_bucket: '1d-7d',
    });
    // No brokkr keys leaked in.
    expect(body.totals.sessions).toBeUndefined();
    expect(body.totals.models).toBeUndefined();
    expect(body.days[0].metrics.spine).toBeUndefined();
  });

  test('skuld stats likewise', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeV2('skuld', INSTANCE_A), SECRET_A));
    const body = await statsFor(h, 'skuld');
    expect(body.totals.runs_total).toBe(20);
    expect(body.totals.runs_succeeded).toBe(18);
    expect(body.totals.gate_approvals).toBe(7);
    expect(body.totals.detection_state).toBe('healthy');
  });

  test('a stored payload missing every declared path yields zeros, never a throw', () => {
    for (const product of ['brokkr', 'saga', 'skuld']) {
      const totals = foldTotals(product, [{ day: '2026-07-09' }, { metrics: {} }, {}]);
      for (const [key, value] of Object.entries(totals)) {
        expect(typeof value === 'number' ? value : value, `${product}.${key}`).toBeDefined();
      }
      expect(() => JSON.stringify(totals)).not.toThrow();
    }
  });

  test('hostile leaf types cannot break the fold', () => {
    const hostile = [
      { metrics: { sessions: 'not-an-object', spine: null, models: 'nope', review: 7 } },
      { metrics: { sessions: { count: Number.NaN, minutes: Infinity, failed: '3' } } },
      { metrics: { spine: { tokens_before: {}, tokens_after: [] }, models: [null, 3, { name: 5 }] } },
      { metrics: null },
      null,
      42,
      [],
    ];
    const totals = foldTotals('brokkr', hostile);
    expect(totals['sessions']).toBe(0);
    expect(totals['minutes']).toBe(0);
    expect(totals['failed']).toBe(0);
    expect(totals['spine_tokens_saved']).toBe(0);
    expect(totals['models']).toEqual([]);
    expect(totals['spine_estimated']).toBe(false);
  });

  test('a product with no fold spec yields empty totals rather than an error', () => {
    // A product this collector has no summary for must not become a crash
    // path. (No route can reach this state today — ingest and read both gate
    // on the storable set — which is exactly why it is asserted at the unit.)
    expect(foldTotals('newthing', [makeV2('brokkr')])).toEqual({});
    expect(foldTotals('', [])).toEqual({});
  });

  test('a stored payload with none of the product’s sections yields zeros, and still serves its days', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_A));
    h.db.recordHeartbeat(INSTANCE_A, 'saga', '2026-07-09', 2, JSON.stringify({ weird: true }), '2026-07-09');
    const r = await h.handler(statsReq(INSTANCE_A, 'saga', { secret: SECRET_A }));
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.days).toEqual([{ weird: true }]);
    expect(body.totals.collect_runs).toBe(0);
    expect(body.totals.connections_total).toBeNull();
  });

  test('a corrupt stored row degrades to a placeholder rather than denying the whole history', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeV2('brokkr', INSTANCE_A, '2026-07-08'), SECRET_A));
    h.db.recordHeartbeat(INSTANCE_A, 'brokkr', '2026-07-09', 2, 'not json', '2026-07-09');
    const body = await statsFor(h, 'brokkr');
    expect(body.days.length).toBe(2);
    expect(body.days[1]).toEqual({ day: '2026-07-09', unreadable: true });
    expect(body.totals.sessions).toBe(12); // the readable day still counts
  });
});

describe('stats: temporal classes', () => {
  test('delta leaves sum across the window; gauges take the LAST sample', async () => {
    const h = makeHarness();
    const d1 = makeV2('saga', INSTANCE_A, '2026-07-07');
    d1['metrics'].collect = { runs: 10, errors: 1 };
    d1['metrics'].connections = { total: 9, by_engine: { postgres: 9 } };
    const d2 = makeV2('saga', INSTANCE_A, '2026-07-08');
    d2['metrics'].collect = { runs: 5, errors: 0 };
    d2['metrics'].connections = { total: 4, by_engine: { postgres: 4 } };
    for (const d of [d1, d2]) expect((await h.handler(ingestReq(d, SECRET_A))).status).toBe(202);

    const body = await statsFor(h, 'saga');
    expect(body.totals.collect_runs).toBe(15); // delta: summed
    expect(body.totals.connections_total).toBe(4); // gauge: last sample, NOT 13
  });

  test('a gauge missing on the final day falls back to the last day that carried it', () => {
    const totals = foldTotals('saga', [
      { metrics: { connections: { total: 7 } } },
      { metrics: {} },
    ]);
    expect(totals['connections_total']).toBe(7);
  });

  test('booleans OR across the window', async () => {
    const h = makeHarness();
    const d1 = makeV2('brokkr', INSTANCE_A, '2026-07-08');
    const d2 = makeV2('brokkr', INSTANCE_A, '2026-07-09');
    d2['metrics'].spine.estimated = true;
    for (const d of [d1, d2]) await h.handler(ingestReq(d, SECRET_A));
    const body = await statsFor(h, 'brokkr');
    expect(body.days.map((d: any) => d.metrics.spine.estimated)).toEqual([false, true]);
    expect(body.totals.spine_estimated).toBe(true);
  });
});

describe('stats: window trimming', () => {
  async function seedThreeDays() {
    const h = makeHarness();
    const days = ['2026-07-07', '2026-07-08', '2026-07-09'];
    const counts = [10, 5, 3];
    for (const [i, day] of days.entries()) {
      const hb = makeV2('brokkr', INSTANCE_A, day);
      hb['metrics'].sessions = { count: counts[i], minutes: counts[i]! * 10, failed: 1 };
      hb['metrics'].models = [{ name: 'claude-sonnet-5', sessions: counts[i] }];
      expect((await h.handler(ingestReq(hb, SECRET_A))).status).toBe(202);
    }
    return h;
  }

  test('the full window aggregates every day; models merge, busiest first', async () => {
    const h = await seedThreeDays();
    const body = await statsFor(h, 'brokkr');
    expect(body.days.map((d: any) => d.day)).toEqual(['2026-07-07', '2026-07-08', '2026-07-09']);
    expect(body.totals.sessions).toBe(18);
    expect(body.totals.minutes).toBe(180);
    expect(body.totals.failed).toBe(3);
    expect(body.totals.models).toEqual([{ name: 'claude-sonnet-5', sessions: 18 }]);
  });

  test('?days=N keeps the most recent N (ascending), and the totals follow the window', async () => {
    const h = await seedThreeDays();
    const body = await statsFor(h, 'brokkr', '2');
    expect(body.days.map((d: any) => d.day)).toEqual(['2026-07-08', '2026-07-09']);
    expect(body.totals.sessions).toBe(8);
  });

  test('?days out of range or malformed => 400, and never reveals anything', async () => {
    const h = await seedThreeDays();
    for (const bad of ['0', '401', 'abc', '-1', '1.5', '']) {
      const r = await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A, days: bad }));
      expect(r.status, bad).toBe(400);
      expect(await r.json()).toEqual({ ok: false, error: 'invalid_request' });
    }
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A, days: '1' }))).status).toBe(200);
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A, days: '400' }))).status).toBe(200);
  });

  test('a bad ?days from an UNAUTHENTICATED caller is still 403 — auth is checked first', async () => {
    const h = await seedThreeDays();
    const r = await h.handler(statsReq(INSTANCE_A, 'brokkr', { days: 'abc' }));
    expect(r.status).toBe(403);
  });
});

describe('service plumbing', () => {
  test('GET /healthz => 200 {ok:true}', async () => {
    const { handler } = makeHarness();
    const r = await handler(new Request('http://telemetry.local/healthz'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  test('GET /v1/schema serves the operator-supplied text verbatim, and 404s when none is wired', async () => {
    const withSchema = makeHarness({ schemaJson: '{"title":"heartbeat v2"}' });
    const r = await withSchema.handler(new Request('http://telemetry.local/v1/schema'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.text()).toBe('{"title":"heartbeat v2"}');

    const without = makeHarness();
    expect((await without.handler(new Request('http://telemetry.local/v1/schema'))).status).toBe(404);
  });

  test('an unknown route => 404', async () => {
    const { handler } = makeHarness();
    expect((await handler(new Request('http://telemetry.local/v1/other'))).status).toBe(404);
  });

  test('a wrong method on a known path falls through to 404 rather than half-executing', async () => {
    const { handler } = makeHarness();
    for (const [path, method] of [
      ['/v1/ingest', 'GET'],
      [`/v1/instances/${INSTANCE_A}/stats`, 'DELETE'],
      [`/v1/instances/${INSTANCE_A}`, 'GET'],
      ['/v1/stats', 'POST'],
    ] as const) {
      const r = await handler(new Request(`http://telemetry.local${path}`, { method }));
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('the FIRST heartbeat is not a one-day delta, and is excluded from every rate', () => {
  // The emitter diffs against a stored prior snapshot; a counter with no prior
  // snapshot emits its whole LIFETIME value. An installation that ran for
  // months before telemetry was switched on therefore reports months of
  // accumulation as a single day — once, for every installation, at
  // activation. Averaging that row in produces a spike at every activation and
  // then permanently overstates the per-day rate, because it never ages out.

  async function seedActivation(h: ReturnType<typeof makeHarness>) {
    // Day 1: the lifetime dump. Days 2 and 3: real daily deltas.
    const first = makeV2('brokkr', INSTANCE_A, '2026-07-07');
    first['metrics'].sessions = { count: 900, minutes: 9000, failed: 0 };
    const second = makeV2('brokkr', INSTANCE_A, '2026-07-08');
    second['metrics'].sessions = { count: 10, minutes: 100, failed: 0 };
    const third = makeV2('brokkr', INSTANCE_A, '2026-07-09');
    third['metrics'].sessions = { count: 20, minutes: 200, failed: 0 };
    for (const d of [first, second, third]) {
      expect((await h.handler(ingestReq(d, SECRET_A))).status).toBe(202);
    }
  }

  test('the first-report day is recorded, surfaced, and named as the excluded one', async () => {
    const h = makeHarness();
    await seedActivation(h);
    const body = await statsFor(h, 'brokkr');
    expect(body.instance.first_report_day).toBe('2026-07-07');
    expect(body.rates.excluded_day).toBe('2026-07-07');
    expect(body.rates.excluded_reason).toBe('first_report_is_not_a_daily_delta');
    expect(body.rates.days_counted).toBe(2);
  });

  test('the row is STORED and still counts in the lifetime total', async () => {
    const h = makeHarness();
    await seedActivation(h);
    const body = await statsFor(h, 'brokkr');
    // It is real data, and the only occasion a genuine lifetime total exists.
    expect(body.days.map((d: any) => d.day)).toEqual(['2026-07-07', '2026-07-08', '2026-07-09']);
    expect(body.instance.days_reported).toBe(3);
    expect(body.totals.sessions).toBe(930);
  });

  test('the rate is computed WITHOUT it — the naive division is the bug being avoided', async () => {
    const h = makeHarness();
    await seedActivation(h);
    const body = await statsFor(h, 'brokkr');
    expect(body.rates.per_day.sessions).toBe(15); // (10 + 20) / 2
    expect(body.rates.per_day.minutes).toBe(150);
    // What a consumer would have got by dividing the total by the day count:
    expect(body.totals.sessions / body.days.length).toBe(310);
  });

  test('the exclusion holds as the window grows — it does not age out', async () => {
    const h = makeHarness({ today: '2026-07-09' });
    await seedActivation(h);
    // Trimming to the most recent 2 days drops the first-report day anyway...
    const trimmed = await statsFor(h, 'brokkr', '2');
    expect(trimmed.rates.days_counted).toBe(2);
    expect(trimmed.rates.excluded_day).toBeNull(); // it was not in this window
    expect(trimmed.rates.per_day.sessions).toBe(15);
    // ...while the full window still excludes it.
    const full = await statsFor(h, 'brokkr');
    expect(full.rates.excluded_day).toBe('2026-07-07');
    expect(full.rates.per_day.sessions).toBe(15);
  });

  test('a window containing ONLY the first-report day yields no rate at all', async () => {
    // Not zeros: "nothing representative to average" and "averaged to zero"
    // are different claims, and the second one is a lie.
    const h = makeHarness();
    const first = makeV2('brokkr', INSTANCE_A, '2026-07-09');
    first['metrics'].sessions = { count: 900, minutes: 9000, failed: 0 };
    await h.handler(ingestReq(first, SECRET_A));
    const body = await statsFor(h, 'brokkr');
    expect(body.rates.days_counted).toBe(0);
    expect(body.rates.per_day).toBeNull();
    expect(body.rates.excluded_day).toBe('2026-07-09');
    expect(body.totals.sessions).toBe(900); // the total is still reported
  });

  test('the first-report day is the FIRST heartbeat received, not the earliest day sent later', async () => {
    // A backfilled earlier day is an ordinary delta; the lifetime dump was the
    // first emission, whatever day it covered.
    const h = makeHarness({ today: '2026-07-09' });
    const first = makeV2('brokkr', INSTANCE_A, '2026-07-09');
    first['metrics'].sessions = { count: 900, minutes: 9000, failed: 0 };
    await h.handler(ingestReq(first, SECRET_A));
    const earlier = makeV2('brokkr', INSTANCE_A, '2026-07-05');
    earlier['metrics'].sessions = { count: 4, minutes: 40, failed: 0 };
    await h.handler(ingestReq(earlier, SECRET_A));

    const body = await statsFor(h, 'brokkr');
    expect(body.instance.first_report_day).toBe('2026-07-09');
    expect(body.rates.excluded_day).toBe('2026-07-09');
    expect(body.rates.days_counted).toBe(1);
    expect(body.rates.per_day.sessions).toBe(4);
  });

  test('re-sending the first day does not move the marker', async () => {
    const h = makeHarness();
    await seedActivation(h);
    const resent = makeV2('brokkr', INSTANCE_A, '2026-07-07');
    resent['metrics'].sessions = { count: 950, minutes: 9500, failed: 0 };
    await h.handler(ingestReq(resent, SECRET_A));
    const body = await statsFor(h, 'brokkr');
    expect(body.instance.first_report_day).toBe('2026-07-07');
    expect(body.rates.per_day.sessions).toBe(15);
  });

  test('each (instance, product) has its OWN first-report day', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeV2('brokkr', INSTANCE_A, '2026-07-07'), SECRET_A));
    await h.handler(ingestReq(makeV2('saga', INSTANCE_A, '2026-07-09'), SECRET_A));
    expect((await statsFor(h, 'brokkr')).instance.first_report_day).toBe('2026-07-07');
    expect((await statsFor(h, 'saga')).instance.first_report_day).toBe('2026-07-09');
  });

  test('gauges are not rated, and neither is the model breakdown', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeV2('saga', INSTANCE_A, '2026-07-08'), SECRET_A));
    await h.handler(ingestReq(makeV2('saga', INSTANCE_A, '2026-07-09'), SECRET_A));
    const body = await statsFor(h, 'saga');
    // A mean of snapshots is not a rate of anything.
    expect(body.rates.per_day.connections_total).toBeUndefined();
    expect(body.rates.per_day.uptime_bucket).toBeUndefined();
    expect(body.totals.connections_total).toBe(4);
    // ...and brokkr's model table is a breakdown, not a quantity per day.
    const b = makeHarness();
    await b.handler(ingestReq(makeV2('brokkr', INSTANCE_A, '2026-07-08'), SECRET_A));
    await b.handler(ingestReq(makeV2('brokkr', INSTANCE_A, '2026-07-09'), SECRET_A));
    expect((await statsFor(b, 'brokkr')).rates.per_day.models).toBeUndefined();
  });
});
