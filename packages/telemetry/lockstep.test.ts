// LOCKSTEP: JSON Schema ↔ runtime validator ↔ REAL EMITTER OUTPUT, for all three products.
//
// The failure this test exists to catch, in the words of the incident that produced it: a rename
// landed in the JSON Schema and in the runtime validator, but NOT in the emitter — and the existing
// schema↔validator test could not see it, because the emitter is a third party to both. Two of
// three agreeing looks exactly like three of three agreeing when you only ever compare two.
//
// So this file asserts, deliberately, that EMITTER OUTPUT VALIDATES AGAINST THE JSON SCHEMA ITSELF
// — not merely against the hand-written validator, which could share the same misconception.
//
// It also holds the two structural guarantees that cannot be re-derived by reading the file:
//   - brokkr's ten v2 sections DEEP-EQUAL v1's, proving "ported verbatim" is still true;
//   - the model-id allowlist in code equals the enum in the schema, which is the pair that has
//     already existed twice and been hand-synced.

import { describe, expect, test } from "bun:test";
import Ajv, { type ValidateFunction } from "ajv";
import v1Schema from "./schema/heartbeat.v1.json" with { type: "json" };
import v2Schema from "./schema/heartbeat.v2.json" with { type: "json" };
import manifest from "./schema/field-classes.json" with { type: "json" };
import { MODEL_ID_ALLOWLIST, MODEL_OTHER } from "./src/model-id-allowlist.ts";
import { PRODUCT_NAMES, UPTIME_BUCKETS, DETECTION_STATES, validateHeartbeat } from "./src/envelope.ts";
import { HeartbeatEmitter } from "./src/emitter.ts";
import { IdentityStore } from "./src/identity.ts";
import { Transport } from "./src/transport.ts";
import { userConsent } from "./src/optout.ts";
import { buildBrokkrMetrics, zeroBrokkrRollup } from "./src/bodies/brokkr.ts";
import { buildSagaMetrics } from "./src/bodies/saga.ts";
import { buildSkuldMetrics } from "./src/bodies/skuld.ts";
import { normalizeDeltas } from "./src/bodies/index.ts";
import { allFixtures, brokkrFixture, sagaFixture, skuldFixture } from "./src/test-fixtures.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ajv = new Ajv({ strict: false, allErrors: true });
const schemaCheck: ValidateFunction = ajv.compile(v2Schema as object);

/** True iff the JSON Schema itself accepts the document. */
function schemaAccepts(value: unknown): boolean {
  return schemaCheck(value) === true;
}

/** True iff the hand-written runtime validator accepts the document. */
function validatorAccepts(value: unknown): boolean {
  return validateHeartbeat(value).ok;
}

// ── the three layers agree on the fixtures ─────────────────────────────────────────────────

describe("schema ↔ validator, on hand-written fixtures", () => {
  for (const fixture of allFixtures()) {
    test(`${fixture.product.name}: both layers accept`, () => {
      const errors = validateHeartbeat(fixture);
      expect(errors.ok ? [] : errors.errors).toEqual([]);
      if (!schemaAccepts(fixture)) throw new Error(JSON.stringify(schemaCheck.errors, null, 2));
    });
  }
});

// ── REAL emitter output, through the JSON Schema ───────────────────────────────────────────

