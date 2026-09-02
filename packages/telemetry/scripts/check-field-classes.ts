#!/usr/bin/env bun
//
// check-field-classes.ts — the CI gate over schema/heartbeat.v1.json + schema/field-classes.json.
//
// WHAT THIS ENFORCES: SHAPE. NOT PRIVACY. Read that again before adding a field.
//
// This check can prove that every leaf declares a value class and a temporal class, that no leaf
// is classed `cumulative`, that strings are closed enums or bounded version/bucket grammars, that
// no object accepts open-ended keys, and that every delta leaf is floored at zero. It CANNOT tell
// a privacy-safe count from a privacy-hostile one: `metrics.database_oid: integer` classed
// `count` + `delta` satisfies every rule in this file and would ship. So would
// `metrics.probe_error` if someone gave it an enum of "error strings" they authored.
//
// Therefore: ANY new or reclassified leaf requires a NAMED HUMAN PRIVACY REVIEW, recorded in the
// pull request. Do not describe this script — in a README, a PR, a release note or UI copy — as
// enforcing privacy. It enforces that the shape stays declarable and declared.
//
// Run: bun run packages/telemetry/scripts/check-field-classes.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The override exists so the check's own tests can point it at a deliberately-broken copy and
// prove it FAILS. A check nobody has watched fail is a check nobody knows works.
const SCHEMA_DIR = process.env.TELEMETRY_SCHEMA_DIR ?? path.join(HERE, "..", "schema");

const VALUE_CLASSES = new Set(["count", "ratio", "bucket", "enum", "bool", "version", "duration"]);
/** delta | gauge ONLY. `cumulative` is not legal on any leaf — normalisation is at the emitter (G2). */
const TEMPORAL_CLASSES = new Set(["delta", "gauge"]);
/** Classes whose string leaves may be fenced by a bounded anchored pattern instead of a closed enum. */
const PATTERN_FENCEABLE = new Set(["version", "bucket"]);

type Json = Record<string, unknown>;

const failures: string[] = [];
function fail(msg: string): void {
  failures.push(msg);
}

// ── schema walk ────────────────────────────────────────────────────────────────────────────

interface Leaf {
  path: string;
  schema: Json;
}

/**
 * Walk a subschema and collect its LEAVES (anything that is not a plain object container).
 * Every object encountered must be closed; arrays recurse through `items`, contributing either
 * `path[]` (scalar items) or `path[].prop` (object items).
 */
function walk(node: Json, at: string, out: Leaf[], where: string): void {
  const type = node.type;

  if (type === "object" || node.properties !== undefined) {
    if (node.additionalProperties !== false) {
      fail(`${where}: object at "${at || "<root>"}" does not set additionalProperties:false — open-ended key maps are forbidden`);
    }
    if (node.patternProperties !== undefined) {
      fail(`${where}: object at "${at || "<root>"}" declares patternProperties — open-ended key maps are forbidden`);
    }
    const props = (node.properties ?? {}) as Record<string, Json>;
    if (Object.keys(props).length === 0) {
      fail(`${where}: object at "${at || "<root>"}" declares no properties — an empty closed object cannot carry a declared leaf`);
    }
    for (const [key, sub] of Object.entries(props)) {
      walk(sub, at === "" ? key : `${at}.${key}`, out, where);
    }
    return;
  }

  if (type === "array") {
    const items = node.items as Json | undefined;
    if (items === undefined) {
      fail(`${where}: array at "${at}" has no items schema`);
      return;
    }
    if (items.type === "object" || items.properties !== undefined) {
      walk(items, `${at}[]`, out, where);
      return;
    }
    out.push({ path: `${at}[]`, schema: items });
    return;
  }

  out.push({ path: at, schema: node });
}

/** Every numeric branch of a leaf (handles the nullable `anyOf: [number, null]` form). */
function numericBranches(leaf: Json): Json[] {
  const branches: Json[] = [];
  const consider = (n: Json): void => {
    if (n.type === "integer" || n.type === "number") branches.push(n);
  };
  consider(leaf);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const list = leaf[key];
    if (Array.isArray(list)) for (const b of list) consider(b as Json);
  }
  return branches;
}

/** Every string branch of a leaf. */
function stringBranches(leaf: Json): Json[] {
  const branches: Json[] = [];
  const consider = (n: Json): void => {
    if (n.type === "string") branches.push(n);
  };
  consider(leaf);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const list = leaf[key];
    if (Array.isArray(list)) for (const b of list) consider(b as Json);
  }
  return branches;
}

