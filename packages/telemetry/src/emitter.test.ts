import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HeartbeatEmitter, type EmitterEndpoints } from "./emitter.ts";
import { IdentityStore } from "./identity.ts";
import { Transport } from "./transport.ts";
import { unsetConsent, userConsent, type ConsentState } from "./optout.ts";
import { validateHeartbeat, type BrokkrMetrics, type SagaMetrics, type SkuldMetrics } from "./envelope.ts";
import { buildBrokkrMetrics, type BrokkrConfigView } from "./bodies/brokkr.ts";
import { buildSagaMetrics } from "./bodies/saga.ts";
import { buildSkuldMetrics } from "./bodies/skuld.ts";
import type { PinnedEndpoint, PostResult } from "./ssrf.ts";

const CENTRAL = "https://telemetry.example.com";
const COPY = "https://ops.example.net";
const CONSENT_ON = userConsent(true, Date.parse("2026-01-01T00:00:00.000Z"));

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mythical-telemetry-emitter-"));
}

const CONFIG: BrokkrConfigView = {
  backend: "local",
  harness_type: "claude",
  wizard_completed: true,
  team_size: 2,
  playbooks_active: 1,
  review_mode: "cross-model",
  terminal: false,
  edges: false,
};

interface Sent {
  url: string;
  body: string;
  secret: string;
}

function makeEmitter(opts: {
  consent?: ConsentState;
  endpoints?: EmitterEndpoints;
  respond?: (sent: Sent) => PostResult;
  buildMetrics?: (day: string) => BrokkrMetrics;
  root?: string;
  nowMs?: number;
}): {
  emitter: HeartbeatEmitter<"brokkr">;
  sent: Sent[];
  identity: IdentityStore;
  root: string;
} {
  const root = opts.root ?? tmpRoot();
  const now = opts.nowMs ?? Date.parse("2026-07-27T06:00:00.000Z");
  const sent: Sent[] = [];
  const identity = new IdentityStore({ stateRoot: root });
  const transport = new Transport({
    stateRoot: root,
    nowMs: () => now,
    random: () => 0.5,
    resolveImpl: async (url): Promise<PinnedEndpoint> => ({ url: new URL(url), address: "93.184.216.34", family: 4, literal: false }),
    postImpl: async (args): Promise<PostResult> => {
      const record: Sent = {
        url: args.endpoint.url.toString(),
        body: args.body,
        secret: args.headers["X-Mythical-Write-Key"] ?? "",
      };
      sent.push(record);
      return opts.respond?.(record) ?? { status: 202, ok: true, detail: undefined };
    },
  });
  const emitter = new HeartbeatEmitter<"brokkr">({
    product: "brokkr",
    version: "0.1.37",
    identity,
    transport,
    getConsent: () => opts.consent ?? CONSENT_ON,
    getEndpoints: () => opts.endpoints ?? { centralUrl: CENTRAL, copyUrl: COPY },
    buildMetrics: opts.buildMetrics ?? ((): BrokkrMetrics => buildBrokkrMetrics({ rollup: undefined, config: CONFIG })),
    platform: { os: "linux", arch: "x64" },
    nowMs: () => now,
  });
  return { emitter, sent, identity, root };
}

describe("envelope assembly", () => {
  test("reports the most recent COMPLETED UTC day", () => {
    const { emitter } = makeEmitter({});
    expect(emitter.candidateDay()).toBe("2026-07-26");
  });

  test("produces a document that validates", () => {
    const { emitter, identity } = makeEmitter({});
    const payload = emitter.buildPayload("2026-07-26", identity.centralIdentity().instance_id);
    expect(validateHeartbeat(payload).ok).toBe(true);
    expect(payload.product).toEqual({ name: "brokkr", version: "0.1.37" });
    expect(payload.platform).toEqual({ os: "linux", arch: "x64" });
  });

  test("a non-semver product version buckets to 'other'", () => {
    const { emitter, identity } = makeEmitter({});
    const other = new HeartbeatEmitter<"brokkr">({
      product: "brokkr",
      version: "0.1.37-acme-internal",
      identity,
      transport: new Transport({ stateRoot: tmpRoot() }),
      getConsent: () => CONSENT_ON,
      getEndpoints: () => ({ centralUrl: CENTRAL }),
      buildMetrics: () => buildBrokkrMetrics({ rollup: undefined, config: CONFIG }),
      platform: { os: "linux", arch: "x64" },
    });
    expect(other.buildPayload("2026-07-26", identity.centralIdentity().instance_id).product.version).toBe("other");
    expect(emitter.buildPayload("2026-07-26", identity.centralIdentity().instance_id).product.version).toBe("0.1.37");
  });
});

