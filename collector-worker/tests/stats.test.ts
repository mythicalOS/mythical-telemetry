// `collector/tests/stats.test.ts`, ported to the Worker's route layer.
//
// Per-product stats.
//
// The failure this replaces: an earlier fold read brokkr's `sessions`, `spine`
// and `models` as though every payload had them. They live under `metrics`,
// and saga and skuld do not have them at all — so the old fold does
// not just produce wrong numbers for another product, it 500s. Every test here
// exists to keep that from coming back.
//
// Mechanical transform only — store calls gained an `await`, and
// `DEFAULT_RETENTION_DAYS` comes from the D1 store. No assertion was relaxed.
// What a green run here does and does not prove: see `helpers.ts`.
//
// ── WHAT WAS NOT PORTED, AND WHY ───────────────────────────────────────────
//
// The original interleaves route tests with UNIT tests of `foldTotals` /
// `foldRates`, called directly with hand-built day lists and never touching a
// route: the whole `accumulated figures stay representable` block, and inside
// the other blocks `a stored payload missing every declared path yields zeros`,
// `hostile leaf types cannot break the fold`, `a product with no fold spec`,
// and `a gauge missing on the final day`.
//
// Those exercise `collector/src/totals.ts`, which this Worker imports BY
// REFERENCE — it is the same module object, not a copy (see
// `../../docs/TWO-COLLECTORS.md` → "What is actually shared"). Re-running them
// here would assert the same function twice and would go green for reasons
// that have nothing to do with this deployment. They stay where the module
// they test lives. Everything that reaches `totals.ts` THROUGH a route is
// ported, because that path is the Worker's own and is duplicated code.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_RETENTION_DAYS } from '../src/db';
import { ingestReq, makeHarness, statsReq } from './helpers';
import { INSTANCE_A, makeHeartbeat, SECRET_A } from '../../collector/tests/fixtures';

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
    const hb = makeHeartbeat('brokkr', INSTANCE_A);
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
    const hb = makeHeartbeat('brokkr', INSTANCE_A);
    hb['metrics'].spine = { joints: 1, tokens_before: 100, tokens_after: 500, estimated: false };
    await h.handler(ingestReq(hb, SECRET_A));
    const body = await statsFor(h, 'brokkr');
    expect(body.days[0].metrics.spine.tokens_saved).toBe(0);
    expect(body.totals.spine_tokens_saved).toBe(0);
  });

  test('a stored day reads back byte-for-byte as it was accepted', async () => {
    // No normalization exists on either side of the store, so the read path
    // must hand back exactly what the validator accepted (minus instance_id,
    // plus brokkr's computed tokens_saved).
    const h = makeHarness();
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    const body = await statsFor(h, 'brokkr');
    expect(body.days[0].schema_version).toBe(1);
    expect(body.days[0].product).toEqual({ name: 'brokkr', version: '0.1.0' });
    expect(body.days[0].metrics.sessions.count).toBe(12);
    expect(body.totals.sessions).toBe(12);
  });
});

describe('stats: totals per product — and NO 500 when a section is absent', () => {
  test('saga stats do not touch brokkr’s sections', async () => {
    const h = makeHarness();
    expect((await h.handler(ingestReq(makeHeartbeat('saga', INSTANCE_A), SECRET_A))).status).toBe(202);
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
    await h.handler(ingestReq(makeHeartbeat('skuld', INSTANCE_A), SECRET_A));
    const body = await statsFor(h, 'skuld');
    expect(body.totals.runs_total).toBe(20);
    expect(body.totals.runs_succeeded).toBe(18);
    expect(body.totals.gate_approvals).toBe(7);
    expect(body.totals.detection_state).toBe('healthy');
  });

  test('a stored payload with none of the product’s sections yields zeros, and still serves its days', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    await h.db.recordHeartbeat(INSTANCE_A, 'saga', '2026-07-09', 2, JSON.stringify({ weird: true }), '2026-07-09');
    const r = await h.handler(statsReq(INSTANCE_A, 'saga', { secret: SECRET_A }));
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.days).toEqual([{ weird: true }]);
    expect(body.totals.collect_runs).toBe(0);
    expect(body.totals.connections_total).toBeNull();
  });

  test('a corrupt stored row degrades to a placeholder rather than denying the whole history', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-08'), SECRET_A));
    await h.db.recordHeartbeat(INSTANCE_A, 'brokkr', '2026-07-09', 2, 'not json', '2026-07-09');
    const body = await statsFor(h, 'brokkr');
    expect(body.days.length).toBe(2);
    expect(body.days[1]).toEqual({ day: '2026-07-09', unreadable: true });
    expect(body.totals.sessions).toBe(12); // the readable day still counts
  });
});

