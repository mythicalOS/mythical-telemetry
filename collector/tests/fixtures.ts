// Test fixtures + THE TEST DOUBLE VALIDATOR.
//
// ─────────────────────────────────────────────────────────────────────────
//  READ THIS BEFORE COPYING ANYTHING OUT OF THIS FILE
//
//  `StubValidator` below is a TEST DOUBLE. It is not the heartbeat contract,
//  it is not authoritative about any field, and it must never be promoted
//  into `src/`. The one real validator lives in the published client package
//  and is injected — see src/validator.ts. A second real validator in this
//  repository is precisely the drift the repository exists to prevent.
//
//  The double exists to exercise the COLLECTOR: that it rejects what its
//  validator rejects, stores what its validator accepts, and never reaches
//  around it. It deliberately implements only as much shape as those
//  behaviours need.
// ─────────────────────────────────────────────────────────────────────────

import { uuidFromSecret } from '../src/identity';
import type { Heartbeat, HeartbeatValidator, ValidationResult } from '../src/validator';

export const SECRET_A = 'a'.repeat(64);
export const SECRET_B = 'b'.repeat(64);
export const SECRET_C = 'c'.repeat(64);
export const INSTANCE_A = uuidFromSecret(SECRET_A);
export const INSTANCE_B = uuidFromSecret(SECRET_B);
export const INSTANCE_C = uuidFromSecret(SECRET_C);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER_CORE_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Section names each product's `metrics` object must carry, exactly. */
const METRIC_SECTIONS: Record<string, readonly string[]> = {
  brokkr: [
    'config', 'features', 'sessions', 'context_fill', 'mode_split',
    'spine', 'models', 'tokens', 'review', 'errors',
  ],
  saga: ['collect', 'refusals', 'mcp', 'advisories', 'connections', 'probe', 'uptime_bucket'],
  skuld: ['jobs', 'runs', 'events', 'gate', 'sandbox', 'detection_state', 'uptime_bucket'],
};

