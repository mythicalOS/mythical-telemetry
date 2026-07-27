// Negative tests for the CI check itself. A check nobody has watched fail is a check nobody knows
// works: every rule below is exercised by breaking the schema or the manifest in a temp copy and
// asserting a non-zero exit with the message an author would actually need.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "check-field-classes.ts");
const SCHEMA_DIR = path.join(HERE, "..", "schema");

type Json = Record<string, unknown>;

function runCheck(mutate: (schema: Json, manifest: Json) => void): { code: number; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mythical-telemetry-check-"));
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "heartbeat.v2.json"), "utf8")) as Json;
  const manifest = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "field-classes.json"), "utf8")) as Json;
  mutate(schema, manifest);
  fs.writeFileSync(path.join(dir, "heartbeat.v2.json"), JSON.stringify(schema, null, 2));
  fs.writeFileSync(path.join(dir, "field-classes.json"), JSON.stringify(manifest, null, 2));

  const result = Bun.spawnSync(["bun", "run", SCRIPT], {
    env: { ...process.env, TELEMETRY_SCHEMA_DIR: dir },
  });
  return {
    code: result.exitCode ?? 1,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  };
}

function sagaBody(schema: Json): Json {
  return ((schema.definitions as Json).saga_metrics as Json).properties as Json as Json;
}

