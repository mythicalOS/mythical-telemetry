// `collector/tests/aggregate.test.ts`, ported to the Worker's route layer.
//
// The public give-back: aggregate JSON + the aggregate page.
//
// Two disclosure rules are under test, and both are load-bearing:
// small-cell suppression, and the deliberate ABSENCE of a family total.
//
// Mechanical transform only — store calls gained an `await`. No assertion was
// relaxed. What a green run here does and does not prove: see `helpers.ts`.
//
// ── WHAT WAS NOT PORTED, AND WHY ───────────────────────────────────────────
//
// The original's `suppressed figures render as an em dash`, `an empty
// population renders a page`, and the whole `the ONE escape function` block
// call `renderAggregatePage` / `escapeHtml` DIRECTLY, with hand-built views and
// no route in sight. Those are unit tests of `collector/src/page.ts`, which the
// Worker imports BY REFERENCE — the same module object, not a copy. They stay
// where the module they test lives. Everything that reaches the renderer
// THROUGH `GET /` is ported, because that path is the Worker's own.
//
// ── WHAT WAS ADDED ─────────────────────────────────────────────────────────
//
// The small-cell floor is a PRIVACY control, not a formatting preference: it is
// what stops an individual installation being picked out of a public,
// unauthenticated aggregate. The original exercises it at a floor of 3 with one
// product under it. Three tests are added below to pin it as a control — the
// exact boundary, the DEPLOYED default, and the fact that the suppression
// covers the active count independently of the seen count.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_MIN_AGGREGATE_CELL } from '../src/server';
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

/**
 * Installs beyond the three derived fixtures, written straight to the store.
 *
 * The floor tests need populations larger than the number of (secret, id) pairs
 * the fixtures provide, and the identities themselves are irrelevant to what is
 * being asserted — only the COUNT matters. Same device the original uses for
 * its dormant installs.
 */
async function seedExtra(h: ReturnType<typeof makeHarness>, product: string, n: number, day = '2026-07-09') {
  for (let i = 0; i < n; i++) {
    // The day is part of the id so two batches at different days are two
    // distinct populations rather than the second one upserting the first.
    await h.db.recordHeartbeat(`extra-${product}-${day}-${i}`, product, day, 1, '{}', day);
  }
}

describe('aggregate JSON', () => {
  test('per product only — and the family total is explicitly null, not absent', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h, 'brokkr', 3);
    await seed(h, 'saga', 2);

    const body = await (await h.handler(getReq('/api/v1/stats'))).json() as any;
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
      expect((await h.handler(getReq('/api/v1/stats'))).status).toBe(200);
      expect((await h.handler(getReq('/'))).status).toBe(200);
    }
    expect(h.counters.get('read_aggregate_ok')).toBe(40);
    expect(h.counters.get('read_aggregate_recomputed')).toBe(1);

    // ...and it does refresh once the window passes.
    h.advanceMs(61_000);
    await h.handler(getReq('/api/v1/stats'));
    expect(h.counters.get('read_aggregate_recomputed')).toBe(2);
  });

  test('a product below the small-cell floor is withheld entirely — and so is the fact that it was', async () => {
    // Publishing "1 product withheld" alongside the visible rows would name
    // the withheld product and state that it is under the floor, announcing
    // exactly the fact the suppression exists to hide.
    const h = makeHarness({ minAggregateCell: 3 });
    await seed(h, 'brokkr', 3);
    await seed(h, 'saga', 1);

    const r = await h.handler(getReq('/api/v1/stats'));
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
      await h.db.recordHeartbeat(id, 'brokkr', '2026-01-01', 2, '{}', '2026-01-01');
    }
    const body = await (await h.handler(getReq('/api/v1/stats'))).json() as any;
    const brokkr = body.products.find((p: any) => p.product === 'brokkr');
    expect(brokkr.installs_seen).toBe(3);
    expect(brokkr.installs_active).toBeNull();
  });

  test('an empty store answers with an empty list, not an error', async () => {
    const h = makeHarness();
    const r = await h.handler(getReq('/api/v1/stats'));
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.products).toEqual([]);
    expect(body.family_total_installs).toBeNull();
  });

  test('the aggregate needs no credential', async () => {
    const h = makeHarness({ minAggregateCell: 1 });
    await seed(h, 'brokkr', 1);
    expect((await h.handler(getReq('/api/v1/stats'))).status).toBe(200);
  });
});