/** A bounded grammar: anchored at both ends and free of unbounded quantifiers. */
function isBoundedAnchoredPattern(pattern: string): boolean {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
  // `*`, `+` and open-ended `{n,}` all admit arbitrary-length values.
  if (/(?<!\\)[*+]/.test(pattern)) return false;
  if (/\{\d+,\}/.test(pattern)) return false;
  return true;
}

// ── load ───────────────────────────────────────────────────────────────────────────────────

const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "heartbeat.v1.json"), "utf8")) as Json;
const manifest = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "field-classes.json"), "utf8")) as Json;

// The schema must be a schema: compile it before reasoning about it.
try {
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.compile(schema);
} catch (err) {
  fail(`heartbeat.v1.json does not compile as a JSON Schema: ${err instanceof Error ? err.message : String(err)}`);
}

const envelopeProps = (schema.properties ?? {}) as Record<string, Json>;
const definitions = (schema.definitions ?? {}) as Record<string, Json>;

// ── the metrics placeholder + discriminated branches ───────────────────────────────────────

const PRODUCTS = ["brokkr", "saga", "skuld"] as const;
type Product = (typeof PRODUCTS)[number];

{
  const placeholder = envelopeProps.metrics;
  if (placeholder === undefined) {
    fail("envelope has no `metrics` property");
  } else if (placeholder.properties !== undefined || placeholder.additionalProperties !== undefined) {
    fail("the envelope's `metrics` placeholder must stay unconstrained — constraints belong on the per-product oneOf branch, or a leaf could be declared in two places");
  }
  const branches = schema.oneOf;
  if (!Array.isArray(branches) || branches.length !== PRODUCTS.length) {
    fail(`heartbeat.v1.json must carry exactly ${PRODUCTS.length} oneOf branches, one per product`);
  } else {
    const seen = new Set<string>();
    for (const raw of branches) {
      const b = raw as Json;
      const props = (b.properties ?? {}) as Record<string, Json>;
      const name = ((props.product?.properties as Record<string, Json> | undefined)?.name as Json | undefined)?.const;
      const ref = (props.metrics as Json | undefined)?.$ref;
      if (typeof name !== "string" || !PRODUCTS.includes(name as Product)) {
        fail(`a oneOf branch does not pin product.name to a known product (got ${JSON.stringify(name)})`);
        continue;
      }
      seen.add(name);
      if (ref !== `#/definitions/${name}_metrics`) {
        fail(`the "${name}" oneOf branch must pin metrics to #/definitions/${name}_metrics (got ${JSON.stringify(ref)})`);
      }
    }
    for (const p of PRODUCTS) if (!seen.has(p)) fail(`no oneOf branch pins product.name to "${p}"`);
  }
}

// ── collect leaves ─────────────────────────────────────────────────────────────────────────

const envelopeLeaves: Leaf[] = [];
for (const [key, sub] of Object.entries(envelopeProps)) {
  if (key === "metrics") continue; // discriminated — collected per product below
  walk(sub, key, envelopeLeaves, "envelope");
}
if (schema.additionalProperties !== false) fail("envelope: the root object does not set additionalProperties:false");

const bodyLeaves = new Map<Product, Leaf[]>();
for (const p of PRODUCTS) {
  const def = definitions[`${p}_metrics`];
  if (def === undefined) {
    fail(`definitions.${p}_metrics is missing`);
    bodyLeaves.set(p, []);
    continue;
  }
  const out: Leaf[] = [];
  walk(def, "", out, `metrics.${p}`);
  bodyLeaves.set(p, out);
}

// ── manifest coverage, both directions ─────────────────────────────────────────────────────

const reserved = (manifest.reserved ?? {}) as Record<string, Json>;
const envelopeManifest = (manifest.envelope ?? {}) as Record<string, Json>;
const metricsManifest = (manifest.metrics ?? {}) as Record<string, Record<string, Json>>;

