import { describe, expect, test } from "bun:test";
import { normalizeDeltas } from "./index.ts";
import { buildBrokkrMetrics, zeroBrokkrRollup, type BrokkrConfigView } from "./brokkr.ts";
import { buildSagaMetrics } from "./saga.ts";
import { buildSkuldMetrics, toDetectionState } from "./skuld.ts";
import { validateHeartbeat } from "../envelope.ts";
import { FIXTURE_DAY, FIXTURE_INSTANCE_ID } from "../test-fixtures.ts";

describe("normalizeDeltas", () => {
  test("FIRST RUN (no prior snapshot): emits the CURRENT value and records the snapshot", () => {
    const result = normalizeDeltas(undefined, { runs_total: 110, runs_failed: 4 });
    expect(result.firstRun).toBe(true);
    expect(result.deltas).toEqual({ runs_total: 110, runs_failed: 4 });
    expect(result.snapshot).toEqual({ runs_total: 110, runs_failed: 4 });
    expect(result.restarted).toEqual([]);
  });

  test("steady state: emits today minus yesterday", () => {
    const result = normalizeDeltas({ runs_total: 100 }, { runs_total: 110 });
    expect(result.deltas.runs_total).toBe(10);
    expect(result.snapshot.runs_total).toBe(110);
    expect(result.firstRun).toBe(false);
  });

  test("RESTART (counter went backwards): emits the NEW value, never a negative", () => {
    const result = normalizeDeltas({ runs_total: 100, runs_failed: 9 }, { runs_total: 7, runs_failed: 0 });
    expect(result.deltas).toEqual({ runs_total: 7, runs_failed: 0 });
    expect(result.restarted.sort()).toEqual(["runs_failed", "runs_total"]);
    for (const value of Object.values(result.deltas)) expect(value).toBeGreaterThanOrEqual(0);
  });

  test("a counter that is newly instrumented is first-run for that counter alone", () => {
    const result = normalizeDeltas({ runs_total: 100 }, { runs_total: 105, gate_approvals: 12 });
    expect(result.deltas).toEqual({ runs_total: 5, gate_approvals: 12 });
    expect(result.restarted).toEqual([]);
  });

  test("an unchanged counter emits zero, not its lifetime value", () => {
    expect(normalizeDeltas({ runs_total: 100 }, { runs_total: 100 }).deltas.runs_total).toBe(0);
  });

  test("a counter that disappeared from the current reading is simply not emitted", () => {
    const result = normalizeDeltas({ runs_total: 100, gone: 5 }, { runs_total: 101 });
    expect(Object.keys(result.deltas)).toEqual(["runs_total"]);
    expect(result.snapshot.gone).toBeUndefined();
  });

  test("garbage readings sanitise to zero rather than poisoning the wire", () => {
    const result = normalizeDeltas({ a: 0 }, {
      a: Number.NaN,
      b: Number.POSITIVE_INFINITY,
      c: -5,
      d: 3.7,
    } as unknown as Record<string, number>);
    expect(result.deltas).toEqual({ a: 0, b: 0, c: 0, d: 3 });
  });

  test("three days of a lifetime counter sum to the real total, not the running-sum trap", () => {
    // 100 -> 105 -> 110 must yield deltas summing to 10, not 315.
    let prior: Record<string, number> | undefined = { runs_total: 100 };
    const emitted: number[] = [];
    for (const lifetime of [105, 110]) {
      const step = normalizeDeltas(prior, { runs_total: lifetime });
      emitted.push(step.deltas.runs_total!);
      prior = step.snapshot;
    }
    expect(emitted.reduce((a, b) => a + b, 0)).toBe(10);
  });
});

const CONFIG: BrokkrConfigView = {
  backend: "local",
  harness_type: "claude",
  wizard_completed: true,
  team_size: 4,
  playbooks_active: 2,
  review_mode: "cross-model",
  terminal: true,
  edges: false,
};

function wrap(product: "brokkr" | "saga" | "skuld", metrics: unknown): unknown {
  return {
    schema_version: 2,
    instance_id: FIXTURE_INSTANCE_ID,
    day: FIXTURE_DAY,
    product: { name: product, version: "1.0.0" },
    platform: { os: "linux", arch: "x64" },
    metrics,
  };
}

