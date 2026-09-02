// Booted-server conformance suite for telemetry's OpenAPI document.
//
// Adapted from the saga template (api/openapi.test.ts): it drives the REAL collector handler
// with a Request per route (this service needs no port bind — buildFetchHandler returns a fetch
// function). It checks:
//   clause 1  every documented path RESOLVES on the booted handler (no unrouted 404);
//   clause 2  the router's route inventory (ROUTES) and the documented paths are the SAME set,
//             enumerated from the handler registry, not the spec (ROUTES drives dispatch);
//   clause 3  the document is structurally well-formed (mirrors validateSpec's shape rules; the
//             authoritative validateSpec runs at docs-vendor time, in the docs site's sync-api.mjs);
//   clause 4  error codes are documented in BOTH directions against the collector source;
//   clause 5  real error responses carry telemetry's flat {ok:false, error:<token>} envelope,
//             asserted through the production handler, not a spec-side fixture.
// The Worker twin shares THIS document; the route-parity test (parity.test.ts) binds them.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "../src/server";
import { makeHarness } from "./helpers";

const SPEC_PATH = join(import.meta.dir, "../../api/openapi.json");
const INVENTORY_PATH = join(import.meta.dir, "../../api/inventory.json");
const COLLECTOR_SRC = join(import.meta.dir, "../src/server.ts");
const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
  openapi: string;
  paths: Record<string, Record<string, { summary?: unknown; responses?: unknown; tags?: string[] }>>;
  tags?: { name: string }[];
};

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";

/** Every (method, path) operation the document declares. */
function documentedOps(): { method: string; path: string }[] {
  const ops: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) ops.push({ method: method.toUpperCase(), path });
  }
  return ops;
}

/** Fill a path template with a sample id, for a live probe. */
function fillPath(path: string): string {
  return path.replace(/\{[^}]+\}/g, SAMPLE_ID);
}

describe("openapi.json — structural well-formedness (clause 3)", () => {
  test("openapi is 3.x", () => {
    expect(typeof spec.openapi).toBe("string");
    expect(spec.openapi.startsWith("3.")).toBe(true);
  });
  const declaredTags = new Set((spec.tags ?? []).map((t) => t.name));
  for (const { method, path } of documentedOps()) {
    const op = spec.paths[path]![method.toLowerCase()]!;
    test(`${method} ${path} has a summary, a response, and declared tags`, () => {
      expect(typeof op.summary).toBe("string");
      expect(Object.keys(op.responses as object).length).toBeGreaterThan(0);
      for (const tag of op.tags ?? []) expect(declaredTags.has(tag)).toBe(true);
    });
  }
});

describe("router registry (ROUTES) and the document are the same route set (clause 2)", () => {
  const routeKey = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
  const registry = new Set(ROUTES.map(routeKey));
  const documented = new Set(documentedOps().map(routeKey));

  test("every route the router answers is documented", () => {
    for (const key of registry) {
      expect(documented.has(key), `${key} is answerable but not documented`).toBe(true);
    }
  });
  test("every documented route is a route the router answers", () => {
    for (const key of documented) {
      expect(registry.has(key), `${key} is documented but the router has no such route`).toBe(true);
    }
  });
});

describe("every documented path resolves on the booted collector (clause 1)", () => {
  // opsKey + schemaJson set so /metrics and /api/v1/schema are ACTIVE; then an unrouted path is the
  // only thing that returns 404 with the not_found sentinel. No credential is sent, so authed
  // routes answer 400/403 (which resolve) — the point is the router HAS the route.
  const h = makeHarness({ opsKey: "test-ops-key", schemaJson: "{}" });
  for (const { method, path } of documentedOps()) {
    test(`${method} ${path} resolves`, async () => {
      const init: RequestInit = { method };
      if (method === "POST" || method === "PUT") {
        init.headers = { "content-type": "application/json" };
        init.body = "{}";
      }
      const res = await h.handler(new Request(`http://telemetry.local${fillPath(path)}`, init));
      if (res.status === 404) {
        const body = (await res.json()) as { error?: string };
        expect(body.error, `${method} ${path} is documented but the router has no such route`).not.toBe(
          "not_found",
        );
      }
    });
  }
});