describe("disclosure — the destination-aware transparency surface", () => {
  test("returns ONE entry per destination, with DIFFERENT identities", () => {
    const { emitter } = makeEmitter({});
    const entries = emitter.disclosure("2026-07-26");

    expect(entries.map((e) => e.destination)).toEqual(["central", "copy"]);
    expect(entries[0]!.instance_id).not.toBe(entries[1]!.instance_id);
    // The claim "these are the exact bytes" is only true per destination — the bodies differ.
    expect(entries[0]!.wire_bytes).not.toBe(entries[1]!.wire_bytes);
    expect(entries[0]!.endpoint).toBe("https://telemetry.example.com/v1/ingest");
    expect(entries[1]!.endpoint).toBe("https://ops.example.net/v1/ingest");
  });

  test("the disclosed bytes are EXACTLY what would be sent", async () => {
    const { emitter, sent } = makeEmitter({});
    const entries = emitter.disclosure("2026-07-26");
    await emitter.emit("2026-07-26");

    const central = sent.find((s) => s.url.startsWith(CENTRAL))!;
    const copy = sent.find((s) => s.url.startsWith(COPY))!;
    expect(central.body).toBe(entries[0]!.wire_bytes);
    expect(copy.body).toBe(entries[1]!.wire_bytes);
  });

  test("WORKS WHEN OPTED OUT — the one moment someone most wants to look", () => {
    const { emitter, sent } = makeEmitter({ consent: userConsent(false, Date.now()) });
    const entries = emitter.disclosure("2026-07-26");
    expect(entries).toHaveLength(2);
    expect(validateHeartbeat(entries[0]!.payload).ok).toBe(true);
    expect(sent).toHaveLength(0); // and it sends nothing
  });

  test("works from day zero, before consent has ever been decided", () => {
    const { emitter } = makeEmitter({ consent: unsetConsent(Date.now()) });
    expect(emitter.disclosure("2026-07-26")).toHaveLength(2);
  });

  test("with no copy configured there is exactly one entry", () => {
    const { emitter } = makeEmitter({ endpoints: { centralUrl: CENTRAL } });
    const entries = emitter.disclosure("2026-07-26");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.destination).toBe("central");
  });

  test("no secret is ever present in a disclosure entry", () => {
    const { emitter, identity } = makeEmitter({});
    const secret = identity.centralIdentity().instance_secret;
    const serialised = JSON.stringify(emitter.disclosure("2026-07-26"));
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain(identity.copyIdentityFor(COPY).instance_secret);
  });
});

