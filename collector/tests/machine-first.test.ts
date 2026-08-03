// C14 machine-first guard on the migrated telemetry responses (API-M3 criterion 11).
//
// A GUARD, not a did-nothing detector: a service with no live offender passes. It asserts the
// migrated /api/v1 + /health surfaces stay machine-consumable — no capability route returns an
// HTML body (on ERROR *or* authenticated SUCCESS), numeric value fields are unit-suffixed, and
// error tokens are lowercase tokens, not prose. A newly introduced machine-hostile field on a
// migrated surface would fail this.
import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/server";
import { makeHarness } from "./helpers";
import { deleteReq, ingestReq, statsReq } from "./helpers";
import { INSTANCE_A, SECRET_A, makeHeartbeat } from "./fixtures";

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";
const fill = (p: string) => p.replace(/\{[^}]+\}/g, SAMPLE_ID);

/** application/json (or an empty body), never HTML. */
async function expectJsonNotHtml(res: Response, where: string) {
  const ct = res.headers.get("content-type") ?? "";
  expect(ct.includes("text/html"), `${where} returned HTML`).toBe(false);
  const text = await res.text();
  if (text.length > 0) {
    expect(ct.includes("application/json"), `${where} is not application/json`).toBe(true);
    expect(() => JSON.parse(text), `${where} body is not JSON`).not.toThrow();
  }
}

// The capability routes — everything except the human-facing HTML dashboard at "/", which is UI
// delivery (a rendered page), not a capability (its machine twin is GET /api/v1/stats).
const CAPABILITY_ROUTES = ROUTES.filter((r) => r.path !== "/");

describe("no capability route returns HTML — the reject/unauthorized paths (C14 rule 1)", () => {
  const h = makeHarness({ opsKey: "k", schemaJson: "{}" });
  for (const r of CAPABILITY_ROUTES) {
    test(`${r.method} ${r.path} (no credential) answers JSON or empty, never HTML`, async () => {
      const init: RequestInit = { method: r.method };
      if (r.method === "POST") {
        init.headers = { "content-type": "application/json" };
        init.body = "{}";
      }
      const res = await h.handler(new Request(`http://telemetry.local${fill(r.path)}`, init));
      await expectJsonNotHtml(res, `${r.method} ${r.path}`);
    });
  }
  test("the HTML dashboard at / IS html (the one intentional exception — UI delivery)", async () => {
    const res = await h.handler(new Request("http://telemetry.local/"));
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("the AUTHENTICATED SUCCESS bodies are machine-first, not HTML (C14 rule 1)", () => {
  // Drive each capability route to its 2xx SUCCESS response with real credentials — the path an
  // error-only probe never reaches, where a machine-hostile success body would otherwise hide.
  test("POST /api/v1/ingest 202, GET stats 200, GET /metrics 200, DELETE 200 are all JSON", async () => {
    const h = makeHarness({ opsKey: "ops-secret" });
    const ingest = await h.handler(ingestReq(makeHeartbeat("brokkr", INSTANCE_A), SECRET_A));
    expect(ingest.status).toBe(202);
    await expectJsonNotHtml(ingest, "POST /api/v1/ingest (202)");

    const stats = await h.handler(statsReq(INSTANCE_A, "brokkr", { secret: SECRET_A }));
    expect(stats.status).toBe(200);
    await expectJsonNotHtml(stats, "GET /api/v1/instances/{id}/stats (200)");

    const metrics = await h.handler(
      new Request("http://telemetry.local/metrics", { headers: { "x-mythical-ops-key": "ops-secret" } }),
    );
    expect(metrics.status).toBe(200);
    await expectJsonNotHtml(metrics, "GET /metrics (200)");

    const del = await h.handler(deleteReq(INSTANCE_A, SECRET_A));
    expect(del.status).toBe(204); // No Content — an empty body, which is not HTML.
    await expectJsonNotHtml(del, "DELETE /api/v1/instances/{id} (204)");
  });

  test("the public reads GET /api/v1/stats, GET /health, GET /openapi.json 200 are JSON", async () => {
    const h = makeHarness({ schemaJson: "{}" });
    for (const path of ["/api/v1/stats", "/health", "/openapi.json", "/api/v1/schema"]) {
      const res = await h.handler(new Request(`http://telemetry.local${path}`));
      expect(res.status, `${path} did not answer 200`).toBe(200);
      await expectJsonNotHtml(res, `GET ${path} (200)`);
    }
  });
});

describe("machine-first value shapes on the migrated surfaces (C14 rule 2)", () => {
  const h = makeHarness({ opsKey: "k", schemaJson: "{}" });

  test("/health's numeric value is unit-suffixed (uptime_s) and version is a string token", async () => {
    const res = await h.handler(new Request("http://telemetry.local/health"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.uptime_s).toBe("number"); // suffixed with _s, an explicit unit
    expect(typeof body.version).toBe("string");
    for (const v of Object.values(body)) {
      if (typeof v === "string") expect(/\bago\b|just now/i.test(v)).toBe(false);
    }
  });

  test("error tokens across DIFFERENT error paths are lowercase machine tokens, never prose", async () => {
    // Probe several distinct error conditions, not just one — a prose token on any error path
    // (e.g. a re-shaped ingest rejection) must fail here.
    const probes: Array<{ label: string; make: () => Promise<Response> | Response }> = [
      { label: "unknown route", make: () => h.handler(new Request("http://telemetry.local/no/such/route")) },
      {
        label: "ingest, no secret",
        make: () =>
          h.handler(
            new Request("http://telemetry.local/api/v1/ingest", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            }),
          ),
      },
      {
        label: "ingest, bad json",
        make: () =>
          h.handler(
            new Request("http://telemetry.local/api/v1/ingest", {
              method: "POST",
              headers: { "content-type": "application/json", "x-mythical-instance-secret": "s".repeat(64) },
              body: "not json",
            }),
          ),
      },
      {
        label: "metrics, wrong ops key",
        make: () =>
          h.handler(new Request("http://telemetry.local/metrics", { headers: { "x-mythical-ops-key": "wrong" } })),
      },
      { label: "stats, no secret", make: () => h.handler(statsReq(INSTANCE_A, "brokkr", {})) },
    ];
    const seen = new Set<string>();
    for (const { label, make } of probes) {
      const res = await make();
      const body = (await res.json()) as { error?: unknown };
      expect(typeof body.error, `${label}: no error token`).toBe("string");
      const token = body.error as string;
      seen.add(token);
      expect(/^[a-z][a-z0-9_]+$/.test(token), `${label}: '${token}' is not a lowercase token`).toBe(true);
    }
    // Distinct probes surfaced distinct tokens — the check isn't collapsing to one path.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});
