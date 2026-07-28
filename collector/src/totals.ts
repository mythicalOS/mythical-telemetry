// Per-product totals for the authenticated per-install read (gate G5).
//
// An earlier collector folded brokkr's `sessions`, `spine` and `models` as if
// they were top-level facts about every payload. They live under `metrics`,
// and saga and skuld do not have them at all — so that fold does
// not merely produce wrong numbers for another product, it dereferences absent
// objects and 500s. This file replaces it with a declarative, total fold:
//
//   • the fold is DATA, one spec list per product, so adding a product cannot
//     introduce a new crash path;
//   • every accessor is defensive — an absent, null, wrong-typed or hostile
//     value yields the identity element, never an exception;
//   • an unrecognised product yields `{}` rather than an error. A collector
//     that has been handed a product it does not know how to summarise must
//     still return that install its own days.
//
// TEMPORAL CLASS IS RESPECTED: `delta` leaves are summed across the window,
// `gauge` leaves take the LAST sample in the window (the frozen field contract
// defines a gauge as "last sample of the day wins" — summing one would be
// meaningless), and booleans are OR-ed.

export type FoldMode = 'sum' | 'last' | 'or';

interface TotalSpec {
  /** Key in the emitted totals object. */
  readonly key: string;
  /** Path from the day document root, e.g. ['metrics', 'sessions', 'count']. */
  readonly path: readonly string[];
  readonly mode: FoldMode;
}

const BROKKR_SPECS: readonly TotalSpec[] = [
  { key: 'sessions', path: ['metrics', 'sessions', 'count'], mode: 'sum' },
  { key: 'minutes', path: ['metrics', 'sessions', 'minutes'], mode: 'sum' },
  { key: 'failed', path: ['metrics', 'sessions', 'failed'], mode: 'sum' },
  { key: 'review_runs', path: ['metrics', 'review', 'runs'], mode: 'sum' },
  { key: 'spine_joints', path: ['metrics', 'spine', 'joints'], mode: 'sum' },
  { key: 'spine_estimated', path: ['metrics', 'spine', 'estimated'], mode: 'or' },
];

const SAGA_SPECS: readonly TotalSpec[] = [
  { key: 'collect_runs', path: ['metrics', 'collect', 'runs'], mode: 'sum' },
  { key: 'collect_errors', path: ['metrics', 'collect', 'errors'], mode: 'sum' },
  { key: 'refusals', path: ['metrics', 'refusals'], mode: 'sum' },
  { key: 'mcp_tool_calls', path: ['metrics', 'mcp', 'tool_calls'], mode: 'sum' },
  { key: 'mcp_refusals', path: ['metrics', 'mcp', 'refusals'], mode: 'sum' },
  { key: 'advisories_fired', path: ['metrics', 'advisories', 'fired'], mode: 'sum' },
  // gauge — a connection count is a snapshot, never a running total
  { key: 'connections_total', path: ['metrics', 'connections', 'total'], mode: 'last' },
  { key: 'uptime_bucket', path: ['metrics', 'uptime_bucket'], mode: 'last' },
];

const SKULD_SPECS: readonly TotalSpec[] = [
  { key: 'runs_total', path: ['metrics', 'runs', 'total'], mode: 'sum' },
  { key: 'runs_succeeded', path: ['metrics', 'runs', 'succeeded'], mode: 'sum' },
  { key: 'runs_failed', path: ['metrics', 'runs', 'failed'], mode: 'sum' },
  { key: 'runs_chain_rejections', path: ['metrics', 'runs', 'chain_rejections'], mode: 'sum' },
  { key: 'gate_rejections', path: ['metrics', 'gate', 'rejections'], mode: 'sum' },
  { key: 'gate_approvals', path: ['metrics', 'gate', 'approvals'], mode: 'sum' },
  { key: 'sandbox_pool_exhausted', path: ['metrics', 'sandbox', 'pool_exhausted'], mode: 'sum' },
  { key: 'sandbox_uid_vends', path: ['metrics', 'sandbox', 'uid_vends'], mode: 'sum' },
  // gauges
  { key: 'detection_state', path: ['metrics', 'detection_state'], mode: 'last' },
  { key: 'uptime_bucket', path: ['metrics', 'uptime_bucket'], mode: 'last' },
];

