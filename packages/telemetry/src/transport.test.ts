import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertDestinations,
  deliveryStateFilePath,
  destinationGeneration,
  ingestUrlFor,
  Transport,
  TransportConfigError,
  describeSendReport,
  TRANSPORT_REASONS,
  type DeliveryRecord,
  type DestinationKind,
  type TransportOptions,
} from "./transport.ts";
import { userConsent, type ConsentState } from "./optout.ts";
import { EndpointRejected, type PinnedEndpoint, type PostResult } from "./ssrf.ts";
import type { InstanceIdentity } from "./identity.ts";

const DAY = "2026-07-26";
const CENTRAL_URL = "https://telemetry.example.com";
const COPY_URL = "https://ops.example.net/collect";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mythical-telemetry-transport-"));
}

function identity(seed: string): InstanceIdentity {
  return {
    instance_secret: seed.repeat(64).slice(0, 64),
    instance_id: "60e05bd1-b195-4f2f-9411-2fa7197a5c88",
    created_at: "2026-01-01T00:00:00.000Z",
    rotated_at: "2026-01-01T00:00:00.000Z",
  };
}

interface Attempt {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function harness(
  responder: (attempt: Attempt) => Promise<PostResult> | PostResult,
  overrides: Partial<TransportOptions> = {},
): { transport: Transport; attempts: Attempt[]; root: string; now: { value: number } } {
  const root = overrides.stateRoot ?? tmpRoot();
  const attempts: Attempt[] = [];
  const now = { value: Date.parse("2026-07-27T06:00:00.000Z") };
  const transport = new Transport({
    stateRoot: root,
    nowMs: () => now.value,
    random: () => 0.5,
    resolveImpl: async (url): Promise<PinnedEndpoint> => ({
      url: new URL(url),
      address: "93.184.216.34",
      family: 4,
      literal: false,
    }),
    postImpl: async (args): Promise<PostResult> => {
      const attempt: Attempt = { url: args.endpoint.url.toString(), headers: args.headers, body: args.body };
      attempts.push(attempt);
      return responder(attempt);
    },
    ...overrides,
  });
  return { transport, attempts, root, now };
}

const OK: PostResult = { status: 202, ok: true };
const FAIL: PostResult = { status: 503, ok: false };

/** The whole delivery document, as it actually is on disk. */
function readStateFile(root: string): { records: Record<string, DeliveryRecord>; breakers: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(deliveryStateFilePath(root), "utf8")) as {
    records: Record<string, DeliveryRecord>;
    breakers: Record<string, unknown>;
  };
}

/**
 * Put a record into a state the test needs, ON DISK.
 *
 * `record()` hands back a detached snapshot, so mutating it changes nothing — deliberately. The
 * transport re-reads the document immediately before every write and keeps no in-memory copy, which
 * is the whole fix for two writers erasing each other, and it leaves a test no object to reach into.
 */
function patchRecordOnDisk(root: string, day: string, kind: DestinationKind, destination: string, patch: Partial<DeliveryRecord>): void {
  const state = readStateFile(root);
  const rec = state.records[`${day}|${kind}|${destination}`];
  if (rec === undefined) throw new Error(`no ${kind} record for ${day} at ${destination}`);
  Object.assign(rec, patch);
  fs.writeFileSync(deliveryStateFilePath(root), JSON.stringify(state, null, 2));
}

function sendInput(consent: ConsentState = userConsent(true, Date.parse("2026-01-01T00:00:00.000Z")), withCopy = true) {
  return {
    day: DAY,
    product: "brokkr" as const,
    consent,
    central: { url: CENTRAL_URL, identity: identity("a"), body: '{"central":true}' },
    copy: withCopy ? { url: COPY_URL, identity: identity("b"), body: '{"copy":true}' } : undefined,
  };
}

describe("configuration rules", () => {
  test("copy-without-central is REJECTED, not tolerated", () => {
    expect(() => assertDestinations({ central: undefined, copy: { url: COPY_URL } })).toThrow(TransportConfigError);
    try {
      assertDestinations({ central: undefined, copy: { url: COPY_URL } });
    } catch (err) {
      expect((err as TransportConfigError).reason).toBe("copy_without_central");
    }
  });

  test("no destination at all is rejected too", () => {
    expect(() => assertDestinations({})).toThrow(/central destination is required/);
  });

  test("central alone is valid", () => {
    expect(() => assertDestinations({ central: { url: CENTRAL_URL } })).not.toThrow();
  });

  test("a copy pointing at the SAME endpoint as central is rejected", async () => {
    const { transport } = harness(() => OK);
    await expect(
      transport.send({ ...sendInput(), copy: { url: `${CENTRAL_URL}/`, identity: identity("b"), body: "{}" } }),
    ).rejects.toThrow(/must differ from central/);
  });

  test("ingestUrlFor appends the route and preserves a query string", () => {
    expect(ingestUrlFor("https://telemetry.example.com")).toBe("https://telemetry.example.com/api/v1/ingest");
    expect(ingestUrlFor("https://ops.example.net/collect")).toBe("https://ops.example.net/collect/api/v1/ingest");
    expect(ingestUrlFor("https://ops.example.net/collect?tenant=7")).toBe("https://ops.example.net/collect/api/v1/ingest?tenant=7");
  });
});