function emitterPayloadFor(product: (typeof PRODUCT_NAMES)[number]): unknown {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mythical-telemetry-lockstep-"));
  const identity = new IdentityStore({ stateRoot: root });
  const transport = new Transport({ stateRoot: root });
  const common = {
    identity,
    transport,
    getConsent: () => userConsent(true, Date.parse("2026-01-01T00:00:00.000Z")),
    getEndpoints: () => ({ centralUrl: "https://telemetry.example.com" }),
    platform: { os: "linux", arch: "x64" },
    nowMs: (): number => Date.parse("2026-07-27T06:00:00.000Z"),
  };

  if (product === "brokkr") {
    const rollup = zeroBrokkrRollup();
    rollup.sessions = { count: 5, minutes: 120, failed: 1 };
    rollup.mode_split = { normal: 4, spine: 1 };
    rollup.fill = { histogram: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0], bearing: 5, avg_sum: 210 };
    rollup.models = { "claude-opus-4-8": 3, "acme-internal": 2 };
    rollup.tokens = { input: 10, cache_read: 20, cache_creation: 30, output: 40 };
    rollup.review = { runs: 2 };
    rollup.errors = { session_failed: 1 };
    rollup.spine = { joints: 1, tokens_before: 10, tokens_after: 5, estimated: true };
    return new HeartbeatEmitter<"brokkr">({
      ...common,
      product: "brokkr",
      version: "0.1.37",
      buildMetrics: () =>
        buildBrokkrMetrics({
          rollup,
          config: {
            backend: "local",
            harness_type: "claude",
            wizard_completed: true,
            team_size: 3,
            playbooks_active: 2,
            review_mode: "ephemeral",
            terminal: true,
            edges: true,
          },
        }),
    }).buildPayload("2026-07-26", identity.centralIdentity().instance_id);
  }

  if (product === "saga") {
    const { deltas } = normalizeDeltas(
      { collect_runs_total: 10, refusals_total: 1 },
      { collect_runs_total: 42, refusals_total: 1, mcp_tool_calls_total: 9, probe_ok_total: 30, advisories_fired_total: 4 },
    );
    return new HeartbeatEmitter<"saga">({
      ...common,
      product: "saga",
      version: "0.3.0",
      buildMetrics: () =>
        buildSagaMetrics({
          deltas,
          connections: [{ engine: "postgres" }, { engine: "sqlite" }, { engine: "clickhouse-prod" }],
          uptimeSeconds: 8 * 86_400,
        }),
    }).buildPayload("2026-07-26", identity.centralIdentity().instance_id);
  }

  const { deltas } = normalizeDeltas({ runs_total: 900 }, { runs_total: 7, gate_approvals: 3, "jobs_created_by_type.agent-send": 2 });
  return new HeartbeatEmitter<"skuld">({
    ...common,
    product: "skuld",
    version: "0.2.1",
    buildMetrics: () => buildSkuldMetrics({ deltas, detectionState: 1, uptimeSeconds: 60 }),
  }).buildPayload("2026-07-26", identity.centralIdentity().instance_id);
}

describe("REAL emitter output validates against the JSON SCHEMA (not just the validator)", () => {
  for (const product of PRODUCT_NAMES) {
    test(product, () => {
      const payload = emitterPayloadFor(product);
      if (!schemaAccepts(payload)) throw new Error(`${product}: ${JSON.stringify(schemaCheck.errors, null, 2)}`);
      const runtime = validateHeartbeat(payload);
      expect(runtime.ok ? [] : runtime.errors).toEqual([]);
    });
  }

  test("a body key renamed in the schema and the validator but NOT the emitter is caught", () => {
    // The exact historical failure, reproduced: the emitter still says `sessions`, so a schema
    // that has moved on rejects real output even though schema and validator agree with each other.
    const renamed = JSON.parse(JSON.stringify(v2Schema)) as {
      definitions: { brokkr_metrics: { required: string[]; properties: Record<string, unknown> } };
    };
    const brokkr = renamed.definitions.brokkr_metrics;
    brokkr.properties.session_counts = brokkr.properties.sessions;
    delete brokkr.properties.sessions;
    brokkr.required = brokkr.required.map((r) => (r === "sessions" ? "session_counts" : r));

    const drifted = new Ajv({ strict: false, allErrors: true }).compile(renamed as object);
    expect(drifted(emitterPayloadFor("brokkr"))).toBe(false);
  });
});

// ── mutation lockstep: the two validators must agree on rejections, not just acceptances ───

type Mutation = { label: string; value: unknown };

function objectPaths(value: unknown, at: string[] = [], out: string[][] = []): string[][] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  out.push(at);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) objectPaths(child, [...at, key], out);
  return out;
}

