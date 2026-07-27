// Per-product body builders + the delta-normalisation helper every cumulative producer runs
// BEFORE its numbers reach a body.
//
// WHY NORMALISATION LIVES HERE AND NOT IN THE COLLECTOR. Two products hold LIFETIME counters:
// `runs_total` reading 100 → 105 → 110 over three days sums to 315 if the collector treats each
// row as a daily figure, when the truth is 10. The wire therefore carries per-day deltas only —
// `cumulative` is not a legal temporal class on any v2 leaf.
//
// The load-bearing case is a counter that went BACKWARDS. Only the producer can tell a process
// restart (the counter began again from zero, and the new value IS the day's activity) from a
// genuine decrease; the collector sees the same two numbers either way and cannot. So a backwards
// counter emits its NEW value — never a negative number, which would corrupt every downstream sum
// and violate the schema's `minimum: 0`.

import type { BrokkrMetrics, SagaMetrics, SkuldMetrics } from "../envelope.ts";

export * from "./brokkr.ts";
export * from "./saga.ts";
export * from "./skuld.ts";

export type AnyMetrics = BrokkrMetrics | SagaMetrics | SkuldMetrics;

/** A raw lifetime-counter reading, by counter name. */
export type CounterSnapshot = Readonly<Record<string, number>>;

export interface DeltaNormalisation {
  /** Per-counter values for the day — always >= 0. Feed these to a body builder. */
  deltas: Record<string, number>;
  /** The snapshot to persist as "yesterday" for the next run. Sanitised, never the raw input. */
  snapshot: Record<string, number>;
  /** Counters that went backwards this run — a restart. Surfaced so a caller can log it. */
  restarted: string[];
  /** True when there was no prior snapshot: the day's values ARE the lifetime values. */
  firstRun: boolean;
}

/** Coerce a counter reading to a non-negative safe integer. Anything else reads as 0. */
function sane(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

/**
 * Turn lifetime counters into per-day deltas.
 *
 * - No prior snapshot (first run, or the state file was lost): emit the CURRENT value and record
 *   the snapshot. The alternative — emitting zero — would silently discard an install's entire
 *   history on its first reporting day.
 * - A counter absent from the prior snapshot (newly instrumented): same rule, treated as first-run
 *   for that counter alone.
 * - `current < prior`: a restart. Emit `current`, never `current - prior`.
 * - Otherwise: `current - prior`.
 *
 * The result is always >= 0, which is exactly what the schema's `minimum: 0` enforces.
 */
export function normalizeDeltas(prior: CounterSnapshot | undefined, current: CounterSnapshot): DeltaNormalisation {
  const deltas: Record<string, number> = {};
  const snapshot: Record<string, number> = {};
  const restarted: string[] = [];
  const firstRun = prior === undefined;

  for (const [name, rawValue] of Object.entries(current)) {
    const value = sane(rawValue);
    snapshot[name] = value;

    if (prior === undefined || !Object.prototype.hasOwnProperty.call(prior, name)) {
      deltas[name] = value; // first day for this counter — the current value IS the day's figure
      continue;
    }
    const previous = sane(prior[name]);
    if (value < previous) {
      restarted.push(name);
      deltas[name] = value; // restart: the new value is the activity since the restart
      continue;
    }
    deltas[name] = value - previous;
  }

  return { deltas, snapshot, restarted, firstRun };
}

/** Read a normalised delta by name, defaulting to 0 for a counter this build does not produce. */
export function delta(deltas: Record<string, number>, name: string): number {
  return sane(deltas[name]);
}