describe("dual-send", () => {
  test("sends to BOTH destinations, each with its own body and its own secret", async () => {
    const { transport, attempts } = harness(() => OK);
    const report = await transport.send(sendInput());

    expect(report.central.status).toBe("delivered");
    expect(report.copy!.status).toBe("delivered");
    expect(report.partial).toBe(false);
    expect(attempts).toHaveLength(2);

    const central = attempts.find((a) => a.url.startsWith(CENTRAL_URL))!;
    const copy = attempts.find((a) => a.url.startsWith("https://ops.example.net"))!;
    expect(central.body).toBe('{"central":true}');
    expect(copy.body).toBe('{"copy":true}');
    // The copy NEVER receives the central secret.
    expect(copy.headers["X-Mythical-Write-Key"]).not.toBe(central.headers["X-Mythical-Write-Key"]);
    expect(central.headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(copy.headers["Idempotency-Key"]).not.toBe(central.headers["Idempotency-Key"]);
  });

  test("A FLAKY COPY DOES NOT SUPPRESS CENTRAL", async () => {
    const { transport } = harness((a) => (a.url.startsWith(CENTRAL_URL) ? OK : FAIL));
    const report = await transport.send(sendInput());
    expect(report.central.status).toBe("delivered");
    expect(report.copy!.status).toBe("pending");
    expect(report.partial).toBe(true);
    expect(describeSendReport(report)).toContain("central delivered");
  });

  test("A CENTRAL OUTAGE DOES NOT SUPPRESS THE COPY", async () => {
    const { transport } = harness((a) => (a.url.startsWith(CENTRAL_URL) ? FAIL : OK));
    const report = await transport.send(sendInput());
    expect(report.central.status).toBe("pending");
    expect(report.copy!.status).toBe("delivered");
    expect(report.partial).toBe(true);
  });

  test("a THROWING copy destination does not reject the whole send", async () => {
    const { transport } = harness((a) => {
      if (a.url.startsWith(CENTRAL_URL)) return OK;
      throw new EndpointRejected("address_blocked", "resolves to 127.0.0.1");
    });
    const report = await transport.send(sendInput());
    expect(report.central.status).toBe("delivered");
    expect(report.copy!.last_error).toContain("address_blocked");
  });
});

describe("per-destination durable delivery state", () => {
  test("a delivered central is NOT re-sent while the copy keeps retrying", async () => {
    const root = tmpRoot();
    const { transport, attempts, now } = harness((a) => (a.url.startsWith(CENTRAL_URL) ? OK : FAIL), { stateRoot: root });

    await transport.send(sendInput());
    expect(attempts).toHaveLength(2);

    now.value += 24 * 3_600_000; // past any backoff
    await transport.send(sendInput());

    // Exactly ONE further attempt, and it is the copy. The single per-day marker this design
    // replaces would either have re-sent central or frozen the copy.
    expect(attempts).toHaveLength(3);
    expect(attempts[2]!.url.startsWith("https://ops.example.net")).toBe(true);
  });

  test("state survives a process restart", async () => {
    const root = tmpRoot();
    const first = harness(() => OK, { stateRoot: root });
    await first.transport.send(sendInput());

    const second = harness(() => OK, { stateRoot: root });
    expect(second.transport.record(DAY, "central", CENTRAL_URL)?.status).toBe("delivered");

    const report = await second.transport.send(sendInput());
    expect(report.central.status).toBe("delivered");
    expect(second.attempts).toHaveLength(0); // nothing re-sent
  });

  test("the attempt is recorded BEFORE the request, so a crash cannot look like no attempt", async () => {
    const root = tmpRoot();
    const { transport } = harness(() => {
      const state = JSON.parse(fs.readFileSync(deliveryStateFilePath(root), "utf8")) as {
        records: Record<string, { attempts: number }>;
      };
      // Read from DISK while the request is notionally in flight.
      expect(Object.values(state.records)[0]!.attempts).toBe(1);
      return OK;
    }, { stateRoot: root, maxConcurrency: 1 });
    await transport.send({ ...sendInput(), copy: undefined });
  });

  test("the delivery state never contains a secret", async () => {
    const root = tmpRoot();
    const { transport } = harness(() => FAIL, { stateRoot: root });
    await transport.send(sendInput());
    const raw = fs.readFileSync(deliveryStateFilePath(root), "utf8");
    expect(raw).not.toContain(identity("a").instance_secret);
    expect(raw).not.toContain(identity("b").instance_secret);
  });

  test("a corrupt delivery-state file degrades to empty rather than throwing", async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
    fs.writeFileSync(deliveryStateFilePath(root), "{{{");
    const { transport } = harness(() => OK, { stateRoot: root });
    expect((await transport.send(sendInput())).central.status).toBe("delivered");
  });
});

