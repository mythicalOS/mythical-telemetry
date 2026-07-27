// The v2 envelope + THE canonical runtime validator.
//
// There is exactly ONE runtime validator in this repo and this is it. The collector imports it
// from here rather than keeping its own: the class of defect this package exists to prevent is
// client/collector drift, and two hand-maintained validators are two chances to disagree about
// what a payload means. A mismatch is silently harmful in both directions.
//
// It is hand-written rather than derived from heartbeat.v2.json ON PURPOSE — a validator generated
// from the schema could not disagree with it, so the lockstep test would prove nothing. The
// lockstep test compares this independent implementation against the JSON Schema over a corpus of
// valid documents and systematic mutations, and against real emitter output.
//
// It also carries the cross-field invariants JSON Schema cannot express (e.g. failed <= count).

import { MODEL_ID_ALLOWLIST, MODEL_OTHER } from "./model-id-allowlist.ts";

export const SCHEMA_VERSION = 2 as const;

export const PRODUCT_NAMES = ["brokkr", "saga", "skuld"] as const;
export type ProductName = (typeof PRODUCT_NAMES)[number];

export const PLATFORM_OS = ["darwin", "linux", "win32", "other"] as const;
export const PLATFORM_ARCH = ["arm64", "x64", "other"] as const;
export const UPTIME_BUCKETS = ["<1h", "1h-1d", "1d-7d", "7d-30d", "30d+"] as const;
export const DETECTION_STATES = ["unknown", "not_detected", "detected"] as const;

export type UptimeBucket = (typeof UPTIME_BUCKETS)[number];
export type DetectionState = (typeof DETECTION_STATES)[number];

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PRODUCT_VERSION_PATTERN = /^(\d{1,3}\.\d{1,3}\.\d{1,3}|other)$/;

// ── the per-product bodies ─────────────────────────────────────────────────────────────────

export interface BrokkrMetrics {
  config: {
    backend: "local" | "server";
    harness_type: "claude" | "codex" | "other";
    wizard_completed: boolean;
    team_size: number;
    playbooks_active: number;
    review_mode: "cross-model" | "ephemeral";
  };
  features: { terminal: boolean; edges: boolean };
  sessions: { count: number; minutes: number; failed: number };
  context_fill: { peak_histogram: number[]; avg_mean: number | null };
  mode_split: { normal: number; spine: number };
  spine: { joints: number; tokens_before: number; tokens_after: number; estimated: boolean };
  models: Array<{ name: string; sessions: number }>;
  tokens: { input: number; cache_read: number; cache_creation: number; output: number };
  review: { runs: number };
  /**
   * `classes` is a closed taxonomy whose members are OPTIONAL — that is how the frozen v1 section
   * is written and it is ported verbatim. Our builders always emit `session_failed`; a document
   * from elsewhere may omit it, and a consumer must read it as `?? 0` rather than assume it.
   */
  errors: { classes: { session_failed?: number } };
}

export interface SagaMetrics {
  collect: { runs: number; errors: number };
  refusals: number;
  mcp: { tool_calls: number; refusals: number };
  /**
   * `by_severity` carries exactly `{info, warn}` — the advisor's severity type has no third
   * member. A `critical` key was drafted and struck before the freeze: it would have been a
   * permanently-zero leaf with no producer.
   */
  advisories: { fired: number; by_severity: { info: number; warn: number } };
  connections: { by_engine: { postgres: number; mysql: number; sqlite: number }; total: number };
  probe: { outcomes: { ok: number; auth_failed: number; unreachable: number; timeout: number; other: number } };
  uptime_bucket: UptimeBucket;
}

export interface SkuldMetrics {
  jobs: { created_by_type: { script: number; ai: number; report: number; agent_send: number; distill: number } };
  runs: { total: number; succeeded: number; failed: number; chain_rejections: number };
  /** `approvals` counts gate ADMISSIONS — the symmetric partner of `rejections`, not grants. */
  gate: { rejections: number; approvals: number };
  /** `uid_vends` is counted at the uid POOL BOUNDARY; the pool has more than one consumer. */
  sandbox: { pool_exhausted: number; uid_vends: number };
  detection_state: DetectionState;
  uptime_bucket: UptimeBucket;
}
// There is deliberately NO `events.deferrals`: it was drafted, found to have a dead producer, and
// dropped BEFORE the freeze rather than shipped permanently zero. Adding it back is a new leaf in
// a new schema version, not an edit here.

