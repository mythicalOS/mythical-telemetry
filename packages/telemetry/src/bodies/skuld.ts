// The skuld body — job-scheduling counts and gauges.
//
// Same structural drop-rule as the sibling bodies: named counters out of a normalised delta map,
// never a raw snapshot spread. A job's name, its script source, its prompt and its output paths
// exist only in the local database and have no route into a payload.
//
// `detection_state` is emitted as a CLOSED ENUM, never the raw integer the local gauge holds: an
// integer is an open value space, and "0 or 1 today" is not a fence — the next state added
// upstream would ship as an unlabelled number the collector cannot interpret.
//
// The scheduling identity this product already holds is NOT the telemetry identity and must not
// be touched: it seeds job-scheduling jitter, so replacing it silently changes when jobs run.
// Telemetry mints its own separate identity (see identity.ts).

import type { SkuldMetrics, DetectionState, UptimeBucket } from "../envelope.ts";
import { uptimeBucket, DETECTION_STATES } from "../envelope.ts";
import { delta } from "./index.ts";

const MAX_COUNT = 1_000_000_000;

/** The counter names this body reads. Nothing outside this list is ever read into a payload. */
export const SKULD_COUNTER_NAMES = [
  "jobs_created_by_type.script",
  "jobs_created_by_type.ai",
  "jobs_created_by_type.report",
  "jobs_created_by_type.agent-send",
  "jobs_created_by_type.distill",
  "runs_total",
  "runs_succeeded",
  "runs_failed",
  "chain_rejections",
  "event_runs_enqueued",
  "event_asks_delivered",
  "rate_limit_merged",
  "event_route_errors",
  "gate_rejections",
  "gate_approvals",
  "sandbox_pool_exhausted",
  "sandbox_uid_vends",
] as const;
// `event_deferrals` is NOT on this list. It was drafted into the contract and then found to have a
// dead producer — the event trigger arm validates-and-RUNS rather than validates-and-defers, so the
// deferral path is unreachable and the bump was retired. It was dropped before the freeze rather
// than shipped permanently zero, and repointing it at a neighbouring counter would have silently
// redefined a frozen field. Wanting it later means a new leaf in a new schema version.

function clamp(value: number): number {
  return Math.min(Math.max(0, Math.floor(value)), MAX_COUNT);
}

/**
 * Map the local gauge to the wire enum. The local counter is absent before the first probe, `1`
 * when a sibling was detected and `0` when it was not; anything else is `unknown` rather than a
 * guess.
 */
export function toDetectionState(raw: number | null | undefined): DetectionState {
  if (raw === 1) return "detected";
  if (raw === 0) return "not_detected";
  return "unknown";
}

export interface SkuldBodyInput {
  /** Per-day deltas from `normalizeDeltas` — never raw lifetime counters. */
  deltas: Record<string, number>;
  /** The local detection gauge, or undefined when no probe has run. */
  detectionState: number | null | undefined;
  uptimeSeconds: number;
}

export function buildSkuldMetrics(input: SkuldBodyInput): SkuldMetrics {
  const d = (name: string): number => clamp(delta(input.deltas, name));
  const state = toDetectionState(input.detectionState);

  return {
    jobs: {
      created_by_type: {
        script: d("jobs_created_by_type.script"),
        ai: d("jobs_created_by_type.ai"),
        report: d("jobs_created_by_type.report"),
        // The local counter key is hyphenated; the wire key is not. Normalised here, once.
        agent_send: d("jobs_created_by_type.agent-send"),
        distill: d("jobs_created_by_type.distill"),
      },
    },
    runs: {
      total: d("runs_total"),
      succeeded: d("runs_succeeded"),
      failed: d("runs_failed"),
      chain_rejections: d("chain_rejections"),
    },
    events: {
      runs_enqueued: d("event_runs_enqueued"),
      asks_delivered: d("event_asks_delivered"),
      // The local counter name predates the wire name; `rate_limit_merged` is the genuine
      // deferral signal, so the wire leaf says what it counts.
      rate_limit_deferred: d("rate_limit_merged"),
      route_errors: d("event_route_errors"),
    },
    gate: { rejections: d("gate_rejections"), approvals: d("gate_approvals") },
    sandbox: { pool_exhausted: d("sandbox_pool_exhausted"), uid_vends: d("sandbox_uid_vends") },
    detection_state: (DETECTION_STATES as readonly string[]).includes(state) ? state : "unknown",
    uptime_bucket: uptimeBucket(input.uptimeSeconds) as UptimeBucket,
  };
}