const SPECS: Readonly<Record<string, readonly TotalSpec[]>> = {
  brokkr: BROKKR_SPECS,
  saga: SAGA_SPECS,
  skuld: SKULD_SPECS,
};

/** Sort key for a possibly-unrepresentable count: null outranks every number. */
function rank(sessions: number | null): number {
  return sessions === null ? Number.MAX_VALUE : sessions;
}

/** Walk a path without throwing on anything. */
function dig(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const step of path) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[step];
  }
  return node;
}

/** Finite number or 0. Rejects NaN, Infinity, strings and objects alike. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * An accumulated figure, or null when it is not representable.
 *
 * Individual leaves are finite, but a long enough window of large enough ones
 * can still overflow to Infinity while adding up. `JSON.stringify` renders
 * that as a bare `null` with no explanation, so a consumer reads "no value"
 * where the truth is "too large to state". Returning null deliberately, from
 * a documented union, says the same thing honestly — and it never yields
 * `NaN`, which would serialize the same way and mean something else again.
 */
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** A JSON-safe scalar, or null. Used for gauges, whose type is per-leaf. */
function scalar(value: unknown): number | string | boolean | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

/** A model's share of the window. `sessions` is null when the sum is not representable. */
export interface ModelTotal {
  name: string;
  sessions: number | null;
}

export type TotalsValue = number | string | boolean | null | ModelTotal[];

/**
 * Fold a day-ascending window into that product's totals.
 *
 * `days` is trusted to be an array; every element is treated as arbitrary.
 */
export function foldTotals(product: string, days: readonly unknown[]): Record<string, TotalsValue> {
  const specs = SPECS[product];
  if (!specs) return {};

  const out: Record<string, TotalsValue> = {};
  for (const spec of specs) {
    if (spec.mode === 'sum') {
      let acc = 0;
      for (const day of days) acc += num(dig(day, spec.path));
      out[spec.key] = finite(acc);
    } else if (spec.mode === 'or') {
      let acc = false;
      for (const day of days) acc = acc || dig(day, spec.path) === true;
      out[spec.key] = acc;
    } else {
      // 'last' — days arrive ascending, so the final defined sample wins.
      let acc: number | string | boolean | null = null;
      for (const day of days) {
        const v = scalar(dig(day, spec.path));
        if (v !== null) acc = v;
      }
      out[spec.key] = acc;
    }
  }

  if (product === 'brokkr') {
    out['spine_tokens_saved'] = finite(foldSpineTokensSaved(days));
    out['models'] = foldModels(days);
  }

  return out;
}

/**
 * Per-day means over a window from which the first-report day has ALREADY been
 * removed by the caller.
 *
 * WHY THAT DAY IS EXCLUDED. The emitter produces per-day deltas by diffing
 * against a stored prior snapshot. A counter with NO prior snapshot emits its
 * current LIFETIME value — so an installation that ran for months before
 * telemetry was switched on reports months of accumulation as a single day.
 * That is not an edge case: it happens once for every installation at
 * activation, and again for any leaf added later. Averaging that row in
 * produces a one-time spike at every activation and then permanently
 * overstates the per-day rate, because the inflated row never ages out of a
 * lifetime mean.
 *
 * The row itself is real and is kept — it is the only occasion on which a
 * genuine lifetime total is available. It simply is not a representative day.
 *
 * ONLY `delta` leaves get a rate. A gauge is a snapshot, so a mean of gauges
 * is not a rate of anything, and the derived model table is a breakdown rather
 * than a quantity per day.
 *
 * Returns null when the window has no representative day left, rather than
 * zeros — "no data to average" and "averaged to zero" are different claims.
 */
