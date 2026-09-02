// Route-parity between the collector and its Cloudflare Worker twin.
//
// The two collectors are a deliberate duplicate pair that share ONE OpenAPI document. Each
// declares its route inventory INDEPENDENTLY (collector/src/server.ts and
// collector-worker/src/server.ts each export their own ROUTES) — so this comparison is a real
// check, not a tautology over a shared constant: adding a route to one twin and not the other
// makes the sets differ and this test fails — adding a route to one twin only makes the test fail.
import { describe, expect, test } from "bun:test";
import { ROUTES as collectorRoutes } from "../src/server";
import { ROUTES as workerRoutes } from "../../collector-worker/src/server";

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("collector ↔ worker route parity", () => {
  test("both twins expose exactly the same route set", () => {
    const collector = [...collectorRoutes].map(key).sort();
    const worker = [...workerRoutes].map(key).sort();
    expect(worker).toEqual(collector);
  });

  test("the shared route set is non-empty (guard against two empty inventories matching)", () => {
    expect(collectorRoutes.length).toBeGreaterThan(0);
    expect(workerRoutes.length).toBeGreaterThan(0);
  });

  test("adding a route to one twin only would break parity (property demonstrated)", () => {
    // Demonstrate the test can fail: a hypothetical extra route on one side must diverge.
    const collector = [...collectorRoutes].map(key).sort();
    const workerPlusOne = [...[...workerRoutes].map(key), "GET /api/v1/rogue"].sort();
    expect(workerPlusOne).not.toEqual(collector);
  });
});
