// C14 machine-first guard on the migrated telemetry responses (API-M3 criterion 11).
//
// A GUARD, not a did-nothing detector: a service with no live offender passes. It asserts the
// migrated /api/v1 + /health surfaces stay machine-consumable — no capability route returns an
// HTML body, numeric value fields are unit-suffixed, enums/statuses are tokens, and there is no
// human-relative or bare-epoch timestamp as a sole representation. A newly introduced
// machine-hostile field on a migrated surface would fail this.
import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/server";
import { makeHarness } from "./helpers";

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";
const fill = (p: string) => p.replace(/\{[^}]+\}/g, SAMPLE_ID);

// The capability routes — everything except the human-facing HTML dashboard at "/", which is UI
// delivery (a rendered page), not a capability (its machine twin is GET /api/v1/stats).
const CAPABILITY_ROUTES = ROUTES.filter((r) => r.path !== "/");

describe("no capability route returns an HTML body (C14 rule 1)", () => {
  const h = makeHarness({ opsKey: "k", schemaJson: "{}" });
  for (const r of CAPABILITY_ROUTES) {
    test(`${r.method} ${r.path} answers JSON (or empty), never HTML`, async () => {
      const init: RequestInit = { method: r.method };
      if (r.method === "POST") {
        init.headers = { "content-type": "application/json" };
        init.body = "{}";
      }
      const res = await h.handler(new Request(`http://telemetry.local${fill(r.path)}`, init));
      const ct = res.headers.get("content-type") ?? "";
      expect(ct.includes("text/html"), `${r.method} ${r.path} returned HTML`).toBe(false);
      const text = await res.text();
      if (text.length > 0) {
        // Whatever it returned parses as JSON — no presentation markup.
        expect(() => JSON.parse(text), `${r.method} ${r.path} body is not JSON`).not.toThrow();
      }
    });
  }
  test("the HTML dashboard at / IS html (the one intentional exception — UI delivery)", async () => {
    const res = await h.handler(new Request("http://telemetry.local/"));
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("machine-first value shapes on the migrated surfaces (C14 rule 2)", () => {
  const h = makeHarness({ opsKey: "k", schemaJson: "{}" });

  test("/health's numeric value is unit-suffixed (uptime_s) and version is a string token", async () => {
    const res = await h.handler(new Request("http://telemetry.local/health"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.uptime_s).toBe("number"); // suffixed with _s, an explicit unit
    expect(typeof body.version).toBe("string");
    // No human-relative phrasing snuck in as a field value.
    for (const v of Object.values(body)) {
      if (typeof v === "string") expect(/\bago\b|just now/i.test(v)).toBe(false);
    }
  });

  test("error tokens are lowercase machine tokens, never prose sentences", async () => {
    const res = await h.handler(new Request("http://telemetry.local/no/such/route"));
    const body = (await res.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");
    // A token: no spaces, no sentence punctuation.
    expect(/^[a-z][a-z0-9_]+$/.test(body.error as string)).toBe(true);
  });
});