export interface HeartbeatEnvelope<P extends ProductName, M> {
  schema_version: typeof SCHEMA_VERSION;
  instance_id: string;
  day: string;
  product: { name: P; version: string };
  platform: { os: string; arch: string };
  metrics: M;
}

export type BrokkrHeartbeat = HeartbeatEnvelope<"brokkr", BrokkrMetrics>;
export type SagaHeartbeat = HeartbeatEnvelope<"saga", SagaMetrics>;
export type SkuldHeartbeat = HeartbeatEnvelope<"skuld", SkuldMetrics>;
export type Heartbeat = BrokkrHeartbeat | SagaHeartbeat | SkuldHeartbeat;

export type ProductMetrics<P extends ProductName> = P extends "brokkr"
  ? BrokkrMetrics
  : P extends "saga"
    ? SagaMetrics
    : SkuldMetrics;

// ── validation ─────────────────────────────────────────────────────────────────────────────

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Per-leaf ceilings. Shared with the JSON Schema; the lockstep test pins them equal. */
const MAX = {
  sessions: 100_000,
  minutes: 1_000_000,
  tokens: 1_000_000_000_000,
  joints: 10_000,
  histogram: 100_000,
  count: 1_000_000_000,
  gauge: 100_000,
} as const;

class Checker {
  readonly errors: string[] = [];