describe("emit", () => {
  test("sends to both destinations, each authenticated with its OWN secret", async () => {
    const { emitter, sent, identity } = makeEmitter({});
    const result = await emitter.emit("2026-07-26");
    expect(result.sent).toBe(true);

    const central = sent.find((s) => s.url.startsWith(CENTRAL))!;
    const copy = sent.find((s) => s.url.startsWith(COPY))!;
    expect(central.secret).toBe(identity.centralIdentity().instance_secret);
    expect(copy.secret).not.toBe(identity.centralIdentity().instance_secret);
    expect(copy.secret).toBe(identity.copyIdentityFor(COPY).instance_secret);
  });

  test("THE CENTRAL SECRET NEVER APPEARS IN THE COPY REQUEST", async () => {
    const { emitter, sent, identity } = makeEmitter({});
    await emitter.emit("2026-07-26");
    const centralSecret = identity.centralIdentity().instance_secret;
    const copy = sent.find((s) => s.url.startsWith(COPY))!;
    expect(JSON.stringify(copy)).not.toContain(centralSecret);
  });

  test("an opted-out install sends NOTHING", async () => {
    const { emitter, sent } = makeEmitter({ consent: userConsent(false, Date.now()) });
    const result = await emitter.emit("2026-07-26");
    expect(result).toMatchObject({ sent: false, reason: "opted_out" });
    expect(sent).toHaveLength(0);
  });

  test("an install nobody has decided for sends NOTHING", async () => {
    const { emitter, sent } = makeEmitter({ consent: unsetConsent(Date.now()) });
    expect((await emitter.emit("2026-07-26")).sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("copy-without-central is refused as misconfiguration, and nothing is sent", async () => {
    const { emitter, sent } = makeEmitter({ endpoints: { centralUrl: "", copyUrl: COPY } });
    const result = await emitter.emit("2026-07-26");
    expect(result).toMatchObject({ sent: false, reason: "misconfigured" });
    expect(result.sent === false ? result.detail : "").toContain("copy_without_central");
    expect(sent).toHaveLength(0);
  });

  test("REFUSES TO SEND A DOCUMENT IT KNOWS IS INVALID, and says why", async () => {
    const broken = (): BrokkrMetrics => {
      const metrics = buildBrokkrMetrics({ rollup: undefined, config: CONFIG });
      // A producer bug: more failures than sessions. The collector would drop this silently.
      metrics.sessions.failed = 5;
      return metrics;
    };
    const { emitter, sent } = makeEmitter({ buildMetrics: broken });
    const result = await emitter.emit("2026-07-26");
    expect(result).toMatchObject({ sent: false, reason: "invalid_payload" });
    expect(result.sent === false ? result.detail : "").toContain("sessions");
    expect(sent).toHaveLength(0);
  });

  test("removing the copy retires its identity and purges its queued deliveries", async () => {
    const root = tmpRoot();
    const withCopy = makeEmitter({ root, respond: () => ({ status: 503, ok: false, detail: "down" }) });
    await withCopy.emitter.emit("2026-07-26");
    const copySecret = withCopy.identity.copyIdentityFor(COPY).instance_secret;
    expect(withCopy.identity.currentCopyDestination()).toBe(COPY);

    const withoutCopy = makeEmitter({ root, endpoints: { centralUrl: CENTRAL } });
    await withoutCopy.emitter.emit("2026-07-26");
    expect(withoutCopy.identity.currentCopyDestination()).toBeUndefined();
    const report = withoutCopy.emitter.status("2026-07-26")!;
    expect(report.copy).toBeNull();
    expect(withoutCopy.sent.every((s) => s.secret !== copySecret)).toBe(true);
  });

  test("applyConfigChange on a global opt-out fences both destinations", async () => {
    const root = tmpRoot();
    const on = makeEmitter({ root, respond: () => ({ status: 503, ok: false, detail: "down" }) });
    await on.emitter.emit("2026-07-26");
    expect(on.emitter.status("2026-07-26")!.central.attempts).toBe(1);

    const off = makeEmitter({ root, consent: userConsent(false, Date.now()) });
    off.emitter.applyConfigChange();
    expect(off.emitter.status("2026-07-26")!.central.attempts).toBe(0);
  });

  test("partial delivery is REPORTED, not hidden", async () => {
    const { emitter } = makeEmitter({ respond: (s) => ({ status: s.url.startsWith(CENTRAL) ? 202 : 500, ok: s.url.startsWith(CENTRAL), detail: undefined }) });
    const result = await emitter.emit("2026-07-26");
    expect(result.sent).toBe(true);
    if (result.sent) {
      expect(result.report.partial).toBe(true);
      expect(result.report.central.status).toBe("delivered");
      expect(result.report.copy!.status).toBe("pending");
    }
  });
});

describe("all three products assemble a valid document", () => {
  test("saga", () => {
    const root = tmpRoot();
    const emitter = new HeartbeatEmitter<"saga">({
      product: "saga",
      version: "0.3.0",
      identity: new IdentityStore({ stateRoot: root }),
      transport: new Transport({ stateRoot: root }),
      getConsent: () => CONSENT_ON,
      getEndpoints: () => ({ centralUrl: CENTRAL }),
      buildMetrics: (): SagaMetrics =>
        buildSagaMetrics({ deltas: { collect_runs_total: 3 }, connections: [{ engine: "mysql" }], uptimeSeconds: 100 }),
      platform: { os: "linux", arch: "x64" },
    });
    expect(validateHeartbeat(emitter.buildPayload("2026-07-26", "60e05bd1-b195-4f2f-9411-2fa7197a5c88")).ok).toBe(true);
  });

  test("skuld", () => {
    const root = tmpRoot();
    const emitter = new HeartbeatEmitter<"skuld">({
      product: "skuld",
      version: "0.2.1",
      identity: new IdentityStore({ stateRoot: root }),
      transport: new Transport({ stateRoot: root }),
      getConsent: () => CONSENT_ON,
      getEndpoints: () => ({ centralUrl: CENTRAL }),
      buildMetrics: (): SkuldMetrics => buildSkuldMetrics({ deltas: { runs_total: 2 }, detectionState: 0, uptimeSeconds: 100 }),
      platform: { os: "darwin", arch: "arm64" },
    });
    expect(validateHeartbeat(emitter.buildPayload("2026-07-26", "60e05bd1-b195-4f2f-9411-2fa7197a5c88")).ok).toBe(true);
  });
});

describe("a day whose retry crossed midnight is not lost", () => {
  test("emit() re-attempts an earlier unresolved day alongside the current one", async () => {
    const root = tmpRoot();
    let fail = true;
    const failing = makeEmitter({
      root,
      endpoints: { centralUrl: CENTRAL },
      respond: () => (fail ? { status: 503, ok: false, detail: "down" } : { status: 202, ok: true, detail: undefined }),
    });
    // Day 2026-07-26 fails.
    await failing.emitter.emit("2026-07-26");
    expect(failing.emitter.status("2026-07-26")!.central.status).toBe("pending");

    // The next day the emitter's candidate has rolled forward. Without a drain the 26th would
    // never be revisited and would age out of retention unsent.
    fail = false;
    // The clock moves past midnight AND past the failed attempt's backoff window.
    const next = makeEmitter({ root, endpoints: { centralUrl: CENTRAL }, nowMs: Date.parse("2026-07-28T06:00:00.000Z") });
    const result = await next.emitter.emit("2026-07-27");

    expect(result.sent).toBe(true);
    if (result.sent) {
      expect(result.report.day).toBe("2026-07-27");
      expect(result.drained.map((r) => r.day)).toEqual(["2026-07-26"]);
      expect(result.drained[0]!.central.status).toBe("delivered");
    }
    expect(next.emitter.status("2026-07-26")!.central.status).toBe("delivered");
  });

  test("nothing is drained when every earlier day is already resolved", async () => {
    const root = tmpRoot();
    const first = makeEmitter({ root, endpoints: { centralUrl: CENTRAL } });
    await first.emitter.emit("2026-07-26");
    const second = makeEmitter({ root, endpoints: { centralUrl: CENTRAL }, nowMs: Date.parse("2026-07-28T06:00:00.000Z") });
    const result = await second.emitter.emit("2026-07-27");
    expect(result.sent && result.drained).toEqual([]);
  });
});

describe("a removed endpoint does not escape the purge fences", () => {
  test("opting out with NO central configured still purges pending payloads", async () => {
    const root = tmpRoot();
    const failing = makeEmitter({ root, endpoints: { centralUrl: CENTRAL }, respond: () => ({ status: 503, ok: false, detail: "down" }) });
    await failing.emitter.emit("2026-07-26");
    expect(failing.emitter.status("2026-07-26")!.central.attempts).toBe(1);

    // Consent is withdrawn AND the endpoint is gone. Checking the configuration first meant this
    // returned "misconfigured" and never reached the fence, leaving the payload on disk.
    const off = makeEmitter({ root, endpoints: { centralUrl: "" }, consent: userConsent(false, Date.now()) });
    const result = await off.emitter.emit("2026-07-26");
    expect(result).toMatchObject({ sent: false, reason: "opted_out" });

    const check = makeEmitter({ root, endpoints: { centralUrl: CENTRAL } });
    expect(check.emitter.status("2026-07-26")!.central.attempts).toBe(0);
  });

  test("REMOVING central retires it — its queued deliveries and payloads are purged", async () => {
    const root = tmpRoot();
    const failing = makeEmitter({ root, endpoints: { centralUrl: CENTRAL }, respond: () => ({ status: 503, ok: false, detail: "down" }) });
    await failing.emitter.emit("2026-07-26");

    // Consent is unchanged; only the endpoint was removed. Both the emit path and the explicit
    // config-change path must fence it.
    const removed = makeEmitter({ root, endpoints: { centralUrl: "" } });
    const result = await removed.emitter.emit("2026-07-26");
    expect(result).toMatchObject({ sent: false, reason: "misconfigured" });

    const check = makeEmitter({ root, endpoints: { centralUrl: CENTRAL } });
    expect(check.emitter.status("2026-07-26")!.central.attempts).toBe(0);
  });

  test("applyConfigChange fences a removed central too", async () => {
    const root = tmpRoot();
    const failing = makeEmitter({ root, endpoints: { centralUrl: CENTRAL }, respond: () => ({ status: 503, ok: false, detail: "down" }) });
    await failing.emitter.emit("2026-07-26");

    const removed = makeEmitter({ root, endpoints: { centralUrl: "" } });
    removed.emitter.applyConfigChange();

    const check = makeEmitter({ root, endpoints: { centralUrl: CENTRAL } });
    expect(check.emitter.status("2026-07-26")!.central.attempts).toBe(0);
  });
});

describe("a malformed endpoint is a misconfiguration, not an exception", () => {
  for (const bad of ["ftp://collector.example.com", "not a url", "https://user:pw@collector.example.com", "https://"]) {
    test(`emit() with ${JSON.stringify(bad)} returns misconfigured and never throws`, async () => {
      const { emitter, sent } = makeEmitter({ endpoints: { centralUrl: bad } });
      const result = await emitter.emit("2026-07-26");
      expect(result).toMatchObject({ sent: false, reason: "misconfigured" });
      expect(sent).toHaveLength(0);
    });
  }

  test("a malformed endpoint PURGES the previous endpoint's pending payload", async () => {
    const root = tmpRoot();
    const failing = makeEmitter({ root, endpoints: { centralUrl: CENTRAL }, respond: () => ({ status: 503, ok: false, detail: "down" }) });
    await failing.emitter.emit("2026-07-26");
    expect(failing.emitter.status("2026-07-26")!.central.attempts).toBe(1);

    // Presence is not validity: an endpoint edited into something unusable used to sail past the
    // fence and throw deep inside the transport, leaving the old payload retained.
    const broken = makeEmitter({ root, endpoints: { centralUrl: "ftp://collector.example.com" } });
    expect((await broken.emitter.emit("2026-07-26")).sent).toBe(false);

    const check = makeEmitter({ root, endpoints: { centralUrl: CENTRAL } });
    expect(check.emitter.status("2026-07-26")!.central.attempts).toBe(0);
  });

  test("a malformed COPY endpoint does not throw either", async () => {
    const { emitter, sent } = makeEmitter({ endpoints: { centralUrl: CENTRAL, copyUrl: "gopher://ops.example.net" } });
    const result = await emitter.emit("2026-07-26");
    expect(result).toMatchObject({ sent: false, reason: "misconfigured" });
    expect(sent).toHaveLength(0);
  });

  test("applyConfigChange never throws on a malformed endpoint, and fences", async () => {
    const root = tmpRoot();
    const failing = makeEmitter({ root, endpoints: { centralUrl: CENTRAL }, respond: () => ({ status: 503, ok: false, detail: "down" }) });
    await failing.emitter.emit("2026-07-26");

    const broken = makeEmitter({ root, endpoints: { centralUrl: "://nonsense" } });
    expect(() => broken.emitter.applyConfigChange()).not.toThrow();

    const check = makeEmitter({ root, endpoints: { centralUrl: CENTRAL } });
    expect(check.emitter.status("2026-07-26")!.central.attempts).toBe(0);
  });
});