describe("buildBrokkrMetrics", () => {
  test("a quiet day still produces a valid body", () => {
    const result = validateHeartbeat(wrap("brokkr", buildBrokkrMetrics({ rollup: undefined, config: CONFIG })));
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  test("buckets an unlisted model id to 'other' — an org-named model never reaches the wire", () => {
    const rollup = zeroBrokkrRollup();
    rollup.sessions = { count: 3, minutes: 10, failed: 0 };
    rollup.mode_split = { normal: 3, spine: 0 };
    rollup.models = { "acme-internal-sonnet": 2, "claude-opus-4-8": 1 };
    const body = buildBrokkrMetrics({ rollup, config: CONFIG });
    expect(body.models.map((m) => m.name).sort()).toEqual(["claude-opus-4-8", "other"]);
    expect(validateHeartbeat(wrap("brokkr", body)).ok).toBe(true);
  });

  test("clamps and floors hostile numbers instead of shipping them", () => {
    const rollup = zeroBrokkrRollup();
    rollup.sessions = { count: 10 ** 9, minutes: -5, failed: 10 ** 9 };
    rollup.mode_split = { normal: 100_000, spine: 0 };
    const body = buildBrokkrMetrics({ rollup, config: CONFIG });
    expect(body.sessions.count).toBe(100_000);
    expect(body.sessions.minutes).toBe(0);
    expect(body.sessions.failed).toBe(100_000);
    expect(validateHeartbeat(wrap("brokkr", body)).ok).toBe(true);
  });

  test("an unknown harness folds to 'other'", () => {
    const body = buildBrokkrMetrics({ rollup: undefined, config: { ...CONFIG, harness_type: "acme-harness" } });
    expect(body.config.harness_type).toBe("other");
  });

  test("avg_mean is null when no session bore fill, and a bounded percentage otherwise", () => {
    expect(buildBrokkrMetrics({ rollup: undefined, config: CONFIG }).context_fill.avg_mean).toBeNull();
    const rollup = zeroBrokkrRollup();
    rollup.sessions = { count: 2, minutes: 1, failed: 0 };
    rollup.mode_split = { normal: 2, spine: 0 };
    rollup.fill = { histogram: [0, 0, 0, 0, 1, 1, 0, 0, 0, 0], bearing: 2, avg_sum: 91 };
    expect(buildBrokkrMetrics({ rollup, config: CONFIG }).context_fill.avg_mean).toBe(45.5);
  });
});

describe("buildSagaMetrics", () => {
  test("shapes deltas and gauges into a valid body", () => {
    const body = buildSagaMetrics({
      deltas: { collect_runs_total: 10, mcp_tool_calls_total: 3, advisories_fired_total: 2, advisories_fired_warn_total: 2 },
      connections: [{ engine: "postgres" }, { engine: "postgres" }, { engine: "sqlite" }],
      uptimeSeconds: 90_000,
    });
    expect(body.collect.runs).toBe(10);
    expect(body.connections).toEqual({ by_engine: { postgres: 2, mysql: 0, sqlite: 1 }, total: 3 });
    expect(body.uptime_bucket).toBe("1d-7d");
    // by_severity has exactly TWO members — a third was struck before the freeze because the
    // advisor has no such severity, and a leaf with no producer ships zero forever.
    expect(body.advisories.by_severity).toEqual({ info: 0, warn: 2 });
    expect(Object.keys(body.advisories.by_severity)).toEqual(["info", "warn"]);
    expect(validateHeartbeat(wrap("saga", body)).ok).toBe(true);
  });

  test("an UNRECOGNISED engine is counted in the total and never named", () => {
    const body = buildSagaMetrics({
      deltas: {},
      connections: [{ engine: "postgres" }, { engine: "acme-warehouse-prod" }],
      uptimeSeconds: 10,
    });
    expect(body.connections.total).toBe(2);
    expect(body.connections.by_engine).toEqual({ postgres: 1, mysql: 0, sqlite: 0 });
    expect(JSON.stringify(body)).not.toContain("acme");
    expect(validateHeartbeat(wrap("saga", body)).ok).toBe(true);
  });

  test("a counter this build does not produce reads as zero, never undefined", () => {
    const body = buildSagaMetrics({ deltas: {}, connections: [], uptimeSeconds: 0 });
    expect(body.probe.outcomes).toEqual({ ok: 0, auth_failed: 0, unreachable: 0, timeout: 0, other: 0 });
    expect(validateHeartbeat(wrap("saga", body)).ok).toBe(true);
  });

  test("the connections gauge invariant survives an absurd registry", () => {
    const many = Array.from({ length: 250_000 }, () => ({ engine: "postgres" }));
    const body = buildSagaMetrics({ deltas: {}, connections: many, uptimeSeconds: 0 });
    expect(body.connections.total).toBe(100_000);
    expect(body.connections.by_engine.postgres).toBeLessThanOrEqual(body.connections.total);
    expect(validateHeartbeat(wrap("saga", body)).ok).toBe(true);
  });
});

describe("buildSkuldMetrics", () => {
  test("shapes deltas into a valid body and normalises the hyphenated job-type key", () => {
    const body = buildSkuldMetrics({
      deltas: { "jobs_created_by_type.agent-send": 4, runs_total: 9, gate_approvals: 2, rate_limit_merged: 6, event_runs_enqueued: 11 },
      detectionState: 1,
      uptimeSeconds: 40 * 86_400,
    });
    expect(body.jobs.created_by_type.agent_send).toBe(4);
    // The local counter name predates the wire name; the wire leaf says what it counts.
    expect(body.events).toEqual({ runs_enqueued: 11, asks_delivered: 0, rate_limit_deferred: 6, route_errors: 0 });
    expect(body.detection_state).toBe("detected");
    expect(body.uptime_bucket).toBe("30d+");
    expect(validateHeartbeat(wrap("skuld", body)).ok).toBe(true);
  });

  test("detection_state is a closed enum, and an unknown gauge is 'unknown' rather than a guess", () => {
    expect(toDetectionState(1)).toBe("detected");
    expect(toDetectionState(0)).toBe("not_detected");
    expect(toDetectionState(undefined)).toBe("unknown");
    expect(toDetectionState(null)).toBe("unknown");
    expect(toDetectionState(7)).toBe("unknown");
  });

  test("a first-run install emits its lifetime counters and still validates", () => {
    const { deltas } = normalizeDeltas(undefined, { runs_total: 100_000, runs_succeeded: 99_000 });
    const body = buildSkuldMetrics({ deltas, detectionState: 0, uptimeSeconds: 5 });
    expect(body.runs.total).toBe(100_000);
    expect(validateHeartbeat(wrap("skuld", body)).ok).toBe(true);
  });

  test("a restart day emits the post-restart value and still validates", () => {
    const { deltas } = normalizeDeltas({ runs_total: 100_000 }, { runs_total: 3 });
    const body = buildSkuldMetrics({ deltas, detectionState: 0, uptimeSeconds: 5 });
    expect(body.runs.total).toBe(3);
    expect(validateHeartbeat(wrap("skuld", body)).ok).toBe(true);
  });
});

describe("the brokkr builder never emits a document it knows will be rejected", () => {
  test("at the session ceiling, mode_split still partitions sessions.count exactly", () => {
    const rollup = zeroBrokkrRollup();
    rollup.sessions = { count: 100_001, minutes: 10, failed: 0 };
    rollup.mode_split = { normal: 100_000, spine: 1 }; // each survives its own clamp; the sum does not
    const body = buildBrokkrMetrics({ rollup, config: CONFIG });
    expect(body.mode_split.normal + body.mode_split.spine).toBe(body.sessions.count);
    expect(validateHeartbeat(wrap("brokkr", body)).ok).toBe(true);
  });

  test("an inconsistent fold is reconciled rather than shipped and dropped", () => {
    const rollup = zeroBrokkrRollup();
    rollup.sessions = { count: 5, minutes: 10, failed: 99 };
    rollup.mode_split = { normal: 2, spine: 1 }; // does not add up to count
    const body = buildBrokkrMetrics({ rollup, config: CONFIG });
    expect(body.mode_split.normal + body.mode_split.spine).toBe(body.sessions.count);
    expect(body.sessions.failed).toBeLessThanOrEqual(body.sessions.count);
    expect(validateHeartbeat(wrap("brokkr", body)).ok).toBe(true);
  });

  test("the histogram cannot outrun sessions.count", () => {
    const rollup = zeroBrokkrRollup();
    rollup.sessions = { count: 3, minutes: 1, failed: 0 };
    rollup.mode_split = { normal: 3, spine: 0 };
    rollup.fill = { histogram: [100_000, 100_000, 0, 0, 0, 0, 0, 0, 0, 0], bearing: 3, avg_sum: 60 };
    const body = buildBrokkrMetrics({ rollup, config: CONFIG });
    expect(body.context_fill.peak_histogram.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(body.sessions.count);
    expect(body.context_fill.peak_histogram).toHaveLength(10);
    expect(validateHeartbeat(wrap("brokkr", body)).ok).toBe(true);
  });

  test("model sessions cannot outrun sessions.count, and the budget goes to the dominant models", () => {
    const rollup = zeroBrokkrRollup();
    rollup.sessions = { count: 4, minutes: 1, failed: 0 };
    rollup.mode_split = { normal: 4, spine: 0 };
    rollup.models = { "claude-opus-4-8": 10, "gpt-5": 7, o3: 1 };
    const body = buildBrokkrMetrics({ rollup, config: CONFIG });
    expect(body.models.reduce((n, m) => n + m.sessions, 0)).toBeLessThanOrEqual(body.sessions.count);
    expect(body.models[0]!.name).toBe("claude-opus-4-8");
    expect(validateHeartbeat(wrap("brokkr", body)).ok).toBe(true);
  });

  test("a fuzz of hostile rollups always produces a document the validator accepts", () => {
    let seed = 1337;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 400; i++) {
      const rollup = zeroBrokkrRollup();
      rollup.sessions = { count: rand(200_000), minutes: rand(2_000_000), failed: rand(200_000) };
      rollup.mode_split = { normal: rand(200_000), spine: rand(200_000) };
      rollup.fill = {
        histogram: Array.from({ length: 10 }, () => rand(200_000)),
        bearing: rand(1000),
        avg_sum: rand(100_000),
      };
      rollup.models = { "claude-opus-4-8": rand(200_000), "gpt-5": rand(200_000), unknown_model: rand(200_000) };
      rollup.errors = { session_failed: rand(200_000) };
      const result = validateHeartbeat(wrap("brokkr", buildBrokkrMetrics({ rollup, config: CONFIG })));
      if (!result.ok) throw new Error(`iteration ${i}: ${result.errors.join("; ")}`);
    }
  });
});