describe('stats: temporal classes', () => {
  test('delta leaves sum across the window; gauges take the LAST sample', async () => {
    const h = makeHarness();
    const d1 = makeHeartbeat('saga', INSTANCE_A, '2026-07-07');
    d1['metrics'].collect = { runs: 10, errors: 1 };
    d1['metrics'].connections = { total: 9, by_engine: { postgres: 9 } };
    const d2 = makeHeartbeat('saga', INSTANCE_A, '2026-07-08');
    d2['metrics'].collect = { runs: 5, errors: 0 };
    d2['metrics'].connections = { total: 4, by_engine: { postgres: 4 } };
    for (const d of [d1, d2]) expect((await h.handler(ingestReq(d, SECRET_A))).status).toBe(202);

    const body = await statsFor(h, 'saga');
    expect(body.totals.collect_runs).toBe(15); // delta: summed
    expect(body.totals.connections_total).toBe(4); // gauge: last sample, NOT 13
  });

  test('booleans OR across the window', async () => {
    const h = makeHarness();
    const d1 = makeHeartbeat('brokkr', INSTANCE_A, '2026-07-08');
    const d2 = makeHeartbeat('brokkr', INSTANCE_A, '2026-07-09');
    d2['metrics'].spine.estimated = true;
    for (const d of [d1, d2]) await h.handler(ingestReq(d, SECRET_A));
    const body = await statsFor(h, 'brokkr');
    expect(body.days.map((d: any) => d.metrics.spine.estimated)).toEqual([false, true]);
    expect(body.totals.spine_estimated).toBe(true);
  });
});

describe('stats: window trimming', () => {
  async function seedThreeDays(opts?: Parameters<typeof makeHarness>[0]) {
    const h = makeHarness(opts);
    const days = ['2026-07-07', '2026-07-08', '2026-07-09'];
    const counts = [10, 5, 3];
    for (const [i, day] of days.entries()) {
      const hb = makeHeartbeat('brokkr', INSTANCE_A, day);
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
    // The upper bound is the CONFIGURED retention, not a literal: a caller may
    // ask for exactly the window we keep and no more. Deriving both edges from
    // DEFAULT_RETENTION_DAYS means changing the retention cannot leave this
    // test asserting a boundary the service no longer has — which is precisely
    // what happened when retention moved from 400 to 90 and this line still
    // said 400.
    const overRetention = String(DEFAULT_RETENTION_DAYS + 1);
    for (const bad of ['0', overRetention, 'abc', '-1', '1.5', '']) {
      const r = await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A, days: bad }));
      expect(r.status, bad).toBe(400);
      expect(await r.json()).toEqual({ ok: false, error: 'invalid_request' });
    }
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A, days: '1' }))).status).toBe(200);
    expect(
      (await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A, days: String(DEFAULT_RETENTION_DAYS) })))
        .status,
    ).toBe(200);
  });

  test('the days cap TRACKS retention rather than a hardcoded number', async () => {
    // A collector configured with a shorter retention must refuse a longer
    // window. Without this, the cap and the retention are two independent
    // literals and nothing notices when they disagree.
    const h = await seedThreeDays({ retentionDays: 7 });
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A, days: '7' }))).status).toBe(200);
    expect((await h.handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A, days: '8' }))).status).toBe(400);
  });

  test('a bad ?days from an UNAUTHENTICATED caller is still 403 — auth is checked first', async () => {
    const h = await seedThreeDays();
    const r = await h.handler(statsReq(INSTANCE_A, 'brokkr', { days: 'abc' }));
    expect(r.status).toBe(403);
  });
});