const ENVELOPE_KEYS = ['schema_version', 'instance_id', 'day', 'product', 'platform', 'metrics'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sameKeys(obj: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(obj);
  if (keys.length !== expected.length) return false;
  return expected.every((k) => Object.hasOwn(obj, k));
}

/** A stand-in for the canonical v2 validator. See the banner above. */
export class StubValidator implements HeartbeatValidator {
  validate(raw: unknown): ValidationResult {
    if (!isObj(raw)) return { ok: false, error: 'not_an_object' };
    if (!sameKeys(raw, ENVELOPE_KEYS)) return { ok: false, error: 'envelope_keys' };
    if (raw['schema_version'] !== 2) return { ok: false, error: 'schema_version' };

    const instanceId = raw['instance_id'];
    if (typeof instanceId !== 'string' || !UUID_RE.test(instanceId)) return { ok: false, error: 'instance_id' };

    const day = raw['day'];
    if (typeof day !== 'string' || !DAY_RE.test(day)) return { ok: false, error: 'day' };

    const product = raw['product'];
    if (!isObj(product) || !sameKeys(product, ['name', 'version'])) return { ok: false, error: 'product' };
    const name = product['name'];
    const version = product['version'];
    if (typeof name !== 'string' || !Object.hasOwn(METRIC_SECTIONS, name)) return { ok: false, error: 'product_name' };
    if (typeof version !== 'string' || !(version === 'other' || SEMVER_CORE_RE.test(version))) {
      return { ok: false, error: 'product_version' };
    }

    const platform = raw['platform'];
    if (!isObj(platform) || !sameKeys(platform, ['os', 'arch'])) return { ok: false, error: 'platform' };
    if (!['darwin', 'linux', 'win32', 'other'].includes(String(platform['os']))) return { ok: false, error: 'os' };
    if (!['arm64', 'x64', 'other'].includes(String(platform['arch']))) return { ok: false, error: 'arch' };

    const metrics = raw['metrics'];
    const sections = METRIC_SECTIONS[name];
    if (!isObj(metrics) || !sections || !sameKeys(metrics, sections)) return { ok: false, error: 'metrics' };

    return {
      ok: true,
      value: {
        schema_version: 2,
        instance_id: instanceId,
        day,
        product: { name, version },
        platform: { os: String(platform['os']), arch: String(platform['arch']) },
        metrics,
      },
    };
  }
}

/** A validator that always accepts — used to prove the collector's own guards fire. */
export class AlwaysOkValidator implements HeartbeatValidator {
  constructor(private readonly value: Heartbeat) {}
  validate(): ValidationResult {
    return { ok: true, value: this.value };
  }
}

/** A validator that throws — the collector must turn that into a rejection, not a 500. */
export class ThrowingValidator implements HeartbeatValidator {
  validate(): ValidationResult {
    throw new Error('boom');
  }
}

// ---- payload builders ----

export function brokkrMetrics(): Record<string, unknown> {
  return {
    config: {
      backend: 'local',
      harness_type: 'claude',
      wizard_completed: true,
      team_size: 3,
      playbooks_active: 3,
      review_mode: 'cross-model',
    },
    features: { terminal: false, edges: true },
    sessions: { count: 12, minutes: 340, failed: 1 },
    context_fill: { peak_histogram: [0, 0, 1, 2, 4, 3, 1, 1, 0, 0], avg_mean: 46.2 },
    mode_split: { normal: 9, spine: 3 },
    spine: { joints: 3, tokens_before: 412000, tokens_after: 61000, estimated: false },
    models: [
      { name: 'claude-sonnet-5', sessions: 9 },
      { name: 'claude-fable-5', sessions: 3 },
    ],
    tokens: { input: 1200000, cache_read: 9100000, cache_creation: 240000, output: 380000 },
    review: { runs: 0 },
    errors: { classes: { session_failed: 1 } },
  };
}

export function sagaMetrics(): Record<string, unknown> {
  return {
    collect: { runs: 40, errors: 2 },
    refusals: 1,
    mcp: { tool_calls: 130, refusals: 3 },
    advisories: { fired: 5, by_severity: { info: 3, warn: 1, critical: 1 } },
    connections: { total: 4, by_engine: { postgres: 2, mysql: 1, sqlite: 1 } },
    probe: { outcomes: { ok: 90, auth_failed: 0, unreachable: 1, timeout: 0, other: 0 } },
    uptime_bucket: '1d-7d',
  };
}

export function skuldMetrics(): Record<string, unknown> {
  return {
    jobs: { created_by_type: { script: 4, ai: 2, report: 1, agent_send: 0, distill: 0 } },
    runs: { total: 20, succeeded: 18, failed: 2, chain_rejections: 0 },
    events: { deferrals: 3 },
    gate: { rejections: 1, approvals: 7 },
    sandbox: { pool_exhausted: 0, uid_vends: 12 },
    detection_state: 'healthy',
    uptime_bucket: '7d-30d',
  };
}

const METRIC_BUILDERS: Record<string, () => Record<string, unknown>> = {
  brokkr: brokkrMetrics,
  saga: sagaMetrics,
  skuld: skuldMetrics,
};

/** A valid v2 heartbeat for any product. */
export function makeV2(
  product: 'brokkr' | 'saga' | 'skuld' = 'brokkr',
  instanceId: string = INSTANCE_A,
  day = '2026-07-09',
): Record<string, any> {
  const build = METRIC_BUILDERS[product];
  if (!build) throw new Error(`no metrics builder for ${product}`);
  return {
    schema_version: 2,
    instance_id: instanceId,
    day,
    product: { name: product, version: '0.1.0' },
    platform: { os: 'darwin', arch: 'arm64' },
    metrics: build(),
  };
}

/**
 * A valid v1 heartbeat — the pre-v2 wire shape, brokkr-only: sections at the
 * top level, and `product.daemon_version` rather than `product.version`.
 */
export function makeV1(instanceId: string = INSTANCE_A, day = '2026-07-09'): Record<string, any> {
  return {
    schema_version: 1,
    instance_id: instanceId,
    day,
    product: { name: 'brokkr', daemon_version: '0.1.0' },
    platform: { os: 'darwin', arch: 'arm64' },
    ...brokkrMetrics(),
  };
}
