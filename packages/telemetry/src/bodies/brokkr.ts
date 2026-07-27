// The brokkr body — v1's ten sections, unchanged, now under `metrics`.
//
// This product already produces COMPLETED-DAY deltas, so it needs no delta normalisation; its
// rollup folds are the producer. What this builder owns is the string and range discipline that
// keeps the payload structurally unable to carry identity: model ids ride the closed allowlist,
// platform and harness enums are closed with an "other" bucket, and every count is a clamped
// non-negative safe integer.

import type { BrokkrMetrics } from "../envelope.ts";
import { normalizeModelId } from "../model-id-allowlist.ts";

const MAX_SESSIONS = 100_000;
const MAX_MINUTES = 1_000_000;
const MAX_TOKENS = 1_000_000_000_000;
const MAX_JOINTS = 10_000;
const MAX_HISTOGRAM = 100_000;
const MODELS_MAX = 16;

function clampInt(value: unknown, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  return Math.min(Math.round(n), max);
}

function closedEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Spend `budget` across `values` in order, so their sum can never exceed it.
 *
 * Several brokkr leaves must sum to at most `sessions.count`. Clamping each of them independently
 * against its own ceiling does NOT preserve that: at the ceiling, two buckets of 100 000 each
 * survive their own clamp and then breach a `sessions.count` that clamped to 100 000. The document
 * would be rejected and the whole day lost — so the sum is reconciled here, at the producer, where
 * a self-consistent approximation is strictly better than a dropped day.
 */
function spendBudget(values: readonly number[], budget: number): number[] {
  let remaining = Math.max(0, budget);
  return values.map((value) => {
    const spend = Math.min(Math.max(0, value), remaining);
    remaining -= spend;
    return spend;
  });
}

/** The day's completed-session fold, as the product's rollup produces it. */
export interface BrokkrDayRollup {
  sessions: { count: number; minutes: number; failed: number };
  fill: { histogram: number[]; bearing: number; avg_sum: number };
  mode_split: { normal: number; spine: number };
  spine: { joints: number; tokens_before: number; tokens_after: number; estimated: boolean };
  models: Record<string, number>;
  tokens: { input: number; cache_read: number; cache_creation: number; output: number };
  review: { runs: number };
  errors: { session_failed: number };
}

/** The gauge half of the body — configuration and feature state as of the send. */
export interface BrokkrConfigView {
  backend: "local" | "server";
  harness_type: string;
  wizard_completed: boolean;
  team_size: number;
  playbooks_active: number;
  review_mode: "cross-model" | "ephemeral";
  terminal: boolean;
  edges: boolean;
}

/** A rollup with every counter at zero — a quiet day still heartbeats. */
export function zeroBrokkrRollup(): BrokkrDayRollup {
  return {
    sessions: { count: 0, minutes: 0, failed: 0 },
    fill: { histogram: Array.from({ length: 10 }, () => 0), bearing: 0, avg_sum: 0 },
    mode_split: { normal: 0, spine: 0 },
    spine: { joints: 0, tokens_before: 0, tokens_after: 0, estimated: false },
    models: {},
    tokens: { input: 0, cache_read: 0, cache_creation: 0, output: 0 },
    review: { runs: 0 },
    errors: { session_failed: 0 },
  };
}

export function buildBrokkrMetrics(input: { rollup?: BrokkrDayRollup | undefined; config: BrokkrConfigView }): BrokkrMetrics {
  const data = input.rollup ?? zeroBrokkrRollup();
  const cfg = input.config;

  // ── the cross-field invariants are satisfied HERE, by construction ──────────────────────
  // Every one of them is enforced by the collector, so a body that breaches one is not "slightly
  // off" — it is a day silently dropped on ingest. They are therefore reconciled at the producer.

  // mode_split partitions sessions.count exactly, so the split is authoritative and the count is
  // derived from it. The two come from the same fold and agree in practice; they can only diverge
  // when a value hits the ceiling, and then the split is the more informative half to keep.
  const [normal, spine] = spendBudget([clampInt(data.mode_split.normal, MAX_SESSIONS), clampInt(data.mode_split.spine, MAX_SESSIONS)], MAX_SESSIONS) as [
    number,
    number,
  ];
  const rawCount = clampInt(data.sessions.count, MAX_SESSIONS);
  const count = normal + spine === rawCount ? rawCount : normal + spine;

  const failed = Math.min(clampInt(data.sessions.failed, MAX_SESSIONS), count);
  // sum(peak_histogram) <= sessions.count — spawn failures carry no fill.
  const histogram = spendBudget(
    Array.from({ length: 10 }, (_, i) => clampInt(data.fill.histogram[i], MAX_HISTOGRAM)),
    count,
  );
  const bearing = clampInt(data.fill.bearing, MAX_SESSIONS);
  const avgMean = bearing > 0 ? Math.round(Math.min(100, Math.max(0, data.fill.avg_sum / bearing)) * 10) / 10 : null;

  // sum(models[].sessions) <= sessions.count. Sorted descending first, so the budget is spent on
  // the models that actually dominated the day rather than on whichever hashed first.
  const ranked = Object.entries(data.models)
    .map(([name, sessions]) => ({ name: normalizeModelId(name) as string, sessions: clampInt(sessions, MAX_SESSIONS) }))
    .filter((m) => m.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions || (a.name < b.name ? -1 : 1))
    .slice(0, MODELS_MAX);
  const modelBudget = spendBudget(
    ranked.map((m) => m.sessions),
    count,
  );
  const models = ranked.map((m, i) => ({ name: m.name, sessions: modelBudget[i] ?? 0 })).filter((m) => m.sessions > 0);

  return {
    config: {
      backend: closedEnum(cfg.backend, ["local", "server"] as const, "local"),
      harness_type: closedEnum(cfg.harness_type, ["claude", "codex"] as const, "other"),
      wizard_completed: cfg.wizard_completed === true,
      team_size: clampInt(cfg.team_size, MAX_SESSIONS),
      playbooks_active: clampInt(cfg.playbooks_active, MAX_SESSIONS),
      review_mode: closedEnum(cfg.review_mode, ["cross-model", "ephemeral"] as const, "cross-model"),
    },
    features: { terminal: cfg.terminal === true, edges: cfg.edges === true },
    sessions: { count, minutes: clampInt(data.sessions.minutes, MAX_MINUTES), failed },
    context_fill: { peak_histogram: histogram, avg_mean: avgMean },
    mode_split: { normal, spine },
    spine: {
      joints: clampInt(data.spine.joints, MAX_JOINTS),
      tokens_before: clampInt(data.spine.tokens_before, MAX_TOKENS),
      tokens_after: clampInt(data.spine.tokens_after, MAX_TOKENS),
      estimated: data.spine.estimated === true,
    },
    models,
    tokens: {
      input: clampInt(data.tokens.input, MAX_TOKENS),
      cache_read: clampInt(data.tokens.cache_read, MAX_TOKENS),
      cache_creation: clampInt(data.tokens.cache_creation, MAX_TOKENS),
      output: clampInt(data.tokens.output, MAX_TOKENS),
    },
    review: { runs: clampInt(data.review.runs, MAX_SESSIONS) },
    errors: { classes: { session_failed: Math.min(clampInt(data.errors.session_failed, MAX_SESSIONS), count) } },
  };
}