describe('service plumbing', () => {
  test('GET /health => 200 C5 liveness triple {ok, version, uptime_s}', async () => {
    const { handler } = makeHarness();
    const r = await handler(new Request('http://telemetry.local/health'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime_s).toBe('number');
    // Liveness and nothing else — no roster, counts, pid or configuration.
    expect(Object.keys(body).sort()).toEqual(['ok', 'uptime_s', 'version']);
  });

  test('GET /api/v1/schema serves the operator-supplied text verbatim, and 404s when none is wired', async () => {
    const withSchema = makeHarness({ schemaJson: '{"title":"heartbeat v1"}' });
    const r = await withSchema.handler(new Request('http://telemetry.local/api/v1/schema'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.text()).toBe('{"title":"heartbeat v1"}');

    const without = makeHarness();
    expect((await without.handler(new Request('http://telemetry.local/api/v1/schema'))).status).toBe(404);
  });

  test('an unknown route => 404', async () => {
    const { handler } = makeHarness();
    expect((await handler(new Request('http://telemetry.local/api/v1/other'))).status).toBe(404);
  });

  test('a wrong method on a known path falls through to 404 rather than half-executing', async () => {
    const { handler } = makeHarness();
    for (const [path, method] of [
      ['/api/v1/ingest', 'GET'],
      [`/api/v1/instances/${INSTANCE_A}/stats`, 'DELETE'],
      [`/api/v1/instances/${INSTANCE_A}`, 'GET'],
      ['/api/v1/stats', 'POST'],
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
    const first = makeHeartbeat('brokkr', INSTANCE_A, '2026-07-07');
    first['metrics'].sessions = { count: 900, minutes: 9000, failed: 0 };
    const second = makeHeartbeat('brokkr', INSTANCE_A, '2026-07-08');
    second['metrics'].sessions = { count: 10, minutes: 100, failed: 0 };
    const third = makeHeartbeat('brokkr', INSTANCE_A, '2026-07-09');
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
    const first = makeHeartbeat('brokkr', INSTANCE_A, '2026-07-09');
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
    const first = makeHeartbeat('brokkr', INSTANCE_A, '2026-07-09');
    first['metrics'].sessions = { count: 900, minutes: 9000, failed: 0 };
    await h.handler(ingestReq(first, SECRET_A));
    const earlier = makeHeartbeat('brokkr', INSTANCE_A, '2026-07-05');
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
    const resent = makeHeartbeat('brokkr', INSTANCE_A, '2026-07-07');
    resent['metrics'].sessions = { count: 950, minutes: 9500, failed: 0 };
    await h.handler(ingestReq(resent, SECRET_A));
    const body = await statsFor(h, 'brokkr');
    expect(body.instance.first_report_day).toBe('2026-07-07');
    expect(body.rates.per_day.sessions).toBe(15);
  });

  test('each (instance, product) has its OWN first-report day', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-07'), SECRET_A));
    await h.handler(ingestReq(makeHeartbeat('saga', INSTANCE_A, '2026-07-09'), SECRET_A));
    expect((await statsFor(h, 'brokkr')).instance.first_report_day).toBe('2026-07-07');
    expect((await statsFor(h, 'saga')).instance.first_report_day).toBe('2026-07-09');
  });

  test('gauges are not rated, and neither is the model breakdown', async () => {
    const h = makeHarness();
    await h.handler(ingestReq(makeHeartbeat('saga', INSTANCE_A, '2026-07-08'), SECRET_A));
    await h.handler(ingestReq(makeHeartbeat('saga', INSTANCE_A, '2026-07-09'), SECRET_A));
    const body = await statsFor(h, 'saga');
    // A mean of snapshots is not a rate of anything.
    expect(body.rates.per_day.connections_total).toBeUndefined();
    expect(body.rates.per_day.uptime_bucket).toBeUndefined();
    expect(body.totals.connections_total).toBe(4);
    // ...and brokkr's model table is a breakdown, not a quantity per day.
    const b = makeHarness();
    await b.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-08'), SECRET_A));
    await b.handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-07-09'), SECRET_A));
    expect((await statsFor(b, 'brokkr')).rates.per_day.models).toBeUndefined();
  });
});

describe('the exclusion keys off the STORE, not the document', () => {
  test('a payload whose internal day disagrees with its row is still excluded correctly', async () => {
    // Which day a row is for is a fact about the store. A corrupt historical
    // document that claims another day — or none — must not smuggle the
    // first-report row back into the rate window.
    const h = makeHarness();
    await h.db.recordHeartbeat(
      INSTANCE_A, 'brokkr', '2026-07-07', 2,
      JSON.stringify({ day: '1999-01-01', metrics: { sessions: { count: 900 } } }),
      '2026-07-07',
    );
    await h.db.recordHeartbeat(
      INSTANCE_A, 'brokkr', '2026-07-08', 2,
      JSON.stringify({ metrics: { sessions: { count: 10 } } }), // no `day` at all
      '2026-07-08',
    );
    const body = await statsFor(h, 'brokkr');
    expect(body.instance.first_report_day).toBe('2026-07-07');
    expect(body.rates.excluded_day).toBe('2026-07-07');
    expect(body.rates.days_counted).toBe(1);
    expect(body.rates.per_day.sessions).toBe(10); // the 900 is not averaged in
  });

  test('an unparseable first-report row is still excluded', async () => {
    const h = makeHarness();
    await h.db.recordHeartbeat(INSTANCE_A, 'brokkr', '2026-07-07', 2, 'not json', '2026-07-07');
    await h.db.recordHeartbeat(
      INSTANCE_A, 'brokkr', '2026-07-08', 2,
      JSON.stringify({ day: '2026-07-08', metrics: { sessions: { count: 6 } } }),
      '2026-07-08',
    );
    const body = await statsFor(h, 'brokkr');
    expect(body.rates.excluded_day).toBe('2026-07-07');
    expect(body.rates.days_counted).toBe(1);
    expect(body.rates.per_day.sessions).toBe(6);
  });
});