describe("two writers on one state directory", () => {
  // Each Transport is an independent writer of the same document — which is what a second process
  // is, from the file's point of view. The defect these pin was a remembered copy of the whole
  // document: a writer that had read it once wrote that remembered version back on every save, so
  // whatever anyone else had recorded since was not merely stale, it was ERASED. Delivery records
  // are the only thing that stops a day being sent twice and the only proof an opt-out purged a
  // pending payload, so losing them wholesale is worse than losing a field.
  //
  // WHAT THESE DO NOT TEST, so nobody reads more into them than is there: they cannot interleave
  // two writers INSIDE one read-modify-write. Nothing in one process can — that is precisely why
  // the read-modify-write is synchronous. The residual window it leaves is stated in the README,
  // not tested away here.

  test("a writer that read the document earlier does not erase what was written since", async () => {
    const root = tmpRoot();
    const a = harness(() => OK, { stateRoot: root });
    const b = harness(() => OK, { stateRoot: root });

    // B looks at the state before anything exists. This is the read that used to be remembered for
    // the rest of B's life.
    expect(b.transport.status({ day: DAY, central: { url: CENTRAL_URL } }).central.attempts).toBe(0);

    await a.transport.send({ ...sendInput(), day: "2026-07-20", copy: undefined });
    await b.transport.send({ ...sendInput(), day: "2026-07-21", copy: undefined });

    expect(Object.keys(readStateFile(root).records).sort()).toEqual([
      `2026-07-20|central|${CENTRAL_URL}`,
      `2026-07-21|central|${CENTRAL_URL}`,
    ]);
    expect(a.transport.record("2026-07-20", "central", CENTRAL_URL)?.status).toBe("delivered");
    expect(a.transport.record("2026-07-21", "central", CENTRAL_URL)?.status).toBe("delivered");
  });

  test("a delivery landing does not erase a record written while its request was in flight", async () => {
    const root = tmpRoot();
    let other: Promise<unknown> | undefined;
    const a = harness(async () => {
      // The other writer records a whole delivery DURING this request — the window a read-modify-
      // write that spans an HTTP round trip leaves open, and the one that used to swallow the lot.
      other ??= b.transport.send({ ...sendInput(), day: "2026-07-21", copy: undefined });
      await other;
      return OK;
    }, { stateRoot: root });
    const b = harness(() => OK, { stateRoot: root });

    await a.transport.send({ ...sendInput(), day: "2026-07-20", copy: undefined });

    const records = readStateFile(root).records;
    expect(Object.keys(records).sort()).toEqual([`2026-07-20|central|${CENTRAL_URL}`, `2026-07-21|central|${CENTRAL_URL}`]);
    expect(records[`2026-07-20|central|${CENTRAL_URL}`]!.status).toBe("delivered");
    expect(records[`2026-07-21|central|${CENTRAL_URL}`]!.status).toBe("delivered");
  });

  test("a fence by the other writer is not undone by a reply that arrives after it", async () => {
    const root = tmpRoot();
    let fenced = false;
    const a = harness(() => {
      if (!fenced) {
        fenced = true;
        b.transport.fenceAll("the other writer's user opted out");
      }
      return OK;
    }, { stateRoot: root });
    const b = harness(() => OK, { stateRoot: root });

    const report = await a.transport.send({ ...sendInput(), copy: undefined });

    // The record was purged mid-flight. A late success must not resurrect it, and above all must
    // not put the payload the opt-out purged back on disk.
    expect(fenced).toBe(true);
    expect(a.transport.record(DAY, "central", CENTRAL_URL)).toBeUndefined();
    expect(fs.readFileSync(deliveryStateFilePath(root), "utf8")).not.toContain("central\\\":true");
    expect(report.central.status).toBe("pending");
  });

  test("a late reply does not land on the DIFFERENT delivery that replaced it at the same key", async () => {
    // A fence purges a pending delivery and a new one is started for the same day and destination
    // under a new credential — same key, new generation. Matching the late reply on the key alone
    // would mark that new delivery delivered on the strength of a request made under the OLD
    // configuration, drop the payload it is still holding, and the send that was actually
    // authorised would never happen. Worse than doing nothing, so it is not done.
    const root = tmpRoot();
    let rotated = false;
    const a = harness(async () => {
      if (!rotated) {
        rotated = true;
        await b.transport.send({
          ...sendInput(),
          central: { url: CENTRAL_URL, identity: identity("z"), body: '{"rotated":true}' },
          copy: undefined,
        });
      }
      return OK;
    }, { stateRoot: root });
    const b = harness(() => FAIL, { stateRoot: root });

    await a.transport.send({ ...sendInput(), copy: undefined });

    expect(rotated).toBe(true);
    const rec = readStateFile(root).records[`${DAY}|central|${CENTRAL_URL}`]!;
    expect(rec.status).toBe("pending");
    expect(rec.body).toBe('{"rotated":true}');
    expect(rec.last_http_status).toBe(503); // the rotated delivery's own result, not the old one's
  });

  test("a late failure does not annotate a delivery another writer already completed", async () => {
    // Both writers attempt the same day and destination; one succeeds, the other's request fails
    // afterwards. Delivered is terminal and is a fact — writing the failure onto it would report an
    // error against a delivery that happened, and would count toward a circuit breaker against a
    // destination that has just accepted one, suppressing later days over an outage that is not
    // happening.
    const root = tmpRoot();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = harness(
      async () => {
        await held;
        return FAIL;
      },
      { stateRoot: root, baseBackoffMs: 0, breakerThreshold: 1, breakerCooldownMs: 7 * 24 * 3_600_000 },
    );
    const quick = harness(() => OK, { stateRoot: root, baseBackoffMs: 0 });

    const slowSend = slow.transport.send({ ...sendInput(), copy: undefined });
    await Bun.sleep(10); // the slow writer has claimed its attempt and is inside its request
    await quick.transport.send({ ...sendInput(), copy: undefined });
    expect(quick.transport.record(DAY, "central", CENTRAL_URL)?.status).toBe("delivered");
    release!();
    await slowSend;

    const rec = readStateFile(root).records[`${DAY}|central|${CENTRAL_URL}`]!;
    expect(rec.status).toBe("delivered");
    expect(rec.last_error).toBeNull();
    expect(rec.last_http_status).toBe(202);
    for (const breaker of Object.values(readStateFile(root).breakers) as Array<{ consecutive_failures: number; open_until: string | null }>) {
      expect(breaker.consecutive_failures).toBe(0);
      expect(breaker.open_until).toBeNull();
    }
  });

  test("record() hands back a snapshot, not a handle into live state", async () => {
    const root = tmpRoot();
    const { transport } = harness(() => FAIL, { stateRoot: root });
    await transport.send({ ...sendInput(), copy: undefined });

    const snapshot = transport.record(DAY, "central", CENTRAL_URL)!;
    snapshot.attempts = 999;
    snapshot.status = "delivered";

    expect(transport.record(DAY, "central", CENTRAL_URL)!.attempts).toBe(1);
    expect(readStateFile(root).records[`${DAY}|central|${CENTRAL_URL}`]!.status).toBe("pending");
  });
});