export function foldRates(product: string, rateDays: readonly unknown[]): Record<string, number | null> | null {
  const specs = SPECS[product];
  if (!specs || rateDays.length === 0) return null;

  // Accumulated as a running mean rather than sum-then-divide: the sum of a
  // long window of large leaves can overflow to Infinity even though the mean
  // is perfectly representable.
  const out: Record<string, number | null> = {};
  for (const spec of specs) {
    if (spec.mode !== 'sum') continue;
    out[spec.key] = finite(runningMean(rateDays, (day) => num(dig(day, spec.path))));
  }
  if (product === 'brokkr') {
    out['spine_tokens_saved'] = finite(
      runningMean(rateDays, (day) => {
        const before = num(dig(day, ['metrics', 'spine', 'tokens_before']));
        const after = num(dig(day, ['metrics', 'spine', 'tokens_after']));
        return Math.max(0, before - after);
      }),
    );
  }
  return out;
}

/**
 * Incremental mean — never forms the (possibly overflowing) total.
 *
 * The division happens BEFORE the subtraction. The textbook `mean += (value -
 * mean) / n` overflows on its own for mixed-sign inputs whose mean is
 * perfectly representable, because `value - mean` can exceed the range even
 * when the result would not.
 */
function runningMean(days: readonly unknown[], valueOf: (day: unknown) => number): number {
  let mean = 0;
  let n = 0;
  for (const day of days) {
    n += 1;
    mean += valueOf(day) / n - mean / n;
  }
  return mean;
}

/**
 * Sum of the per-day spine saving, each floored at zero.
 *
 * Flooring per day rather than on the total is deliberate: a single day where
 * the compacted form was larger must not eat a genuine saving from another.
 */
function foldSpineTokensSaved(days: readonly unknown[]): number {
  let saved = 0;
  for (const day of days) {
    const before = num(dig(day, ['metrics', 'spine', 'tokens_before']));
    const after = num(dig(day, ['metrics', 'spine', 'tokens_after']));
    saved += Math.max(0, before - after);
  }
  return saved;
}

/**
 * Merge `metrics.models[]` across days into one name → sessions table, busiest
 * first. An unrepresentable sum is null, never 0 — "too large to state" and
 * "no sessions" are opposite claims.
 */
function foldModels(days: readonly unknown[]): ModelTotal[] {
  const totals = new Map<string, number>();
  for (const day of days) {
    const models = dig(day, ['metrics', 'models']);
    if (!Array.isArray(models)) continue;
    for (const entry of models) {
      if (typeof entry !== 'object' || entry === null) continue;
      const name = (entry as Record<string, unknown>)['name'];
      if (typeof name !== 'string') continue;
      totals.set(name, (totals.get(name) ?? 0) + num((entry as Record<string, unknown>)['sessions']));
    }
  }
  return [...totals.entries()]
    .map(([name, sessions]) => ({ name, sessions: finite(sessions) }))
    // Busiest first; an unrepresentable count sorts to the top, since it is
    // larger than anything statable, and ties break by name for determinism.
    .sort((a, b) => rank(b.sessions) - rank(a.sessions) || a.name.localeCompare(b.name));
}

/**
 * The one computed field added to a returned day document: brokkr's
 * `metrics.spine.tokens_saved`.
 *
 * It is a READ-CONTRACT convenience, not part of the wire schema — a returned
 * day is deliberately not a schema-valid heartbeat, and nothing round-trips it
 * back into ingest. Mutates nothing: the caller owns the parsed copy.
 */
export function decorateDay(product: string, day: Record<string, unknown>): void {
  if (product !== 'brokkr') return;
  const metrics = day['metrics'];
  if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) return;
  const spine = (metrics as Record<string, unknown>)['spine'];
  if (typeof spine !== 'object' || spine === null || Array.isArray(spine)) return;
  const s = spine as Record<string, unknown>;
  s['tokens_saved'] = Math.max(0, num(s['tokens_before']) - num(s['tokens_after']));
}
