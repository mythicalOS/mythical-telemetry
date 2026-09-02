// The saga body — database-monitoring counts and gauges.
//
// The drop-rule is structural here, not a convention: the builder reads named counters out of a
// normalised delta map and shapes gauges out of an engine-family tally. It never spreads a raw
// counter snapshot, so a counter that some other subsystem mis-names — with a database, host or
// connection name in it — cannot reach the payload even by accident.
//
// `connections.by_engine` supersedes the older engine-presence booleans: a count per family is
// strictly more informative and no less safe. An UNRECOGNISED engine is not emitted at all — it
// still contributes to `connections.total`, so the schema's `sum(by_engine) <= total` holds.

import type { SagaMetrics, UptimeBucket } from "../envelope.ts";
import { uptimeBucket } from "../envelope.ts";
import { delta } from "./index.ts";

const MAX_COUNT = 1_000_000_000;
const MAX_GAUGE = 100_000;

/** The counter names this body reads. Nothing outside this list is ever read into a payload. */
export const SAGA_COUNTER_NAMES = [
  "collect_runs_total",
  "collect_errors_total",
  "refusals_total",
  "mcp_tool_calls_total",
  "mcp_refusals_total",
  "advisories_fired_total",
  // TWO severities, matching the advisor's severity type exactly. A third was drafted and struck
  // before the freeze — it does not exist in the source, and a leaf with no producer is one that
  // ships zero forever. Adding one later is a new leaf in a new schema version.
  "advisories_fired_info_total",
  "advisories_fired_warn_total",
  "probe_ok_total",
  "probe_auth_failed_total",
  "probe_unreachable_total",
  "probe_timeout_total",
  "probe_other_total",
] as const;

/** The closed engine-family set. An engine outside it is counted in the total and nothing else. */
export const SAGA_ENGINE_FAMILIES = ["postgres", "mysql", "sqlite"] as const;
export type SagaEngineFamily = (typeof SAGA_ENGINE_FAMILIES)[number];

function clamp(value: number, max: number): number {
  return Math.min(Math.max(0, Math.floor(value)), max);
}

export interface SagaBodyInput {
  /** Per-day deltas from `normalizeDeltas` — never raw lifetime counters. */
  deltas: Record<string, number>;
  /** Live registry snapshot: the engine of each registered connection. Names are never read. */
  connections: ReadonlyArray<{ engine: string }>;
  uptimeSeconds: number;
}

export function buildSagaMetrics(input: SagaBodyInput): SagaMetrics {
  const d = (name: string): number => clamp(delta(input.deltas, name), MAX_COUNT);

  const byEngine: Record<SagaEngineFamily, number> = { postgres: 0, mysql: 0, sqlite: 0 };
  let total = 0;
  for (const conn of input.connections) {
    // Stop at the gauge ceiling rather than counting past it and clamping afterwards: clamping
    // the total and the per-family counts independently could leave sum(by_engine) > total, and
    // the collector would reject a day it should have kept.
    if (total >= MAX_GAUGE) break;
    total += 1;
    const engine = conn.engine;
    if ((SAGA_ENGINE_FAMILIES as readonly string[]).includes(engine)) {
      byEngine[engine as SagaEngineFamily] += 1;
    }
  }

  return {
    collect: { runs: d("collect_runs_total"), errors: d("collect_errors_total") },
    refusals: d("refusals_total"),
    mcp: { tool_calls: d("mcp_tool_calls_total"), refusals: d("mcp_refusals_total") },
    advisories: {
      fired: d("advisories_fired_total"),
      by_severity: { info: d("advisories_fired_info_total"), warn: d("advisories_fired_warn_total") },
    },
    connections: {
      by_engine: { postgres: byEngine.postgres, mysql: byEngine.mysql, sqlite: byEngine.sqlite },
      total,
    },
    probe: {
      outcomes: {
        ok: d("probe_ok_total"),
        auth_failed: d("probe_auth_failed_total"),
        unreachable: d("probe_unreachable_total"),
        timeout: d("probe_timeout_total"),
        other: d("probe_other_total"),
      },
    },
    uptime_bucket: uptimeBucket(input.uptimeSeconds) as UptimeBucket,
  };
}