describe("bounded attempts, jitter, backoff and the circuit breaker", () => {
  test("a retry is not attempted before its backoff elapses", async () => {
    const { transport, attempts, now } = harness(() => FAIL);
    await transport.send(sendInput());
    expect(attempts).toHaveLength(2);

    now.value += 1000; // well inside the backoff window
    const report = await transport.send(sendInput());
    expect(attempts).toHaveLength(2);
    expect(report.central.skipped_because).toBe("backoff");
  });

  test("backoff grows and is jittered — a fleet does not retry in lockstep", async () => {
    const early = harness(() => FAIL, { random: () => 0 });
    await early.transport.send({ ...sendInput(), copy: undefined });
    const late = harness(() => FAIL, { random: () => 1 });
    await late.transport.send({ ...sendInput(), copy: undefined });

    const earlyNext = Date.parse(early.transport.record(DAY, "central", CENTRAL_URL)!.next_attempt_at!);
    const lateNext = Date.parse(late.transport.record(DAY, "central", CENTRAL_URL)!.next_attempt_at!);
    expect(lateNext).toBeGreaterThan(earlyNext);
  });

  test("attempts are BOUNDED — a permanently broken endpoint stops instead of spinning", async () => {
    const { transport, attempts, now } = harness(() => FAIL, { maxAttempts: 3, breakerThreshold: 99 });
    for (let i = 0; i < 8; i++) {
      await transport.send({ ...sendInput(), copy: undefined });
      now.value += 24 * 3_600_000; // stays inside the retention window; only the cap stops it
    }
    expect(attempts).toHaveLength(3);
    expect(transport.record(DAY, "central", CENTRAL_URL)?.status).toBe("exhausted");
  });

  test("the circuit breaker opens after repeated failure and suppresses further contact", async () => {
    const { transport, attempts, now } = harness(() => FAIL, {
      breakerThreshold: 2,
      maxAttempts: 99,
      breakerCooldownMs: 7 * 24 * 3_600_000,
    });
    for (let i = 0; i < 4; i++) {
      await transport.send({ ...sendInput(), copy: undefined });
      now.value += 24 * 3_600_000;
    }
    expect(attempts.length).toBeLessThan(4);
    const report = transport.status({ day: DAY, central: { url: CENTRAL_URL } });
    expect(report.central.status).toBe("pending");
  });

  test("a success resets the breaker", async () => {
    let fail = true;
    const { transport, now } = harness(() => (fail ? FAIL : OK), { breakerThreshold: 2, maxAttempts: 99 });
    await transport.send({ ...sendInput(), copy: undefined });
    now.value += 24 * 3_600_000;
    fail = false;
    await transport.send({ ...sendInput(), copy: undefined });
    const state = JSON.parse(fs.readFileSync(deliveryStateFilePath((transport as unknown as { opts: { stateRoot: string } }).opts.stateRoot), "utf8")) as {
      breakers: Record<string, { consecutive_failures: number }>;
    };
    for (const breaker of Object.values(state.breakers)) expect(breaker.consecutive_failures).toBe(0);
  });
});

describe("single-flight", () => {
  test("two concurrent sends for the same day open ONE request per destination", async () => {
    let resolveFirst: ((value: PostResult) => void) | undefined;
    const gate = new Promise<PostResult>((resolve) => {
      resolveFirst = resolve;
    });
    const { transport, attempts } = harness(() => gate);

    const a = transport.send({ ...sendInput(), copy: undefined });
    const b = transport.send({ ...sendInput(), copy: undefined });
    resolveFirst!(OK);
    const [first, second] = await Promise.all([a, b]);

    expect(attempts).toHaveLength(1);
    expect(first.central.status).toBe("delivered");
    expect(second.central.status).toBe("delivered");
    expect(second.central.skipped_because).toBe("in_flight");
  });
});

