// The public give-back: aggregate JSON + the aggregate page.
//
// Two disclosure rules are under test, and both are load-bearing:
// small-cell suppression, and the deliberate ABSENCE of a family total.

import { describe, expect, test } from 'bun:test';
import { renderAggregatePage, escapeHtml } from '../src/page';
import { getReq, ingestReq, makeHarness } from './helpers';
import { INSTANCE_A, INSTANCE_B, INSTANCE_C, makeHeartbeat, SECRET_A, SECRET_B, SECRET_C } from './fixtures';

const IDS = [
  [INSTANCE_A, SECRET_A],
  [INSTANCE_B, SECRET_B],
  [INSTANCE_C, SECRET_C],
] as const;

async function seed(h: ReturnType<typeof makeHarness>, product: 'brokkr' | 'saga' | 'skuld', n: number) {
  for (const [id, secret] of IDS.slice(0, n)) {
    expect((await h.handler(ingestReq(makeHeartbeat(product, id), secret))).status).toBe(202);
  }
}

describe('aggregate JSON', () => {
  test('per product only — and the family total is explicitly null, not absent', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h, 'brokkr', 3);
    await seed(h, 'saga', 2);

    const body = await (await h.handler(getReq('/v1/stats'))).json() as any;
    expect(body.ok).toBe(true);
    expect(body.contract_version).toBe(2);
    expect(body.products).toEqual([
      { product: 'brokkr', installs_seen: 3, installs_active: 3, days_reported: 3 },
      { product: 'saga', installs_seen: 2, installs_active: 2, days_reported: 2 },
    ]);
    // The key exists and is null: a gap invites someone to "fix" it by summing
    // the column, which would double-count every installation running two
    // products.
    expect(Object.hasOwn(body, 'family_total_installs')).toBe(true);
    expect(body.family_total_installs).toBeNull();
    expect(body.data_quality).toBe('untrusted-public-ingest');
  });

  test('the response is served from cache, so a flood costs no database work', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h, 'brokkr', 1);
    for (let i = 0; i < 20; i++) {
      expect((await h.handler(getReq('/v1/stats'))).status).toBe(200);
      expect((await h.handler(getReq('/'))).status).toBe(200);
    }
    expect(h.counters.get('read_aggregate_ok')).toBe(40);
    expect(h.counters.get('read_aggregate_recomputed')).toBe(1);

    // ...and it does refresh once the window passes.
    h.advanceMs(61_000);
    await h.handler(getReq('/v1/stats'));
    expect(h.counters.get('read_aggregate_recomputed')).toBe(2);
  });

  test('a product below the small-cell floor is withheld entirely — and so is the fact that it was', async () => {
    // Publishing "1 product withheld" alongside the visible rows would name
    // the withheld product and state that it is under the floor, announcing
    // exactly the fact the suppression exists to hide.
    const h = makeHarness({ minAggregateCell: 3 });
    await seed(h, 'brokkr', 3);
    await seed(h, 'saga', 1);

    const r = await h.handler(getReq('/v1/stats'));
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body.products.map((p: any) => p.product)).toEqual(['brokkr']);
    expect(text).not.toContain('saga');
    expect(text).not.toContain('suppressed');
    expect(Object.hasOwn(body, 'suppressed_products')).toBe(false);

    const page = await (await h.handler(getReq('/'))).text();
    expect(page).not.toContain('saga');
    expect(page).not.toMatch(/withheld: fewer|products? withheld/);
  });

  test('a sub-floor active count is withheld while the install count is published', async () => {
    const h = makeHarness({ minAggregateCell: 3, today: '2026-07-09' });
    // Three installs seen, only one of them recently — so `installs_seen`
    // clears the floor and `installs_active` does not.
    await seed(h, 'brokkr', 1);
    for (const id of ['dormant-1', 'dormant-2']) {
      h.db.recordHeartbeat(id, 'brokkr', '2026-01-01', 2, '{}', '2026-01-01');
    }
    const body = await (await h.handler(getReq('/v1/stats'))).json() as any;
    const brokkr = body.products.find((p: any) => p.product === 'brokkr');
    expect(brokkr.installs_seen).toBe(3);
    expect(brokkr.installs_active).toBeNull();
  });

  test('an empty store answers with an empty list, not an error', async () => {
    const h = makeHarness();
    const r = await h.handler(getReq('/v1/stats'));
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.products).toEqual([]);
    expect(body.family_total_installs).toBeNull();
  });

  test('the aggregate needs no credential', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h, 'brokkr', 1);
    expect((await h.handler(getReq('/v1/stats'))).status).toBe(200);
  });
});

describe('aggregate page', () => {
  test('renders 200 text/html, with no JS and no external assets', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h, 'brokkr', 2);
    const r = await h.handler(getReq('/'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const page = await r.text();
    expect(page).toContain('<style>');
    expect(page).not.toContain('<script');
    expect(page).not.toContain('http://');
    expect(page).not.toContain('https://');
    expect(page).not.toMatch(/\bsrc=/);
    expect(page).not.toMatch(/<link\b/);
  });

  test('states the three honesty facts: no family total, untrusted data, pseudonymous', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h, 'brokkr', 1);
    const page = await (await h.handler(getReq('/'))).text();
    expect(page).toContain('no family total');
    expect(page).toContain('untrusted');
    expect(page).toContain('pseudonymous, not anonymous');
    expect(page).not.toContain('anonymous daily');
  });

  test('never renders an installation id', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h, 'brokkr', 3);
    const page = await (await h.handler(getReq('/'))).text();
    for (const [id] of IDS) expect(page).not.toContain(id);
  });

  test('suppressed figures render as an em dash, not as zero', () => {
    const page = renderAggregatePage({
      generated_day: '2026-07-09',
      active_window_days: 28,
      min_cell: 5,
      products: [{ product: 'brokkr', installs_seen: 40, installs_active: null, days_reported: 900 }],
    });
    expect(page).toContain('&mdash;');
    expect(page).toContain('40');
    expect(page).toContain('900');
    expect(page).not.toMatch(/\d+ products? withheld/);
  });

  test('an empty population renders a page rather than an error', () => {
    const page = renderAggregatePage({
      generated_day: '2026-07-09',
      active_window_days: 28,
      min_cell: 5,
      products: [],
    });
    expect(page).toContain('Nothing to report yet.');
  });
});

describe('the ONE escape function', () => {
  test('escapes & < > " and the apostrophe', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
  test('coerces non-strings safely', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
  });
  test('a hostile product name renders inert', () => {
    // Ingest cannot deliver one — the storable-product set is closed — so the
    // guarantee is proven at the renderer, where it actually lives.
    const page = renderAggregatePage({
      generated_day: '<script>alert(1)</script>',
      active_window_days: 28,
      min_cell: 5,
      products: [
        { product: '<script>alert(2)</script>', installs_seen: 9, installs_active: 9, days_reported: 9 },
      ],
    });
    expect(page).not.toContain('<script');
    expect(page).not.toContain('</script');
    expect(page).toContain('&lt;script&gt;');
  });
});