describe("error codes are documented in both directions (clause 4)", () => {
  const source = readFileSync(COLLECTOR_SRC, "utf8");
  // Strip block and line comments first, so a token that appears only in PROSE (a `// error: 'x'`
  // note or a JSDoc block) is not mistaken for an emitted wire token — the emitted set must be
  // tokens the CODE actually returns.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const specJson = JSON.stringify(spec);
  const documented = new Set<string>();
  for (const m of specJson.matchAll(/"x-error-codes":\[([^\]]*)\]/g)) {
    for (const c of m[1]!.split(",")) {
      const code = c.replace(/"/g, "").trim();
      if (code) documented.add(code);
    }
  }
  // The wire token a client sees appears TWO ways in the source: as `error: '<token>'` in the
  // json() helper, and as the 2nd argument to rejectIngest(status, '<token>', counter) on the
  // ingest path. Both must be scanned — a scan that saw only the first missed write_key_mismatch,
  // payload_too_large and invalid_payload, and would have let them go undocumented.
  const emitted = new Set<string>();
  for (const m of codeOnly.matchAll(/error:\s*'([a-z][a-z0-9_]+)'/g)) emitted.add(m[1]!);
  for (const m of codeOnly.matchAll(/rejectIngest\(\s*\d+,\s*'([a-z][a-z0-9_]+)'/g)) emitted.add(m[1]!);

  test("the scan found a non-trivial set of codes (guard against an empty match)", () => {
    expect(documented.size).toBeGreaterThanOrEqual(8);
    expect(emitted.size).toBeGreaterThanOrEqual(8);
  });
  test("every documented error code is a wire token the collector actually emits", () => {
    // Against the EMITTED set (the scanned wire tokens), not a bare substring search of the
    // source — a token that appears only in a comment or an unrelated string must not satisfy
    // this, or a documented code no route can return would slip through.
    for (const code of documented) {
      expect(emitted.has(code), `documented '${code}' is not a wire token any route emits`).toBe(true);
    }
  });
  test("every error code the collector emits is documented", () => {
    for (const code of emitted) {
      expect(documented.has(code), `the collector emits '${code}', which the document never lists`).toBe(
        true,
      );
    }
  });
});

describe("real error responses carry telemetry's flat envelope (clause 5)", () => {
  // The documented error enum, read from the Error schema.
  const errorEnum = new Set(
    (spec as unknown as { components: { schemas: { Error: { properties: { error: { enum: string[] } } } } } })
      .components.schemas.Error.properties.error.enum,
  );
  const h = makeHarness({ opsKey: "test-ops-key", schemaJson: "{}" });

  async function assertEnvelope(res: Response) {
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { ok?: unknown; error?: unknown };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(errorEnum.has(body.error as string), `error token '${String(body.error)}' is not in the documented enum`).toBe(
      true,
    );
  }

  test("unknown route → 404 flat envelope", async () => {
    const res = await h.handler(new Request("http://telemetry.local/no/such/route"));
    expect(res.status).toBe(404);
    await assertEnvelope(res);
  });
  test("malformed ingest body → 4xx flat envelope", async () => {
    const res = await h.handler(
      new Request("http://telemetry.local/api/v1/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mythical-instance-secret": "s".repeat(43) },
        body: "not json",
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    await assertEnvelope(res);
  });
  test("/metrics with a wrong ops key → 403 flat envelope", async () => {
    const res = await h.handler(
      new Request("http://telemetry.local/metrics", { headers: { "x-mythical-ops-key": "wrong" } }),
    );
    expect(res.status).toBe(403);
    await assertEnvelope(res);
  });
});

describe("GET /openapi.json serves the committed document byte-for-byte (clause 6)", () => {
  const h = makeHarness({ opsKey: "k", schemaJson: "{}" });
  test("the served bytes are the committed document", async () => {
    const res = await h.handler(new Request("http://telemetry.local/openapi.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const served = await res.text();
    // The handler serves JSON.stringify(importedDocument); the committed file is that same
    // document. Compare against its canonical serialization so the guarantee is "the served doc
    // IS the committed doc" — a spec edit that was not re-imported would diverge here.
    expect(served).toBe(JSON.stringify(JSON.parse(readFileSync(SPEC_PATH, "utf8"))));
    // And it round-trips to the same product identity.
    expect((JSON.parse(served) as { "x-mythical": { product: string } })["x-mythical"].product).toBe(
      "telemetry",
    );
  });
});

// ── The committed route inventory is GENERATED from the router ────────────────────────────────
//
// The docs site's completeness gate (check-api.mjs) compares telemetry's vendored spec against a
// vendored route INVENTORY. The load-bearing rule is that the
// inventory is GENERATED from the router — never hand-written — so a route added to the router but
// not re-generated makes THIS suite fail. Here the enumeration is the router's OWN dispatch table
// (ROUTES, the same registry clause 2 checks the document against), so the inventory is the router's
// route set directly, not a spec-side transcription. `api/inventory.json` is this suite's committed
// output; sync-api.mjs vendors it verbatim into the docs site's inventory/telemetry.json. Its shape is
// the docs pipeline's (inventory.mjs): a sorted, de-duplicated list of { method, path }.
describe("the committed route inventory is generated from the router registry (API-M4 criterion 0)", () => {
  const INVENTORY_NOTE =
    "Generated from the router registry (ROUTES) by collector/tests/openapi.test.ts (API-M4 criterion 0). NEVER hand-edit; a completeness gate compares a spec against this. Regenerate with `UPDATE_INVENTORY=1 bun test tests/openapi.test.ts`.";

  /** ROUTES normalised into the docs inventory's sorted, de-duplicated { method, path } list. */
  function inventoryRoutes(): { method: string; path: string }[] {
    const seen = new Set<string>();
    const out: { method: string; path: string }[] = [];
    for (const r of ROUTES) {
      const method = r.method.toUpperCase();
      const key = `${method} ${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ method, path: r.path });
    }
    out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
    return out;
  }

  test("api/inventory.json equals the router's ROUTES registry", () => {
    const routes = inventoryRoutes();
    expect(routes.length, "ROUTES is empty — cannot regenerate the inventory").toBeGreaterThan(0);
    const fresh = `${JSON.stringify({ note: INVENTORY_NOTE, product: "telemetry", routes }, null, 2)}\n`;
    // Regenerate the committed artifact on demand: `UPDATE_INVENTORY=1 bun test tests/openapi.test.ts`.
    if (process.env.UPDATE_INVENTORY) writeFileSync(INVENTORY_PATH, fresh);
    const committed = readFileSync(INVENTORY_PATH, "utf8");
    expect(
      committed,
      "api/inventory.json is STALE — a route was added to or removed from ROUTES but the inventory was not regenerated; run `UPDATE_INVENTORY=1 bun test tests/openapi.test.ts`",
    ).toBe(fresh);
  });
});
