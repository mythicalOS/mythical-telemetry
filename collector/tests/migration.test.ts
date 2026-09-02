// The unversioned-path gate: /api/v1/* and /health are the served surface; /v1/* and /healthz
// are not.
//
// PRE_MIGRATION_ROUTES is the unversioned route inventory, frozen here as the reference set. Two
// properties are asserted against it:
//   drop-nothing: every unversioned route has a live /api/v1 counterpart modulo the prefix, and
//     the ONLY routes beyond that set are the two convention routes (HEAD /health, GET /openapi.json).
//   no aliases (hard cut): every unversioned path 404s. There is no dual-serving — POST /v1/ingest
//     is not a route, POST /api/v1/ingest answers.
import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/server";
import { makeHarness } from "./helpers";

const PRE_MIGRATION_ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/healthz" },
  { method: "GET", path: "/" },
  { method: "GET", path: "/v1/stats" },
  { method: "GET", path: "/v1/schema" },
  { method: "GET", path: "/metrics" },
  { method: "POST", path: "/v1/ingest" },
  { method: "GET", path: "/v1/instances/{id}/stats" },
  { method: "DELETE", path: "/v1/instances/{id}" },
];

/** The prefix transform: /v1/* -> /api/v1/*, /healthz -> /health, everything else unchanged. */
function migrated(path: string): string {
  if (path === "/healthz") return "/health";
  if (path.startsWith("/v1/")) return "/api/v1/" + path.slice("/v1/".length);
  return path;
}

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";
const fill = (p: string) => p.replace(/\{[^}]+\}/g, SAMPLE_ID);
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const liveRoutes = new Set(ROUTES.map(key));

describe("drop-nothing: the migration preserved every pre-migration route (criterion 2)", () => {
  for (const r of PRE_MIGRATION_ROUTES) {
    const after = { method: r.method, path: migrated(r.path) };
    test(`${key(r)} -> ${key(after)} still exists`, () => {
      expect(liveRoutes.has(key(after)), `${key(after)} was dropped in the migration`).toBe(true);
    });
  }

  test("the ONLY routes added are the two deliberate convention routes", () => {
    const expectedAfter = new Set(PRE_MIGRATION_ROUTES.map((r) => key({ method: r.method, path: migrated(r.path) })));
    const added = [...liveRoutes].filter((k) => !expectedAfter.has(k)).sort();
    expect(added).toEqual(["GET /openapi.json", "HEAD /health"]);
    // And nothing pre-migration vanished from the live set beyond the rename.
    for (const k of expectedAfter) expect(liveRoutes.has(k)).toBe(true);
  });

  test("each post-migration counterpart resolves on the booted collector", async () => {
    const h = makeHarness({ opsKey: "k", schemaJson: "{}" });
    for (const r of PRE_MIGRATION_ROUTES) {
      const after = { method: r.method, path: migrated(r.path) };
      const init: RequestInit = { method: after.method };
      if (after.method === "POST") {
        init.headers = { "content-type": "application/json" };
        init.body = "{}";
      }
      const res = await h.handler(new Request(`http://telemetry.local${fill(after.path)}`, init));
      if (res.status === 404) {
        const body = (await res.json()) as { error?: string };
        expect(body.error, `${key(after)} does not resolve after migration`).not.toBe("not_found");
      }
    }
  });
});

describe("no aliases: every renamed old path is a hard cut to 404 (criterion 3)", () => {
  const h = makeHarness({ opsKey: "k", schemaJson: "{}" });
  for (const r of PRE_MIGRATION_ROUTES) {
    if (migrated(r.path) === r.path) continue; // / and /metrics did not move
    test(`${key(r)} now 404s (not dual-served)`, async () => {
      const init: RequestInit = { method: r.method };
      if (r.method === "POST") {
        init.headers = { "content-type": "application/json" };
        init.body = "{}";
      }
      const res = await h.handler(new Request(`http://telemetry.local${fill(r.path)}`, init));
      expect(res.status, `${key(r)} still answers — it must be a hard cut`).toBe(404);
      const body = (await res.json()) as { ok?: unknown; error?: unknown };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("not_found");
    });
  }

  test("the paired positive: the new /api/v1/ingest answers while /v1/ingest is gone", async () => {
    const gone = await h.handler(
      new Request("http://telemetry.local/v1/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(gone.status).toBe(404);
    const answered = await h.handler(
      new Request("http://telemetry.local/api/v1/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    // No secret, so it is rejected — but by the ingest handler (403/4xx), NOT as an unknown route.
    expect(answered.status).not.toBe(404);
  });
});