function checkEntry(where: string, leafPath: string, entry: Json, leaf: Json): void {
  const cls = entry.class;
  const temporal = entry.temporal;

  if (typeof cls !== "string" || !VALUE_CLASSES.has(cls)) {
    fail(`${where} "${leafPath}": class ${JSON.stringify(cls)} is not one of ${[...VALUE_CLASSES].join(" | ")}`);
  }
  if (temporal === "cumulative") {
    fail(
      `${where} "${leafPath}": temporal "cumulative" is FORBIDDEN on every leaf — normalise to a per-day delta at the emitter (gate G2), never on the wire`,
    );
  } else if (typeof temporal !== "string" || !TEMPORAL_CLASSES.has(temporal)) {
    fail(`${where} "${leafPath}": temporal ${JSON.stringify(temporal)} is not one of ${[...TEMPORAL_CLASSES].join(" | ")}`);
  }

  // Strings must be closed enums, or a bounded anchored grammar for version/bucket forms.
  for (const branch of stringBranches(leaf)) {
    const hasClosedEnum = Array.isArray(branch.enum) && branch.enum.length > 0;
    const hasConst = branch.const !== undefined;
    const pattern = typeof branch.pattern === "string" ? branch.pattern : undefined;
    if (hasClosedEnum || hasConst) continue;
    if (pattern !== undefined && typeof cls === "string" && PATTERN_FENCEABLE.has(cls) && isBoundedAnchoredPattern(pattern)) {
      continue;
    }
    fail(
      `${where} "${leafPath}": string leaf is not fenced — needs a closed enum/const, or (for class ${[...PATTERN_FENCEABLE].join("/")}) an anchored, bounded pattern. Unconstrained strings can carry names.`,
    );
  }

  // Every delta leaf is floored at zero: normalisation guarantees non-negative, and a negative
  // would mean a counter reset leaked to the wire.
  if (temporal === "delta") {
    for (const branch of numericBranches(leaf)) {
      if (branch.minimum !== 0) {
        fail(`${where} "${leafPath}": delta leaf must declare minimum: 0 (found ${JSON.stringify(branch.minimum)})`);
      }
    }
  }

  // Nullability must be declared, not discovered.
  const nullable = stringOrNumberNullable(leaf);
  if (nullable && entry.nullable !== true) {
    fail(`${where} "${leafPath}": schema admits null but the manifest does not declare "nullable": true`);
  }
  if (!nullable && entry.nullable === true) {
    fail(`${where} "${leafPath}": manifest declares "nullable": true but the schema does not admit null`);
  }
}

function stringOrNumberNullable(leaf: Json): boolean {
  if (leaf.type === "null") return true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const list = leaf[key];
    if (Array.isArray(list) && list.some((b) => (b as Json).type === "null")) return true;
  }
  return Array.isArray(leaf.type) && leaf.type.includes("null");
}

function reconcile(where: string, leaves: Leaf[], entries: Record<string, Json>, allowReserved: boolean): void {
  const declared = new Set(Object.keys(entries));
  for (const leaf of leaves) {
    if (allowReserved && reserved[leaf.path] !== undefined) {
      const pinned = (reserved[leaf.path] as Json).pattern;
      if (typeof pinned !== "string" || leaf.schema.pattern !== pinned) {
        fail(`${where} "${leaf.path}": reserved leaf must carry exactly the manifest's pinned pattern (${JSON.stringify(pinned)})`);
      }
      continue;
    }
    const entry = entries[leaf.path];
    if (entry === undefined) {
      fail(`${where} "${leaf.path}": schema leaf has NO field-class manifest entry — every leaf must declare its class and temporal class`);
      continue;
    }
    declared.delete(leaf.path);
    checkEntry(where, leaf.path, entry, leaf.schema);
  }
  for (const orphan of declared) {
    fail(`${where} "${orphan}": manifest entry has no corresponding schema leaf — a rename or removal left the manifest behind`);
  }
}

reconcile("envelope", envelopeLeaves, envelopeManifest, true);
for (const p of PRODUCTS) {
  reconcile(`metrics.${p}`, bodyLeaves.get(p) ?? [], metricsManifest[p] ?? {}, false);
}

// A reserved entry that matches no leaf is drift too.
{
  const allPaths = new Set(envelopeLeaves.map((l) => l.path));
  for (const key of Object.keys(reserved)) {
    if (!allPaths.has(key)) fail(`reserved "${key}": no such leaf in the envelope`);
  }
}

// The manifest must not silently describe a different schema version.
if (manifest.schema_version !== (envelopeProps.schema_version as Json | undefined)?.const) {
  fail("field-classes.json `schema_version` does not match the schema's schema_version const");
}

// ── report ─────────────────────────────────────────────────────────────────────────────────

const leafCount = envelopeLeaves.length + PRODUCTS.reduce((n, p) => n + (bodyLeaves.get(p)?.length ?? 0), 0);

if (failures.length > 0) {
  console.error(`check-field-classes: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nThis check enforces SHAPE, not privacy. A new or reclassified leaf also needs a named human privacy review in the PR.");
  process.exit(1);
}

console.log(
  `check-field-classes: OK — ${leafCount} leaves (${envelopeLeaves.length} envelope + ${PRODUCTS.map((p) => `${p}:${bodyLeaves.get(p)?.length ?? 0}`).join(", ")}), every one declared, no cumulative temporal, every object closed.`,
);
console.log("Reminder: this enforces SHAPE, not privacy — a new or reclassified leaf needs a named human privacy review in the PR.");
