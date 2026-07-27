// Shared test fixtures. Excluded from the published tarball (see package.json `files`).
//
// These are hand-written rather than emitter-produced ON PURPOSE: the lockstep test needs a
// document that came from somewhere OTHER than the emitter, or "emitter output validates" would be
// the only thing ever checked and a schema/validator disagreement could hide behind it.

import type { BrokkrHeartbeat, Heartbeat, SagaHeartbeat, SkuldHeartbeat } from "./envelope.ts";

export const FIXTURE_INSTANCE_ID = "60e05bd1-b195-4f2f-9411-2fa7197a5c88";
export const FIXTURE_DAY = "2026-07-26";

export function brokkrFixture(): BrokkrHeartbeat {
  return {
    schema_version: 2,
    instance_id: FIXTURE_INSTANCE_ID,
    day: FIXTURE_DAY,
    product: { name: "brokkr", version: "0.1.37" },
    platform: { os: "darwin", arch: "arm64" },
    metrics: {
      config: {
        backend: "local",
        harness_type: "claude",
        wizard_completed: true,
        team_size: 4,
        playbooks_active: 3,
        review_mode: "cross-model",
      },
      features: { terminal: true, edges: false },
      sessions: { count: 12, minutes: 340, failed: 1 },
      context_fill: { peak_histogram: [0, 1, 2, 3, 2, 1, 1, 1, 0, 1], avg_mean: 41.5 },
      mode_split: { normal: 9, spine: 3 },
      spine: { joints: 5, tokens_before: 120_000, tokens_after: 40_000, estimated: false },
      models: [
        { name: "claude-opus-4-8", sessions: 7 },
        { name: "other", sessions: 2 },
      ],
      tokens: { input: 900_000, cache_read: 4_000_000, cache_creation: 200_000, output: 80_000 },
      review: { runs: 4 },
      errors: { classes: { session_failed: 1 } },
    },
  };
}

export function sagaFixture(): SagaHeartbeat {
  return {
    schema_version: 2,
    instance_id: FIXTURE_INSTANCE_ID,
    day: FIXTURE_DAY,
    product: { name: "saga", version: "0.3.0" },
    platform: { os: "linux", arch: "x64" },
    metrics: {
      collect: { runs: 48, errors: 2 },
      refusals: 3,
      mcp: { tool_calls: 91, refusals: 4 },
      advisories: { fired: 6, by_severity: { info: 3, warn: 2, critical: 1 } },
      connections: { by_engine: { postgres: 2, mysql: 1, sqlite: 1 }, total: 5 },
      probe: { outcomes: { ok: 40, auth_failed: 1, unreachable: 2, timeout: 1, other: 0 } },
      uptime_bucket: "1d-7d",
    },
  };
}

export function skuldFixture(): SkuldHeartbeat {
  return {
    schema_version: 2,
    instance_id: FIXTURE_INSTANCE_ID,
    day: FIXTURE_DAY,
    product: { name: "skuld", version: "0.2.1" },
    platform: { os: "linux", arch: "arm64" },
    metrics: {
      jobs: { created_by_type: { script: 12, ai: 5, report: 2, agent_send: 1, distill: 3 } },
      runs: { total: 23, succeeded: 20, failed: 2, chain_rejections: 1 },
      events: { deferrals: 4 },
      gate: { rejections: 2, approvals: 7 },
      sandbox: { pool_exhausted: 0, uid_vends: 23 },
      detection_state: "detected",
      uptime_bucket: "30d+",
    },
  };
}

export function allFixtures(): Heartbeat[] {
  return [brokkrFixture(), sagaFixture(), skuldFixture()];
}