describe("check-field-classes", () => {
  test("passes on the real schema and manifest", () => {
    const { code, output } = runCheck(() => {});
    expect(code).toBe(0);
    expect(output).toContain("OK");
    // It must never be read as a privacy guarantee, so it says so on success too.
    expect(output).toContain("SHAPE, not privacy");
  });

  test("FAILS when a schema leaf has no manifest entry", () => {
    const { code, output } = runCheck((schema) => {
      (sagaBody(schema) as Json).new_counter = { type: "integer", minimum: 0, maximum: 100 };
      ((schema.definitions as Json).saga_metrics as Json).required = [
        ...(((schema.definitions as Json).saga_metrics as Json).required as string[]),
        "new_counter",
      ];
    });
    expect(code).toBe(1);
    expect(output).toContain("new_counter");
    expect(output).toContain("NO field-class manifest entry");
  });

  test("FAILS when a manifest entry has no schema leaf (a rename left it behind)", () => {
    const { code, output } = runCheck((_schema, manifest) => {
      ((manifest.metrics as Json).saga as Json).ghost_counter = { class: "count", temporal: "delta" };
    });
    expect(code).toBe(1);
    expect(output).toContain("ghost_counter");
    expect(output).toContain("no corresponding schema leaf");
  });

  test("FAILS on temporal: cumulative — with an explanation, not just a code", () => {
    const { code, output } = runCheck((_schema, manifest) => {
      ((manifest.metrics as Json).saga as Json)["collect.runs"] = { class: "count", temporal: "cumulative" };
    });
    expect(code).toBe(1);
    expect(output).toContain("cumulative");
    expect(output).toContain("FORBIDDEN");
  });

  test("FAILS on an unknown temporal class", () => {
    const { code } = runCheck((_schema, manifest) => {
      ((manifest.metrics as Json).saga as Json)["collect.runs"] = { class: "count", temporal: "weekly" };
    });
    expect(code).toBe(1);
  });

  test("FAILS on a class outside the vocabulary — including a reintroduced opaque-id", () => {
    const { code, output } = runCheck((_schema, manifest) => {
      ((manifest.metrics as Json).saga as Json)["collect.runs"] = { class: "opaque-id", temporal: "gauge" };
    });
    expect(code).toBe(1);
    expect(output).toContain("opaque-id");
  });

  test("FAILS on an UNCONSTRAINED string leaf — the shape a name would arrive in", () => {
    const { code, output } = runCheck((schema, manifest) => {
      (sagaBody(schema) as Json).probe_error = { type: "string" };
      ((schema.definitions as Json).saga_metrics as Json).required = [
        ...(((schema.definitions as Json).saga_metrics as Json).required as string[]),
        "probe_error",
      ];
      ((manifest.metrics as Json).saga as Json).probe_error = { class: "enum", temporal: "gauge" };
    });
    expect(code).toBe(1);
    expect(output).toContain("probe_error");
    expect(output).toContain("not fenced");
  });

  test("FAILS on a string fenced only by an UNBOUNDED pattern", () => {
    const { code, output } = runCheck((schema, manifest) => {
      (sagaBody(schema) as Json).label = { type: "string", pattern: "^[a-z]+$" };
      ((schema.definitions as Json).saga_metrics as Json).required = [
        ...(((schema.definitions as Json).saga_metrics as Json).required as string[]),
        "label",
      ];
      ((manifest.metrics as Json).saga as Json).label = { class: "bucket", temporal: "gauge" };
    });
    expect(code).toBe(1);
    expect(output).toContain("label");
  });

  test("FAILS when an object permits open-ended keys", () => {
    const { code, output } = runCheck((schema) => {
      (((schema.definitions as Json).saga_metrics as Json).properties as Json).collect = {
        type: "object",
        additionalProperties: true,
        required: ["runs", "errors"],
        properties: {
          runs: { type: "integer", minimum: 0, maximum: 10 },
          errors: { type: "integer", minimum: 0, maximum: 10 },
        },
      };
    });
    expect(code).toBe(1);
    expect(output).toContain("additionalProperties:false");
  });

  test("FAILS on patternProperties — an open key map in disguise", () => {
    const { code, output } = runCheck((schema) => {
      const collect = (((schema.definitions as Json).saga_metrics as Json).properties as Json).collect as Json;
      collect.patternProperties = { "^x_": { type: "integer" } };
    });
    expect(code).toBe(1);
    expect(output).toContain("patternProperties");
  });

  test("FAILS when a delta leaf is not floored at zero", () => {
    const { code, output } = runCheck((schema) => {
      const runs = ((((schema.definitions as Json).saga_metrics as Json).properties as Json).collect as Json).properties as Json;
      (runs.runs as Json).minimum = -1;
    });
    expect(code).toBe(1);
    expect(output).toContain("minimum: 0");
  });

  test("FAILS when a delta leaf declares no minimum at all", () => {
    const { code } = runCheck((schema) => {
      const runs = ((((schema.definitions as Json).saga_metrics as Json).properties as Json).collect as Json).properties as Json;
      delete (runs.runs as Json).minimum;
    });
    expect(code).toBe(1);
  });

  test("FAILS when the metrics placeholder grows constraints (a leaf declared in two places)", () => {
    const { code, output } = runCheck((schema) => {
      ((schema.properties as Json).metrics as Json).additionalProperties = false;
    });
    expect(code).toBe(1);
    expect(output).toContain("placeholder");
  });

  test("FAILS when a oneOf branch stops pinning its product's body", () => {
    const { code, output } = runCheck((schema) => {
      const branches = schema.oneOf as Json[];
      ((branches[0]!.properties as Json).metrics as Json).$ref = "#/definitions/saga_metrics";
    });
    expect(code).toBe(1);
    expect(output).toContain("brokkr");
  });

  test("FAILS when the manifest describes a different schema version", () => {
    const { code, output } = runCheck((_schema, manifest) => {
      manifest.schema_version = 3;
    });
    expect(code).toBe(1);
    expect(output).toContain("schema_version");
  });

  test("FAILS when a reserved leaf's pinned grammar is loosened", () => {
    const { code, output } = runCheck((schema) => {
      ((schema.properties as Json).instance_id as Json).pattern = "^.{1,64}$";
    });
    expect(code).toBe(1);
    expect(output).toContain("instance_id");
  });

  test("FAILS when nullability is undeclared", () => {
    const { code, output } = runCheck((_schema, manifest) => {
      delete ((manifest.metrics as Json).brokkr as Json)["context_fill.avg_mean"];
      ((manifest.metrics as Json).brokkr as Json)["context_fill.avg_mean"] = { class: "ratio", temporal: "delta" };
    });
    expect(code).toBe(1);
    expect(output).toContain("nullable");
  });
});