  fail(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`);
  }

  /**
   * A closed object: every required key present, and NO key outside the closed set.
   *
   * `requireAll: false` keeps the key set closed while allowing a declared key to be absent. It
   * exists for one node — see `errors.classes` — where the frozen schema declares a closed
   * taxonomy with no `required` list, and tightening the runtime validator would make it reject
   * documents the schema accepts.
   */
  object(value: unknown, path: string, keys: readonly string[], opts: { requireAll?: boolean } = {}): Record<string, unknown> | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.fail(path, "expected an object");
      return undefined;
    }
    const doc = value as Record<string, unknown>;
    if (opts.requireAll !== false) {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(doc, key)) this.fail(`${path}.${key}`, "is required");
      }
    }
    for (const key of Object.keys(doc)) {
      if (!keys.includes(key)) this.fail(`${path}.${key}`, "is not a declared field — undeclared fields are rejected");
    }
    return doc;
  }

  int(value: unknown, path: string, max: number): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      this.fail(path, "expected an integer");
      return 0;
    }
    if (value < 0) this.fail(path, "must be >= 0 — a delta is never negative");
    if (value > max) this.fail(path, `must be <= ${max}`);
    return value;
  }

  bool(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") this.fail(path, "expected a boolean");
    return value === true;
  }

  enum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | undefined {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.fail(path, `expected one of ${allowed.join(" | ")}`);
      return undefined;
    }
    return value as T;
  }

  pattern(value: unknown, path: string, re: RegExp, what: string): string | undefined {
    if (typeof value !== "string" || !re.test(value)) {
      this.fail(path, `expected ${what}`);
      return undefined;
    }
    return value;
  }
}

function counts(c: Checker, doc: Record<string, unknown> | undefined, path: string, keys: readonly string[], max: number): number[] {
  const obj = c.object(doc, path, keys);
  if (obj === undefined) return keys.map(() => 0);
  return keys.map((k) => c.int(obj[k], `${path}.${k}`, max));
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function validateBrokkr(c: Checker, raw: unknown): void {
  const m = c.object(raw, "metrics", [
    "config",
    "features",
    "sessions",
    "context_fill",
    "mode_split",
    "spine",
    "models",
    "tokens",
    "review",
    "errors",
  ]);
  if (m === undefined) return;

  const config = c.object(m.config, "metrics.config", [
    "backend",
    "harness_type",
    "wizard_completed",
    "team_size",
    "playbooks_active",
    "review_mode",
  ]);
  if (config !== undefined) {
    c.enum(config.backend, "metrics.config.backend", ["local", "server"] as const);
    c.enum(config.harness_type, "metrics.config.harness_type", ["claude", "codex", "other"] as const);
    c.bool(config.wizard_completed, "metrics.config.wizard_completed");
    c.int(config.team_size, "metrics.config.team_size", MAX.sessions);
    c.int(config.playbooks_active, "metrics.config.playbooks_active", MAX.sessions);
    c.enum(config.review_mode, "metrics.config.review_mode", ["cross-model", "ephemeral"] as const);
  }

  const features = c.object(m.features, "metrics.features", ["terminal", "edges"]);
  if (features !== undefined) {
    c.bool(features.terminal, "metrics.features.terminal");
    c.bool(features.edges, "metrics.features.edges");
  }

  const sessions = c.object(m.sessions, "metrics.sessions", ["count", "minutes", "failed"]);
  let count = 0;
  let failed = 0;
  if (sessions !== undefined) {
    count = c.int(sessions.count, "metrics.sessions.count", MAX.sessions);
    c.int(sessions.minutes, "metrics.sessions.minutes", MAX.minutes);
    failed = c.int(sessions.failed, "metrics.sessions.failed", MAX.sessions);
  }
  // Cross-field: a day cannot fail more sessions than it ran.
  if (failed > count) c.fail("metrics.sessions.failed", `must be <= sessions.count (${failed} > ${count})`);

  const fill = c.object(m.context_fill, "metrics.context_fill", ["peak_histogram", "avg_mean"]);
  if (fill !== undefined) {
    const hist = fill.peak_histogram;
    if (!Array.isArray(hist) || hist.length !== 10) {
      c.fail("metrics.context_fill.peak_histogram", "expected exactly 10 decile buckets");
    } else {
      const values = hist.map((v, i) => c.int(v, `metrics.context_fill.peak_histogram[${i}]`, MAX.histogram));
      // Cross-field: spawn failures carry no fill, so the histogram cannot exceed the day's sessions.
      if (sum(values) > count) {
        c.fail("metrics.context_fill.peak_histogram", `sum must be <= sessions.count (${sum(values)} > ${count})`);
      }
    }
    const avg = fill.avg_mean;
    if (avg !== null) {
      if (typeof avg !== "number" || !Number.isFinite(avg)) c.fail("metrics.context_fill.avg_mean", "expected a number or null");
      else if (avg < 0 || avg > 100) c.fail("metrics.context_fill.avg_mean", "expected a percentage in [0,100]");
    }
  }

  const mode = c.object(m.mode_split, "metrics.mode_split", ["normal", "spine"]);
  if (mode !== undefined) {
    const normal = c.int(mode.normal, "metrics.mode_split.normal", MAX.sessions);
    const spine = c.int(mode.spine, "metrics.mode_split.spine", MAX.sessions);
    // Cross-field: every session is exactly one of the two modes.
    if (normal + spine !== count) {
      c.fail("metrics.mode_split", `normal + spine must equal sessions.count (${normal} + ${spine} !== ${count})`);
    }
  }

  const spine = c.object(m.spine, "metrics.spine", ["joints", "tokens_before", "tokens_after", "estimated"]);
  if (spine !== undefined) {
    c.int(spine.joints, "metrics.spine.joints", MAX.joints);
    c.int(spine.tokens_before, "metrics.spine.tokens_before", MAX.tokens);
    c.int(spine.tokens_after, "metrics.spine.tokens_after", MAX.tokens);
    c.bool(spine.estimated, "metrics.spine.estimated");
  }

  const models = m.models;
  if (!Array.isArray(models)) {
    c.fail("metrics.models", "expected an array");
  } else {
    if (models.length > 16) c.fail("metrics.models", "expected at most 16 entries");
    const allowed = [...MODEL_ID_ALLOWLIST, MODEL_OTHER] as const;
    let modelSessions = 0;
    models.forEach((entry, i) => {
      const e = c.object(entry, `metrics.models[${i}]`, ["name", "sessions"]);
      if (e === undefined) return;
      c.enum(e.name, `metrics.models[${i}].name`, allowed);
      modelSessions += c.int(e.sessions, `metrics.models[${i}].sessions`, MAX.sessions);
    });
    if (modelSessions > count) c.fail("metrics.models", `sum of sessions must be <= sessions.count (${modelSessions} > ${count})`);
  }

  counts(c, m.tokens as Record<string, unknown> | undefined, "metrics.tokens", ["input", "cache_read", "cache_creation", "output"], MAX.tokens);
  counts(c, m.review as Record<string, unknown> | undefined, "metrics.review", ["runs"], MAX.sessions);

  const errors = c.object(m.errors, "metrics.errors", ["classes"]);
  if (errors !== undefined) {
    // `errors.classes` is a CLOSED key taxonomy that declares no `required` list — that is how the
    // frozen v1 section is written, and it is ported verbatim. So `{}` is a valid classes object
    // and an absent class reads as zero. Requiring the key here would reject documents the schema
    // accepts, which is precisely the drift the lockstep test exists to catch.
    const classes = c.object(errors.classes, "metrics.errors.classes", ["session_failed"], { requireAll: false });
    let sessionFailed = 0;
    if (classes !== undefined && classes.session_failed !== undefined) {
      sessionFailed = c.int(classes.session_failed, "metrics.errors.classes.session_failed", MAX.sessions);
    }
    if (sessionFailed > count) {
      c.fail("metrics.errors.classes", `sum of class counts must be <= sessions.count (${sessionFailed} > ${count})`);
    }
  }
}

function validateSaga(c: Checker, raw: unknown): void {
  const m = c.object(raw, "metrics", ["collect", "refusals", "mcp", "advisories", "connections", "probe", "uptime_bucket"]);
  if (m === undefined) return;

  counts(c, m.collect as Record<string, unknown> | undefined, "metrics.collect", ["runs", "errors"], MAX.count);
  c.int(m.refusals, "metrics.refusals", MAX.count);
  counts(c, m.mcp as Record<string, unknown> | undefined, "metrics.mcp", ["tool_calls", "refusals"], MAX.count);

  const advisories = c.object(m.advisories, "metrics.advisories", ["fired", "by_severity"]);
  if (advisories !== undefined) {
    c.int(advisories.fired, "metrics.advisories.fired", MAX.count);
    // NO `sum(by_severity) <= fired` invariant, deliberately: `fired` and the per-severity
    // counters are separate counters at separate call sites, so a single mis-instrumented site
    // would make an otherwise correct day structurally invalid and lose it silently. A rejected
    // day is worse than an unchecked one.
    counts(
      c,
      advisories.by_severity as Record<string, unknown> | undefined,
      "metrics.advisories.by_severity",
      ["info", "warn"],
      MAX.count,
    );
  }

  const connections = c.object(m.connections, "metrics.connections", ["by_engine", "total"]);
  if (connections !== undefined) {
    const byEngine = counts(
      c,
      connections.by_engine as Record<string, unknown> | undefined,
      "metrics.connections.by_engine",
      ["postgres", "mysql", "sqlite"],
      MAX.gauge,
    );
    const total = c.int(connections.total, "metrics.connections.total", MAX.gauge);
    // Cross-field: an unrecognised engine is counted in the total but not emitted per family.
    if (sum(byEngine) > total) {
      c.fail("metrics.connections.by_engine", `sum must be <= connections.total (${sum(byEngine)} > ${total})`);
    }
  }

  const probe = c.object(m.probe, "metrics.probe", ["outcomes"]);
  if (probe !== undefined) {
    counts(
      c,
      probe.outcomes as Record<string, unknown> | undefined,
      "metrics.probe.outcomes",
      ["ok", "auth_failed", "unreachable", "timeout", "other"],
      MAX.count,
    );
  }

  c.enum(m.uptime_bucket, "metrics.uptime_bucket", UPTIME_BUCKETS);
}

function validateSkuld(c: Checker, raw: unknown): void {
  const m = c.object(raw, "metrics", ["jobs", "runs", "gate", "sandbox", "detection_state", "uptime_bucket"]);
  if (m === undefined) return;

  const jobs = c.object(m.jobs, "metrics.jobs", ["created_by_type"]);
  if (jobs !== undefined) {
    counts(
      c,
      jobs.created_by_type as Record<string, unknown> | undefined,
      "metrics.jobs.created_by_type",
      ["script", "ai", "report", "agent_send", "distill"],
      MAX.count,
    );
  }

  // NO cross-field invariant is asserted over runs.{total,succeeded,failed}, deliberately.
  // `total` is bumped when a run STARTS and the terminal counters when it ENDS, so a run that
  // straddles the UTC day boundary lands its start in one day's delta and its outcome in the
  // next — `succeeded + failed <= total` is genuinely false on such a day. Asserting it would
  // reject a correct payload and lose that day silently, which is worse than not checking.
  counts(c, m.runs as Record<string, unknown> | undefined, "metrics.runs", ["total", "succeeded", "failed", "chain_rejections"], MAX.count);

  counts(c, m.gate as Record<string, unknown> | undefined, "metrics.gate", ["rejections", "approvals"], MAX.count);
  counts(c, m.sandbox as Record<string, unknown> | undefined, "metrics.sandbox", ["pool_exhausted", "uid_vends"], MAX.count);

  c.enum(m.detection_state, "metrics.detection_state", DETECTION_STATES);
  c.enum(m.uptime_bucket, "metrics.uptime_bucket", UPTIME_BUCKETS);
}

/**
 * THE canonical runtime validator for a v2 heartbeat. Structural + closed-set + cross-field.
 *
 * Returns every error it finds rather than the first, so an operator's rejected payload produces
 * an actionable message instead of a guessing game.
 */
export function validateHeartbeat(value: unknown): ValidationResult<Heartbeat> {
  const c = new Checker();
  const doc = c.object(value, "$", ["schema_version", "instance_id", "day", "product", "platform", "metrics"]);
  if (doc === undefined) return { ok: false, errors: c.errors };

  if (doc.schema_version !== SCHEMA_VERSION) c.fail("schema_version", `expected the constant ${SCHEMA_VERSION}`);
  c.pattern(doc.instance_id, "instance_id", INSTANCE_ID_PATTERN, "a lowercase UUIDv4-form instance id");
  c.pattern(doc.day, "day", DAY_PATTERN, "a YYYY-MM-DD UTC day");

  const product = c.object(doc.product, "product", ["name", "version"]);
  const name = product === undefined ? undefined : c.enum(product.name, "product.name", PRODUCT_NAMES);
  if (product !== undefined) {
    c.pattern(product.version, "product.version", PRODUCT_VERSION_PATTERN, 'strict semver-core or the literal "other"');
  }

  const platform = c.object(doc.platform, "platform", ["os", "arch"]);
  if (platform !== undefined) {
    c.enum(platform.os, "platform.os", PLATFORM_OS);
    c.enum(platform.arch, "platform.arch", PLATFORM_ARCH);
  }

  if (name === "brokkr") validateBrokkr(c, doc.metrics);
  else if (name === "saga") validateSaga(c, doc.metrics);
  else if (name === "skuld") validateSkuld(c, doc.metrics);
  // name === undefined: product.name already failed; the body is undiscriminatable, so do not
  // guess a branch — guessing would report a wall of misleading body errors.

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, value: value as Heartbeat };
}

/** True iff the value is a valid v2 heartbeat. */
export function isHeartbeat(value: unknown): value is Heartbeat {
  return validateHeartbeat(value).ok;
}

/** Strict semver-core, else the literal "other". No org-nameable space reaches the wire. */
export function normalizeProductVersion(version: string | undefined | null): string {
  return typeof version === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version) ? version : "other";
}

/** Fold an open platform string into the closed enum. */
export function normalizePlatform(os: string, arch: string): { os: string; arch: string } {
  return {
    os: (PLATFORM_OS as readonly string[]).includes(os) && os !== "other" ? os : "other",
    arch: (PLATFORM_ARCH as readonly string[]).includes(arch) && arch !== "other" ? arch : "other",
  };
}

/** The UTC calendar day of a timestamp, as `YYYY-MM-DD`. */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Coarse, non-reversible uptime bucket. The raw second count never reaches the wire. */
export function uptimeBucket(uptimeSeconds: number): UptimeBucket {
  const s = Number.isFinite(uptimeSeconds) && uptimeSeconds > 0 ? uptimeSeconds : 0;
  if (s < 3600) return "<1h";
  if (s < 86_400) return "1h-1d";
  if (s < 7 * 86_400) return "1d-7d";
  if (s < 30 * 86_400) return "7d-30d";
  return "30d+";
}