function leafPaths(value: unknown, at: string[] = [], out: string[][] = []): string[][] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) leafPaths(child, [...at, key], out);
    return out;
  }
  if (at.length > 0) out.push(at);
  return out;
}

function setAt(root: unknown, at: string[], value: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  let cursor = clone as Record<string, unknown>;
  for (const key of at.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[at.at(-1)!] = value;
  return clone;
}

function deleteAt(root: unknown, at: string[]): unknown {
  const clone = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  let cursor = clone as Record<string, unknown>;
  for (const key of at.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  delete cursor[at.at(-1)!];
  return clone;
}

function mutationsFor(fixture: unknown): Mutation[] {
  const out: Mutation[] = [];
  for (const at of objectPaths(fixture)) {
    out.push({ label: `extra key at ${at.join(".") || "$"}`, value: setAt(fixture, [...at, "smuggled_field"], "acme-prod-01") });
  }
  for (const at of leafPaths(fixture)) {
    const label = at.join(".");
    out.push({ label: `missing ${label}`, value: deleteAt(fixture, at) });
    out.push({ label: `${label} := object`, value: setAt(fixture, at, { nope: 1 }) });
    out.push({ label: `${label} := "hostname"`, value: setAt(fixture, at, "build-box-01") });
    out.push({ label: `${label} := -1`, value: setAt(fixture, at, -1) });
    out.push({ label: `${label} := null`, value: setAt(fixture, at, null) });
  }
  return out;
}

describe("mutation lockstep — the schema and the validator reject the SAME documents", () => {
  for (const fixture of allFixtures()) {
    const product = fixture.product.name;
    test(`${product}: every mutation is judged identically by both layers`, () => {
      const disagreements: string[] = [];
      for (const mutation of mutationsFor(fixture)) {
        const bySchema = schemaAccepts(mutation.value);
        const byValidator = validatorAccepts(mutation.value);
        if (bySchema !== byValidator) disagreements.push(`${mutation.label}: schema=${bySchema} validator=${byValidator}`);
      }
      expect(disagreements).toEqual([]);
    });
  }

  test("the corpus actually exercises rejection — a green run is not a vacuous one", () => {
    const total = allFixtures().flatMap((f) => mutationsFor(f));
    const rejected = total.filter((m) => !schemaAccepts(m.value));
    expect(total.length).toBeGreaterThan(200);
    expect(rejected.length).toBeGreaterThan(200);
  });
});

// ── structural guarantees ──────────────────────────────────────────────────────────────────

describe("brokkr's ten sections are v1's, VERBATIM", () => {
  const SECTIONS = ["config", "features", "sessions", "context_fill", "mode_split", "spine", "models", "tokens", "review", "errors"] as const;
  const v1 = v1Schema as unknown as { properties: Record<string, unknown> };
  const v2 = v2Schema as unknown as { definitions: { brokkr_metrics: { properties: Record<string, unknown>; required: string[] } } };

  for (const section of SECTIONS) {
    test(section, () => {
      expect(v2.definitions.brokkr_metrics.properties[section]).toEqual(v1.properties[section]);
    });
  }

  test("all ten are present and required, and nothing else is", () => {
    expect(Object.keys(v2.definitions.brokkr_metrics.properties).sort()).toEqual([...SECTIONS].sort());
    expect([...v2.definitions.brokkr_metrics.required].sort()).toEqual([...SECTIONS].sort());
  });

  test("the ONLY envelope change is daemon_version -> version", () => {
    const v1Product = (v1.properties.product as { properties: Record<string, unknown>; required: string[] }).properties;
    const v2Product = (v2Schema as unknown as { properties: { product: { properties: Record<string, unknown> } } }).properties.product
      .properties;
    expect(Object.keys(v1Product).sort()).toEqual(["daemon_version", "name"]);
    expect(Object.keys(v2Product).sort()).toEqual(["name", "version"]);
    expect((v2Product.version as { pattern: string }).pattern).toBe((v1Product.daemon_version as { pattern: string }).pattern);
  });
});

describe("closed sets in code equal closed sets in the schema", () => {
  const v2 = v2Schema as unknown as {
    properties: Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[] }> }>;
    definitions: Record<string, { properties: Record<string, { enum?: string[]; items?: { properties: { name: { enum: string[] } } } }> }>;
  };

  test("MODEL_ID_ALLOWLIST — the pair that has already existed twice and been hand-synced", () => {
    const schemaEnum = v2.definitions.brokkr_metrics!.properties.models!.items!.properties.name.enum;
    expect([...schemaEnum].sort()).toEqual([...MODEL_ID_ALLOWLIST, MODEL_OTHER].sort());
  });

  test("product.name", () => {
    expect(v2.properties.product!.properties!.name!.enum!.slice().sort()).toEqual([...PRODUCT_NAMES].sort());
  });

  test("uptime buckets, in both products that carry them", () => {
    for (const product of ["saga_metrics", "skuld_metrics"]) {
      expect(v2.definitions[product]!.properties.uptime_bucket!.enum!.slice().sort()).toEqual([...UPTIME_BUCKETS].sort());
    }
  });

  test("detection_state is a closed enum, never an integer", () => {
    const leaf = v2.definitions.skuld_metrics!.properties.detection_state!;
    expect(leaf.enum!.slice().sort()).toEqual([...DETECTION_STATES].sort());
  });
});