describe("fences", () => {
  const CONSENT = userConsent(true, Date.parse("2026-01-01T00:00:00.000Z"));

  test("OPT-OUT is a hard fence: nothing is sent and pending state is purged", async () => {
    const root = tmpRoot();
    const { transport, attempts, now } = harness(() => FAIL, { stateRoot: root });
    await transport.send(sendInput(CONSENT));
    expect(attempts).toHaveLength(2);
    expect(transport.record(DAY, "central", CENTRAL_URL)).toBeDefined();

    now.value += 24 * 3_600_000;
    const report = await transport.send(sendInput(userConsent(false, now.value), true));

    expect(attempts).toHaveLength(2); // no further egress
    expect(report.central.skipped_because).toBe("opted_out");
    expect(report.copy!.skipped_because).toBe("opted_out");
    expect(transport.record(DAY, "central", CENTRAL_URL)).toBeUndefined();
    expect(transport.record(DAY, "copy", COPY_URL)).toBeUndefined();
  });

  test("opt-out does NOT erase the record of what was already delivered", async () => {
    const { transport, now } = harness(() => OK);
    await transport.send(sendInput(CONSENT));
    now.value += 3_600_000;
    await transport.send(sendInput(userConsent(false, now.value)));
    expect(transport.record(DAY, "central", CENTRAL_URL)?.status).toBe("delivered");
  });

  test("CHANGING ONLY THE COPY URL does not cancel an unresolved CENTRAL delivery", async () => {
    const root = tmpRoot();
    const { transport, now } = harness(() => FAIL, { stateRoot: root });
    await transport.send(sendInput(CONSENT));

    const centralBefore = transport.record(DAY, "central", CENTRAL_URL)!;
    expect(centralBefore.attempts).toBe(1);

    now.value += 1_000; // inside central's backoff — a surviving record must NOT be re-attempted
    await transport.send({
      ...sendInput(CONSENT),
      copy: { url: "https://different.example.org", identity: identity("c"), body: "{}" },
    });

    // Central's record survives, attempt count intact — its consent and configuration never changed.
    // Had the copy's URL change fenced central too, the record would have been recreated and this
    // would read 1 again for a different reason, which is why first_attempt_at is checked as well.
    const centralAfter = transport.record(DAY, "central", CENTRAL_URL)!;
    expect(centralAfter.attempts).toBe(1);
    expect(centralAfter.next_attempt_at).toBe(centralBefore.next_attempt_at);
    expect(centralAfter.first_attempt_at).toBe(centralBefore.first_attempt_at);
    // The retired copy destination's state is gone.
    expect(transport.record(DAY, "copy", COPY_URL)).toBeUndefined();
    expect(transport.record(DAY, "copy", "https://different.example.org")).toBeDefined();
  });

  test("a CENTRAL credential rotation fences central's pending retry but not the copy's", async () => {
    const { transport, now } = harness(() => FAIL);
    await transport.send(sendInput(CONSENT));
    const copyBefore = transport.record(DAY, "copy", COPY_URL)!;

    now.value += 60_000;
    await transport.send({
      ...sendInput(CONSENT),
      central: { url: CENTRAL_URL, identity: identity("z"), body: '{"central":true}' },
    });

    expect(transport.record(DAY, "central", CENTRAL_URL)!.attempts).toBe(1); // fenced and restarted
    expect(transport.record(DAY, "copy", COPY_URL)!.first_attempt_at).toBe(copyBefore.first_attempt_at);
  });

  test("fenceAll cancels everything, fenceDestination only its own kind", async () => {
    const { transport } = harness(() => FAIL);
    await transport.send(sendInput(CONSENT));
    transport.fenceDestination("copy", undefined, undefined);
    expect(transport.record(DAY, "copy", COPY_URL)).toBeUndefined();
    expect(transport.record(DAY, "central", CENTRAL_URL)).toBeDefined();

    transport.fenceAll();
    expect(transport.record(DAY, "central", CENTRAL_URL)).toBeUndefined();
  });

  test("the generation changes with consent, endpoint or credential", () => {
    const consent = userConsent(true, Date.parse("2026-01-01T00:00:00.000Z"));
    const base = destinationGeneration(consent, "central", CENTRAL_URL, "secret-a");
    expect(destinationGeneration(consent, "central", CENTRAL_URL, "secret-b")).not.toBe(base);
    expect(destinationGeneration(consent, "central", "https://elsewhere.example.com", "secret-a")).not.toBe(base);
    expect(destinationGeneration(userConsent(true, Date.parse("2026-02-01T00:00:00.000Z")), "central", CENTRAL_URL, "secret-a")).not.toBe(base);
    expect(destinationGeneration(consent, "copy", CENTRAL_URL, "secret-a")).not.toBe(base);
    // The secret is hashed into the generation, never stored beside it.
    expect(base).not.toContain("secret-a");
  });
});

describe("overall budget", () => {
  test("a hung destination is abandoned at the budget, and the other still reports", async () => {
    const { transport } = harness(
      (a) =>
        a.url.startsWith(CENTRAL_URL)
          ? OK
          : new Promise<PostResult>((_resolve, reject) => {
              setTimeout(() => reject(new EndpointRejected("aborted", "attempt aborted")), 5_000);
            }),
      { overallBudgetMs: 60, maxConcurrency: 2 },
    );
    const report = await transport.send(sendInput());
    expect(report.central.status).toBe("delivered");
    expect(report.copy!.status).toBe("pending");
  }, 10_000);
});

describe("status()", () => {
  test("reports partial state without sending anything", async () => {
    const { transport, attempts } = harness((a) => (a.url.startsWith(CENTRAL_URL) ? OK : FAIL));
    await transport.send(sendInput());
    const before = attempts.length;
    const report = transport.status({ day: DAY, central: { url: CENTRAL_URL }, copy: { url: COPY_URL } });
    expect(attempts).toHaveLength(before);
    expect(report.central.status).toBe("delivered");
    expect(report.copy!.status).toBe("pending");
    expect(report.partial).toBe(true);
    expect(report.copy!.last_error).toContain("503");
  });

  test("an unknown day reads as pending with zero attempts, not as an error", () => {
    const { transport } = harness(() => OK);
    const report = transport.status({ day: "2020-01-01", central: { url: CENTRAL_URL } });
    expect(report.central).toMatchObject({ status: "pending", attempts: 0 });
    expect(report.copy).toBeNull();
  });
});