// ADDED — the floor as a privacy control rather than a formatting rule.
describe('the small-cell floor: the exact boundary, at the DEPLOYED default', () => {
  test('the deployed default floor is 5, and the response states which floor it used', async () => {
    // The number is published so a consumer knows the rule that produced the
    // rows — the rule, not the exceptions to it. `worker.ts` reads
    // MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL with this same default.
    expect(DEFAULT_MIN_AGGREGATE_CELL).toBe(5);
    const h = makeHarness({ minAggregateCell: DEFAULT_MIN_AGGREGATE_CELL });
    const body = await (await h.handler(getReq('/api/v1/stats'))).json() as any;
    expect(body.min_cell).toBe(5);
  });

  test('a cell of exactly the floor is published; one below it does not appear at all', async () => {
    // The boundary is the whole control. Off by one in the permissive
    // direction and a population of four is publishable, which is small enough
    // for a determined reader with side knowledge to reason about individuals.
    const floor = DEFAULT_MIN_AGGREGATE_CELL;

    const atFloor = makeHarness({ minAggregateCell: floor, today: '2026-07-09' });
    await seedExtra(atFloor, 'brokkr', floor);
    const atBody = await (await atFloor.handler(getReq('/api/v1/stats'))).json() as any;
    expect(atBody.products).toEqual([
      { product: 'brokkr', installs_seen: floor, installs_active: floor, days_reported: floor },
    ]);

    const belowFloor = makeHarness({ minAggregateCell: floor, today: '2026-07-09' });
    await seedExtra(belowFloor, 'brokkr', floor - 1);
    const belowText = await (await belowFloor.handler(getReq('/api/v1/stats'))).text();
    const belowBody = JSON.parse(belowText);
    expect(belowBody.products).toEqual([]);
    // Not "brokkr: withheld", not a zero row, not a count of what was dropped.
    // The withheld product's NAME is itself the disclosure.
    expect(belowText).not.toContain('brokkr');
    expect(belowText).not.toContain(String(floor - 1));

    // ...and the page built from the same view says nothing more.
    const belowPage = await (await belowFloor.handler(getReq('/'))).text();
    expect(belowPage).not.toContain('brokkr');
  });

  test('the active count has its OWN floor, applied independently of the seen count', async () => {
    // A published row whose `installs_active` was below the floor would leak a
    // small cell through the second column while the first one looked safe.
    const floor = DEFAULT_MIN_AGGREGATE_CELL;
    const h = makeHarness({ minAggregateCell: floor, today: '2026-07-09' });
    // Enough installs SEEN to clear the floor, but only floor-1 of them recent.
    await seedExtra(h, 'brokkr', floor - 1, '2026-07-09');
    await seedExtra(h, 'brokkr', 3, '2026-01-01');

    const body = await (await h.handler(getReq('/api/v1/stats'))).json() as any;
    const brokkr = body.products.find((p: any) => p.product === 'brokkr');
    expect(brokkr.installs_seen).toBe(floor + 2);
    expect(brokkr.installs_active).toBeNull(); // withheld: floor - 1 is under the floor
    // Withheld means ABSENT, never zero — "nobody is active" and "too few to
    // say" are opposite claims about a population.
    expect(brokkr.installs_active).not.toBe(0);
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

  test('the page says the figures cover the retention window, not all time', async () => {
    // Identity rows expire, so "installations seen" counts installations seen
    // WITHIN the window. An unqualified "seen" reads as all-time and overstates,
    // which is the same class of quiet falsehood as a retention with no clock.
    const h = makeHarness({ minAggregateCell: 1, retentionDays: 45 });
    await seed(h, 'brokkr', 1);
    const page = await (await h.handler(getReq('/'))).text();
    expect(page).toContain('Installations seen (45d)');
    expect(page).toContain('Nothing here is an all-time total');
    expect(page).toContain('45 days from the day it <em>arrives</em>');
    // Day-granular, and pruned daily — so the page must not promise deletion on
    // the exact day either.
    expect(page).toContain('deleted by the next');
    // ...and it does NOT claim the figures describe only the last 45 days of
    // activity: a record can arrive up to a month after the day it covers, so
    // the days behind those counts reach further back than the window does.
    expect(page).toContain('month after the day it covers');
    // The heading must never be unqualified again: bare "Installations seen"
    // reads as all-time, and the store no longer holds all time.
    expect(page).not.toMatch(/Installations seen<\/th>/);

    const body = await (await h.handler(getReq('/api/v1/stats'))).json() as any;
    expect(body.retention_days).toBe(45);
  });
});