describe("the field-class manifest is bound to THIS schema", () => {
  const m = manifest as unknown as {
    schema_version: number;
    metrics: Record<string, Record<string, { class: string; temporal: string }>>;
    envelope: Record<string, { class: string; temporal: string }>;
  };

  test("no leaf anywhere is classed cumulative", () => {
    const every = [...Object.values(m.envelope), ...Object.values(m.metrics).flatMap((p) => Object.values(p))];
    expect(every.filter((e) => e.temporal === "cumulative")).toEqual([]);
    expect(every.every((e) => e.temporal === "delta" || e.temporal === "gauge")).toBe(true);
  });

  test("no class named opaque-id exists — gate G1b left it with no members", () => {
    const every = [...Object.values(m.envelope), ...Object.values(m.metrics).flatMap((p) => Object.values(p))];
    expect(every.filter((e) => e.class === "opaque-id")).toEqual([]);
    expect(JSON.stringify(manifest)).not.toContain('"opaque-id"');
  });

  test("it declares a body for every product the schema discriminates", () => {
    expect(Object.keys(m.metrics).sort()).toEqual([...PRODUCT_NAMES].sort());
    expect(m.schema_version).toBe(2);
  });
});

describe("no fixture or emitter output carries anything nameable", () => {
  const NAMEABLE = ["/", "\\", "@", "://", "acme", "prod-", "localhost", "SELECT ", "192.168."];

  test("emitter output for all three products is free of path/host/SQL shapes", () => {
    for (const product of PRODUCT_NAMES) {
      const serialised = JSON.stringify(emitterPayloadFor(product));
      for (const needle of NAMEABLE) {
        expect(serialised.includes(needle)).toBe(false);
      }
    }
  });

  test("even when the producer hands over hostile values", () => {
    const serialised = JSON.stringify(
      buildSagaMetrics({
        deltas: { "SELECT * FROM users": 5, collect_runs_total: 1 },
        connections: [{ engine: "postgres://alice@db.internal/prod" }],
        uptimeSeconds: 10,
      }),
    );
    expect(serialised).not.toContain("SELECT");
    expect(serialised).not.toContain("alice");
    expect(serialised).not.toContain("db.internal");
  });
});

// A cheap guard that the fixtures themselves did not rot into something the emitter cannot produce.
describe("fixtures stay representative", () => {
  test("each fixture's product matches its body shape", () => {
    expect(Object.keys(brokkrFixture().metrics)).toContain("context_fill");
    expect(Object.keys(sagaFixture().metrics)).toContain("connections");
    expect(Object.keys(skuldFixture().metrics)).toContain("detection_state");
  });
});