describe("the fence reaches a request that is still resolving DNS", () => {
  test("an opt-out during a stalled lookup means the request is NEVER posted", async () => {
    let releaseResolve: (() => void) | undefined;
    const resolving = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const { transport, attempts } = harness(() => OK, {
      resolveImpl: async (url, policy): Promise<PinnedEndpoint> => {
        // Stall here, exactly where DNS would, and honour the signal the transport handed us.
        await Promise.race([
          resolving,
          new Promise<void>((_r, reject) => {
            policy.signal?.addEventListener("abort", () => reject(new EndpointRejected("aborted", "resolution aborted")), { once: true });
          }),
        ]);
        return { url: new URL(url), address: "93.184.216.34", family: 4, literal: false };
      },
    });

    const inFlight = transport.send({ ...sendInput(), copy: undefined });
    await Bun.sleep(20);
    transport.fenceAll("user opted out");
    releaseResolve!();
    const report = await inFlight;

    // The POST never happened: the fence cancelled a request the old code could only cancel once
    // it had already reached the socket.
    expect(attempts).toHaveLength(0);
    expect(report.central.status).toBe("pending");
    // ...and the fence purged the pending record along with its payload.
    expect(transport.record(DAY, "central", CENTRAL_URL)).toBeUndefined();
  });

  test("the resolver is handed the attempt's abort signal", async () => {
    let seenSignal: AbortSignal | undefined;
    const { transport } = harness(() => OK, {
      resolveImpl: async (url, policy): Promise<PinnedEndpoint> => {
        seenSignal = policy.signal;
        return { url: new URL(url), address: "93.184.216.34", family: 4, literal: false };
      },
    });
    await transport.send({ ...sendInput(), copy: undefined });
    expect(seenSignal).toBeDefined();
  });
});

describe("unresolved days survive the day rolling over", () => {
  test("a day that fails on the 27th is RE-SENT on the 28th, not silently lost", async () => {
    const root = tmpRoot();
    let fail = true;
    const { transport, attempts, now } = harness(() => (fail ? FAIL : OK), { stateRoot: root });

    await transport.send({ ...sendInput(), copy: undefined }); // day = 2026-07-26, fails
    expect(transport.record(DAY, "central", CENTRAL_URL)?.status).toBe("pending");

    // Midnight passes: the emitter's candidate day is now 2026-07-27 and nothing would ever
    // revisit the 26th without an explicit drain.
    now.value += 24 * 3_600_000;
    fail = false;
    const drained = await transport.drain({
      product: "brokkr",
      consent: userConsent(true, Date.parse("2026-01-01T00:00:00.000Z")),
      central: { url: CENTRAL_URL, identity: identity("a") },
      exceptDay: "2026-07-27",
    });

    expect(drained).toHaveLength(1);
    expect(drained[0]!.day).toBe(DAY);
    expect(drained[0]!.central.status).toBe("delivered");
    // The RE-SENT bytes are the ones the delivery was created with — a delta producer cannot
    // rebuild an older day, and the idempotency key is derived from that same document.
    expect(attempts[1]!.body).toBe('{"central":true}');
    expect(attempts[1]!.headers["Idempotency-Key"]).toBe(attempts[0]!.headers["Idempotency-Key"]);
  });

  test("a drain never re-sends a day that was already delivered", async () => {
    const { transport, attempts, now } = harness(() => OK);
    await transport.send({ ...sendInput(), copy: undefined });
    now.value += 24 * 3_600_000;
    const drained = await transport.drain({
      product: "brokkr",
      consent: userConsent(true, Date.parse("2026-01-01T00:00:00.000Z")),
      central: { url: CENTRAL_URL, identity: identity("a") },
      exceptDay: "2026-07-27",
    });
    expect(drained).toEqual([]);
    expect(attempts).toHaveLength(1);
  });

  test("a drain does NOT fence, so draining one day cannot purge another day's copy state", async () => {
    const { transport, now } = harness(() => FAIL);
    await transport.send(sendInput()); // both destinations pending for 2026-07-26
    now.value += 24 * 3_600_000;
    await transport.send({ ...sendInput(), day: "2026-07-27" });
    now.value += 24 * 3_600_000;

    await transport.drain({
      product: "brokkr",
      consent: userConsent(true, Date.parse("2026-01-01T00:00:00.000Z")),
      central: { url: CENTRAL_URL, identity: identity("a") },
      copy: { url: COPY_URL, identity: identity("b") },
      exceptDay: "2026-07-28",
    });

    expect(transport.record(DAY, "copy", COPY_URL)).toBeDefined();
    expect(transport.record("2026-07-27", "copy", COPY_URL)).toBeDefined();
  });

  test("an opt-out drains nothing", async () => {
    const { transport, attempts, now } = harness(() => FAIL);
    await transport.send({ ...sendInput(), copy: undefined });
    const before = attempts.length;
    now.value += 24 * 3_600_000;
    const drained = await transport.drain({
      product: "brokkr",
      consent: userConsent(false, now.value),
      central: { url: CENTRAL_URL, identity: identity("a") },
    });
    expect(drained).toEqual([]);
    expect(attempts).toHaveLength(before);
  });

  test("the retained payload is PURGED by the opt-out fence, not left on disk", async () => {
    const root = tmpRoot();
    const { transport, now } = harness(() => FAIL, { stateRoot: root });
    await transport.send({ ...sendInput(), copy: undefined });
    expect(fs.readFileSync(deliveryStateFilePath(root), "utf8")).toContain('{\\"central\\":true}');

    now.value += 3_600_000;
    await transport.send({ ...sendInput(userConsent(false, now.value)), copy: undefined });
    expect(fs.readFileSync(deliveryStateFilePath(root), "utf8")).not.toContain("central");
  });

  test("a delivered record does not keep its payload around", async () => {
    const root = tmpRoot();
    const { transport } = harness(() => OK, { stateRoot: root });
    await transport.send({ ...sendInput(), copy: undefined });
    expect(transport.record(DAY, "central", CENTRAL_URL)?.body).toBeUndefined();
  });

  test("a record with no retained payload is retired rather than posted empty", async () => {
    const root = tmpRoot();
    const { transport, attempts } = harness(() => OK, { stateRoot: root });
    fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
    fs.writeFileSync(
      deliveryStateFilePath(root),
      JSON.stringify({
        version: 1,
        records: {
          [`${DAY}|central|${CENTRAL_URL}`]: {
            day: DAY,
            kind: "central",
            destination: CENTRAL_URL,
            generation: "",
            idempotency_key: "k",
            attempts: 1,
            status: "pending",
          },
        },
        breakers: {},
      }),
    );
    await transport.drain({
      product: "brokkr",
      consent: userConsent(true, Date.parse("2026-01-01T00:00:00.000Z")),
      central: { url: CENTRAL_URL, identity: identity("a") },
      exceptDay: "2026-07-28",
    });
    expect(attempts).toHaveLength(0);
  });
});

