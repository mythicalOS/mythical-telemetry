import { describe, expect, test } from "bun:test";
import { normalizePlatform, normalizeProductVersion, uptimeBucket, utcDayOf, validateHeartbeat } from "./envelope.ts";
import { brokkrFixture, sagaFixture, skuldFixture } from "./test-fixtures.ts";

function errorsOf(value: unknown): string[] {
  const result = validateHeartbeat(value);
  return result.ok ? [] : result.errors;
}

describe("validateHeartbeat — the canonical runtime validator", () => {
  test("accepts each product's fixture", () => {
    for (const fixture of [brokkrFixture(), sagaFixture(), skuldFixture()]) {
      const result = validateHeartbeat(fixture);
      expect(result.ok ? [] : result.errors).toEqual([]);
    }
  });

  test("rejects an UNDECLARED field at every level — this is the drop-rule", () => {
    const top = brokkrFixture() as unknown as Record<string, unknown>;
    top.hostname = "build-box-01";
    expect(errorsOf(top).join(" ")).toContain("hostname");

    const nested = brokkrFixture();
    (nested.metrics.config as unknown as Record<string, unknown>).repo_url = "git@github.com:acme/secret.git";
    expect(errorsOf(nested).join(" ")).toContain("repo_url");

    const deep = skuldFixture();
    (deep.metrics.jobs.created_by_type as unknown as Record<string, unknown>).deploy_prod = 3;
    expect(errorsOf(deep).join(" ")).toContain("deploy_prod");
  });

  test("rejects a missing required leaf", () => {
    const fixture = sagaFixture() as unknown as { metrics: Record<string, unknown> };
    delete fixture.metrics.refusals;
    expect(errorsOf(fixture).join(" ")).toContain("metrics.refusals");
  });

  test("rejects a wrong schema_version", () => {
    for (const wrong of [0, 2, "1", null, undefined]) {
      expect(errorsOf({ ...brokkrFixture(), schema_version: wrong }).join(" ")).toContain("schema_version");
    }
  });

  test("rejects an instance_id that is not the pinned UUIDv4 grammar", () => {
    for (const bad of ["", "alice-prod", "60E05BD1-B195-4F2F-9411-2FA7197A5C88", "60e05bd1b1954f2f94112fa7197a5c88"]) {
      expect(errorsOf({ ...brokkrFixture(), instance_id: bad }).join(" ")).toContain("instance_id");
    }
  });

  test("rejects a day that is not YYYY-MM-DD", () => {
    expect(errorsOf({ ...brokkrFixture(), day: "26-07-2026" }).join(" ")).toContain("day");
  });

  test("rejects a product.version outside semver-core or 'other'", () => {
    const fixture = brokkrFixture();
    fixture.product.version = "0.1.37-acme-internal";
    expect(errorsOf(fixture).join(" ")).toContain("product.version");
  });

  test("rejects an unknown product and does NOT then invent body errors", () => {
    const errors = errorsOf({ ...brokkrFixture(), product: { name: "edda", version: "1.0.0" } });
    expect(errors.join(" ")).toContain("product.name");
    expect(errors.filter((e) => e.startsWith("metrics"))).toEqual([]);
  });

  test("rejects a model id outside the closed allowlist", () => {
    const fixture = brokkrFixture();
    fixture.metrics.models = [{ name: "acme-internal-sonnet", sessions: 1 }];
    expect(errorsOf(fixture).join(" ")).toContain("models[0].name");
  });

  test("rejects a negative delta", () => {
    const fixture = sagaFixture();
    fixture.metrics.collect.runs = -1;
    expect(errorsOf(fixture).join(" ")).toContain(">= 0");
  });

  test("rejects a non-integer count", () => {
    const fixture = sagaFixture();
    fixture.metrics.collect.runs = 1.5;
    expect(errorsOf(fixture).join(" ")).toContain("metrics.collect.runs");
  });

  test("rejects an out-of-range value", () => {
    const fixture = brokkrFixture();
    fixture.metrics.sessions.count = 100_001;
    expect(errorsOf(fixture).join(" ")).toContain("metrics.sessions.count");
  });

  test("enforces the brokkr cross-field invariants JSON Schema cannot express", () => {
    const failed = brokkrFixture();
    failed.metrics.sessions.failed = failed.metrics.sessions.count + 1;
    expect(errorsOf(failed).join(" ")).toContain("sessions.count");

    const modes = brokkrFixture();
    modes.metrics.mode_split.spine = 99;
    expect(errorsOf(modes).join(" ")).toContain("mode_split");

    const hist = brokkrFixture();
    hist.metrics.context_fill.peak_histogram = [99, 99, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(errorsOf(hist).join(" ")).toContain("peak_histogram");

    const models = brokkrFixture();
    models.metrics.models = [{ name: "claude-opus-4-8", sessions: 100 }];
    expect(errorsOf(models).join(" ")).toContain("models");

    const errs = brokkrFixture();
    errs.metrics.errors.classes.session_failed = 99;
    expect(errorsOf(errs).join(" ")).toContain("errors.classes");
  });

  test("saga's connections gauge invariant holds: by_engine cannot exceed the total", () => {
    const fixture = sagaFixture();
    fixture.metrics.connections.total = 1;
    expect(errorsOf(fixture).join(" ")).toContain("by_engine");
  });

  test("does NOT assert succeeded+failed <= total: a run may straddle the UTC day boundary", () => {
    const fixture = skuldFixture();
    fixture.metrics.runs.total = 1;
    fixture.metrics.runs.succeeded = 5;
    expect(errorsOf(fixture)).toEqual([]);
  });

  test("accepts a null avg_mean and rejects an out-of-range one", () => {
    const nulled = brokkrFixture();
    nulled.metrics.context_fill.avg_mean = null;
    expect(errorsOf(nulled)).toEqual([]);

    const over = brokkrFixture();
    over.metrics.context_fill.avg_mean = 101;
    expect(errorsOf(over).join(" ")).toContain("avg_mean");
  });

  test("rejects a detection_state emitted as a raw integer", () => {
    const fixture = skuldFixture() as unknown as { metrics: Record<string, unknown> };
    fixture.metrics.detection_state = 1;
    expect(errorsOf(fixture).join(" ")).toContain("detection_state");
  });

  test("reports EVERY error, not just the first — a rejection must be actionable", () => {
    const fixture = sagaFixture() as unknown as { metrics: Record<string, unknown>; instance_id: string };
    fixture.instance_id = "nope";
    fixture.metrics.refusals = -1;
    expect(errorsOf(fixture).length).toBeGreaterThan(1);
  });

  test("rejects non-objects without throwing", () => {
    for (const bad of [null, undefined, 42, "x", [], true]) {
      expect(validateHeartbeat(bad).ok).toBe(false);
    }
  });
});

describe("normalisers", () => {
  test("normalizeProductVersion buckets anything non-semver-core to 'other'", () => {
    expect(normalizeProductVersion("1.2.3")).toBe("1.2.3");
    expect(normalizeProductVersion("0.1.37-brokkr")).toBe("other");
    expect(normalizeProductVersion("acme-build-2026")).toBe("other");
    expect(normalizeProductVersion(undefined)).toBe("other");
    expect(normalizeProductVersion("1000.0.0")).toBe("other");
  });

  test("normalizePlatform closes the enum", () => {
    expect(normalizePlatform("darwin", "arm64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(normalizePlatform("freebsd", "riscv64")).toEqual({ os: "other", arch: "other" });
  });

  test("uptimeBucket never carries the raw second count", () => {
    expect(uptimeBucket(0)).toBe("<1h");
    expect(uptimeBucket(3599)).toBe("<1h");
    expect(uptimeBucket(3600)).toBe("1h-1d");
    expect(uptimeBucket(86_400)).toBe("1d-7d");
    expect(uptimeBucket(7 * 86_400)).toBe("7d-30d");
    expect(uptimeBucket(30 * 86_400)).toBe("30d+");
    expect(uptimeBucket(Number.NaN)).toBe("<1h");
  });

  test("utcDayOf is UTC, not local", () => {
    expect(utcDayOf(Date.parse("2026-07-26T23:59:59.999Z"))).toBe("2026-07-26");
    expect(utcDayOf(Date.parse("2026-07-27T00:00:00.000Z"))).toBe("2026-07-27");
  });
});