describe("drain fences for itself — it does not assume a preceding send() did", () => {
  const CONSENT = userConsent(true, Date.parse("2026-01-01T00:00:00.000Z"));

  test("a retained body is NEVER re-sent under a rotated identity", async () => {
    const root = tmpRoot();
    const first = harness(() => FAIL, { stateRoot: root });
    await first.transport.send({ ...sendInput(CONSENT), copy: undefined });
    expect(first.transport.record(DAY, "central", CENTRAL_URL)?.body).toBe('{"central":true}');

    // The identity rotates. The stored body carries the OLD instance_id, so authenticating it with
    // the NEW secret would fail the collector's derived-identity check, burn attempts and could
    // exhaust the day. The fence purges it instead — a rotation is meant to orphan what came before.
    const second = harness(() => OK, { stateRoot: root, nowMs: undefined });
    const drained = await second.transport.drain({
      product: "brokkr",
      consent: CONSENT,
      central: { url: CENTRAL_URL, identity: identity("z") },
      exceptDay: "2026-07-28",
    });

    expect(drained).toEqual([]);
    expect(second.attempts).toHaveLength(0);
    expect(second.transport.record(DAY, "central", CENTRAL_URL)).toBeUndefined();
  });

  test("an opt-out reaching drain FIRST still fences everything", async () => {
    const root = tmpRoot();
    const first = harness(() => FAIL, { stateRoot: root });
    await first.transport.send({ ...sendInput(CONSENT), copy: undefined });

    const second = harness(() => OK, { stateRoot: root });
    const drained = await second.transport.drain({
      product: "brokkr",
      consent: userConsent(false, Date.now()),
      central: { url: CENTRAL_URL, identity: identity("a") },
    });
    expect(drained).toEqual([]);
    expect(second.transport.record(DAY, "central", CENTRAL_URL)).toBeUndefined();
  });

  test("a drain never CREATES a delivery for a destination that had none that day", async () => {
    const root = tmpRoot();
    const first = harness(() => FAIL, { stateRoot: root });
    await first.transport.send({ ...sendInput(CONSENT), copy: undefined }); // central only

    // A copy is configured later. Draining central's backlog must not mint a body-less copy record
    // for a day the copy was never configured for.
    const second = harness(() => OK, { stateRoot: root, nowMs: undefined });
    await second.transport.drain({
      product: "brokkr",
      consent: CONSENT,
      central: { url: CENTRAL_URL, identity: identity("a") },
      copy: { url: COPY_URL, identity: identity("b") },
      exceptDay: "2026-07-28",
    });
    expect(second.transport.record(DAY, "copy", COPY_URL)).toBeUndefined();
  });

  test("days in backoff do not consume the drain cap and starve newer eligible days", async () => {
    const root = tmpRoot();
    const { transport, now } = harness(() => FAIL, { stateRoot: root, maxAttempts: 99 });

    // Four consecutive days all fail. Each is left in backoff.
    for (const day of ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"]) {
      await transport.send({ ...sendInput(CONSENT), day, copy: undefined });
    }
    // Only the three OLDEST are still inside their backoff window; the newest is eligible.
    const oldest = ["2026-07-20", "2026-07-21", "2026-07-22"];
    for (const day of oldest) {
      patchRecordOnDisk(root, day, "central", CENTRAL_URL, { next_attempt_at: new Date(now.value + 10 * 24 * 3_600_000).toISOString() });
    }
    now.value += 3_600_000;

    const eligible = transport.unresolvedDays({ central: { url: CENTRAL_URL } });
    // The blocked days are excluded, so the cap is spent on the day that can actually be sent.
    expect(eligible).toEqual(["2026-07-23"]);
  });

  test("an open circuit breaker also keeps a day out of the drain cap", async () => {
    const { transport, now } = harness(() => FAIL, { breakerThreshold: 1, breakerCooldownMs: 7 * 24 * 3_600_000 });
    await transport.send({ ...sendInput(CONSENT), copy: undefined });
    now.value += 24 * 3_600_000;
    expect(transport.unresolvedDays({ central: { url: CENTRAL_URL } })).toEqual([]);
    expect(transport.unresolvedDays({ central: { url: CENTRAL_URL }, eligibleOnly: false })).toEqual([DAY]);
  });
});

describe("the drain cap counts ATTEMPTS, not selections", () => {
  const CONSENT = userConsent(true, Date.parse("2026-01-01T00:00:00.000Z"));

  test("a breaker that opens mid-loop does not let skipped days eat the cap", async () => {
    const root = tmpRoot();
    // Seed four unresolved days, each with a retained payload, none in backoff.
    const seed = harness(() => FAIL, { stateRoot: root, maxAttempts: 99, breakerThreshold: 99 });
    const days = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"];
    for (const day of days) await seed.transport.send({ ...sendInput(CONSENT), day, copy: undefined });
    for (const day of days) patchRecordOnDisk(root, day, "central", CENTRAL_URL, { attempts: 0, next_attempt_at: null });
    seed.transport.fenceDestination("central", CENTRAL_URL, seed.transport.record(days[0]!, "central", CENTRAL_URL)!.generation);

    // The FIRST attempt opens a long-cooldown breaker. Every later day in the same loop is
    // skipped without contacting anything — and must therefore not spend the cap.
    let calls = 0;
    const drainer = harness(
      () => {
        calls += 1;
        return FAIL;
      },
      { stateRoot: root, maxAttempts: 99, breakerThreshold: 1, breakerCooldownMs: 7 * 24 * 3_600_000, nowMs: undefined },
    );
    const reports = await drainer.transport.drain({
      product: "brokkr",
      consent: CONSENT,
      central: { url: CENTRAL_URL, identity: identity("a") },
      exceptDay: "2026-07-28",
      maxDays: 3,
    });

    // Exactly one real attempt happened; the loop stopped instead of burning the cap on days it
    // could not contact, so nothing newer was skipped over and lost.
    expect(calls).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.day).toBe("2026-07-20");
  });

  test("the drain terminates and respects the cap when every day is attemptable", async () => {
    const root = tmpRoot();
    const seed = harness(() => FAIL, { stateRoot: root, maxAttempts: 99, breakerThreshold: 99 });
    const days = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"];
    for (const day of days) await seed.transport.send({ ...sendInput(CONSENT), day, copy: undefined });
    for (const day of days) patchRecordOnDisk(root, day, "central", CENTRAL_URL, { next_attempt_at: null });
    seed.transport.fenceDestination("central", CENTRAL_URL, seed.transport.record(days[0]!, "central", CENTRAL_URL)!.generation);

    let calls = 0;
    const drainer = harness(
      () => {
        calls += 1;
        return OK;
      },
      { stateRoot: root, maxAttempts: 99, breakerThreshold: 99, nowMs: undefined },
    );
    const reports = await drainer.transport.drain({
      product: "brokkr",
      consent: CONSENT,
      central: { url: CENTRAL_URL, identity: identity("a") },
      exceptDay: "2026-07-28",
      maxDays: 2,
    });
    expect(calls).toBe(2);
    expect(reports.map((r) => r.day)).toEqual(["2026-07-20", "2026-07-21"]);
  });
});

describe("only CLOSED-SET reasons reach durable state", () => {
  const CONSENT = userConsent(true, Date.parse("2026-01-01T00:00:00.000Z"));

  test("an EndpointRejected persists its reason, never its message", async () => {
    const root = tmpRoot();
    const { transport } = harness(
      () => {
        // A message like a TLS or parser error would carry text that originated at the endpoint.
        throw new EndpointRejected("address_blocked", "peer certificate CN=<attacker chosen 41414141>");
      },
      { stateRoot: root },
    );
    await transport.send({ ...sendInput(CONSENT), copy: undefined });

    const rec = transport.record(DAY, "central", CENTRAL_URL)!;
    expect(rec.last_error).toBe("address_blocked");
    expect(fs.readFileSync(deliveryStateFilePath(root), "utf8")).not.toContain("attacker chosen");
  });

  test("an unrecognised failure collapses to one fixed value", async () => {
    const root = tmpRoot();
    const { transport } = harness(
      () => {
        throw new Error("ECONNRESET while reading from evil.example.com: <440 bytes of their prose>");
      },
      { stateRoot: root },
    );
    await transport.send({ ...sendInput(CONSENT), copy: undefined });
    expect(transport.record(DAY, "central", CENTRAL_URL)!.last_error).toBe("transport_error");
    expect(fs.readFileSync(deliveryStateFilePath(root), "utf8")).not.toContain("evil.example.com");
  });

  test("an EndpointRejected with a reason we do not define also collapses", async () => {
    const { transport } = harness(() => {
      throw new EndpointRejected("something_new", "with detail");
    });
    await transport.send({ ...sendInput(CONSENT), copy: undefined });
    expect(transport.record(DAY, "central", CENTRAL_URL)!.last_error).toBe("transport_error");
  });

  test("an HTTP failure records the status and nothing else", async () => {
    const { transport } = harness(() => FAIL);
    await transport.send({ ...sendInput(CONSENT), copy: undefined });
    expect(transport.record(DAY, "central", CENTRAL_URL)!.last_error).toBe("HTTP 503");
  });

  test("every reason the transport can persist is on the closed list", () => {
    // The list is exported so the collector and any status surface can enumerate it rather than
    // pattern-matching free text.
    expect(TRANSPORT_REASONS).toContain("transport_error");
    expect(new Set(TRANSPORT_REASONS).size).toBe(TRANSPORT_REASONS.length);
  });
});
