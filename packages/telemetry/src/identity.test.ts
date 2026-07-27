import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  copyIdentityFilePath,
  deriveInstanceId,
  IdentityStore,
  INSTANCE_SECRET_PATTERN,
  instanceFilePath,
  mintInstanceSecret,
  normalizeDestinationUrl,
} from "./identity.ts";
import { INSTANCE_ID_PATTERN } from "./envelope.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mythical-telemetry-identity-"));
}

describe("deriveInstanceId — PINNED VECTORS", () => {
  // These are the compatibility contract. If any of them changes, every installed product mints a
  // new id, orphaning its history AND its delete capability. They were computed from the shipping
  // implementation, not from this one.
  const VECTORS: Array<[string, string]> = [
    ["0000000000000000000000000000000000000000000000000000000000000000", "60e05bd1-b195-4f2f-9411-2fa7197a5c88"],
    ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "df0790f2-3601-4511-a91f-a4532fb7761f"],
    ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "a8ae6e6e-e929-4bea-bafc-fc5258c8ccd6"],
    ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "247d08f3-e139-48b2-84f5-ecd8966f1778"],
  ];

  for (const [secret, expected] of VECTORS) {
    test(`${secret.slice(0, 12)}… derives ${expected}`, () => {
      expect(deriveInstanceId(secret)).toBe(expected);
    });
  }

  test("hashes the UTF-8 BYTES OF THE HEX STRING, not the decoded 32 bytes", () => {
    const secret = "0".repeat(64);
    // The tempting "improvement" — hashing the decoded bytes — produces a DIFFERENT id. Pinning
    // the wrong answer here is what makes the mistake loud instead of silent.
    const decodedDigest = createHash("sha256").update(Buffer.from(secret, "hex")).digest();
    const wrong = Buffer.from(decodedDigest.subarray(0, 16));
    wrong[6] = (wrong[6]! & 0x0f) | 0x40;
    wrong[8] = (wrong[8]! & 0x3f) | 0x80;
    const wrongHex = wrong.toString("hex");
    const wrongId = `${wrongHex.slice(0, 8)}-${wrongHex.slice(8, 12)}-${wrongHex.slice(12, 16)}-${wrongHex.slice(16, 20)}-${wrongHex.slice(20)}`;

    expect(wrongId).toBe("66687aad-f862-4d77-ac8f-c18b8e9f8e20");
    expect(deriveInstanceId(secret)).not.toBe(wrongId);
  });

  test("stamps the v4 version nibble and the variant bits", () => {
    for (let i = 0; i < 200; i++) {
      const id = deriveInstanceId(mintInstanceSecret());
      expect(id).toMatch(INSTANCE_ID_PATTERN);
    }
  });

  test("is deterministic and differs per secret", () => {
    const a = mintInstanceSecret();
    const b = mintInstanceSecret();
    expect(deriveInstanceId(a)).toBe(deriveInstanceId(a));
    expect(deriveInstanceId(a)).not.toBe(deriveInstanceId(b));
  });
});

describe("mintInstanceSecret", () => {
  test("is 32 bytes hex", () => {
    const secret = mintInstanceSecret();
    expect(secret).toMatch(INSTANCE_SECRET_PATTERN);
    expect(secret).toHaveLength(64);
  });
});

describe("central identity file", () => {
  test("mints at <state>/telemetry/instance.json with the preserved layout, 0600", () => {
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const identity = store.centralIdentity();

    const file = instanceFilePath(root);
    expect(file).toBe(path.join(root, "telemetry", "instance.json"));
    expect(fs.existsSync(file)).toBe(true);

    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["created_at", "instance_id", "instance_secret", "rotated_at"]);
    expect(doc.instance_secret).toBe(identity.instance_secret);
    expect(doc.instance_id).toBe(deriveInstanceId(identity.instance_secret));

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("reads an EXISTING file written by the shipping product, unchanged", () => {
    const root = tmpRoot();
    const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
    fs.writeFileSync(
      instanceFilePath(root),
      JSON.stringify(
        {
          instance_secret: secret,
          instance_id: "a8ae6e6e-e929-4bea-bafc-fc5258c8ccd6",
          created_at: "2026-01-01T00:00:00.000Z",
          rotated_at: "2026-01-02T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    const store = new IdentityStore({ stateRoot: root });
    const identity = store.centralIdentity();
    expect(identity.instance_secret).toBe(secret);
    expect(identity.instance_id).toBe("a8ae6e6e-e929-4bea-bafc-fc5258c8ccd6");
    expect(identity.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(identity.rotated_at).toBe("2026-01-02T00:00:00.000Z");
  });

  test("re-derives the id from the secret — a tampered id on disk is self-healed", () => {
    const root = tmpRoot();
    const secret = "0".repeat(64);
    fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
    fs.writeFileSync(instanceFilePath(root), JSON.stringify({ instance_secret: secret, instance_id: "not-a-uuid" }));
    expect(new IdentityStore({ stateRoot: root }).centralIdentity().instance_id).toBe("60e05bd1-b195-4f2f-9411-2fa7197a5c88");
  });

  test("a corrupt or truncated file mints fresh rather than throwing", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
    fs.writeFileSync(instanceFilePath(root), "{not json");
    const identity = new IdentityStore({ stateRoot: root }).centralIdentity();
    expect(identity.instance_secret).toMatch(INSTANCE_SECRET_PATTERN);
  });

  test("rejects a non-hex secret and mints fresh", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
    fs.writeFileSync(instanceFilePath(root), JSON.stringify({ instance_secret: "hello" }));
    expect(new IdentityStore({ stateRoot: root }).centralIdentity().instance_secret).not.toBe("hello");
  });

  test("rotation mints a new secret and id, preserves created_at, bumps rotated_at", () => {
    const root = tmpRoot();
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = new IdentityStore({ stateRoot: root, nowMs: () => now });
    const first = store.centralIdentity();
    now = Date.parse("2026-03-01T00:00:00.000Z");
    const rotated = store.rotateCentral();

    expect(rotated.instance_secret).not.toBe(first.instance_secret);
    expect(rotated.instance_id).not.toBe(first.instance_id);
    expect(rotated.created_at).toBe(first.created_at);
    expect(rotated.rotated_at).toBe("2026-03-01T00:00:00.000Z");
    expect(new IdentityStore({ stateRoot: root }).centralIdentity().instance_id).toBe(rotated.instance_id);
  });
});

describe("normalizeDestinationUrl", () => {
  test("folds equivalent spellings to one key", () => {
    const canonical = "https://ops.example.com/ingest";
    expect(normalizeDestinationUrl("https://ops.example.com/ingest")).toBe(canonical);
    expect(normalizeDestinationUrl("https://OPS.EXAMPLE.COM/ingest")).toBe(canonical);
    expect(normalizeDestinationUrl("https://ops.example.com:443/ingest")).toBe(canonical);
    expect(normalizeDestinationUrl("https://ops.example.com/ingest/")).toBe(canonical);
    expect(normalizeDestinationUrl("https://ops.example.com/ingest#frag")).toBe(canonical);
  });

  test("keeps genuinely different endpoints distinct", () => {
    expect(normalizeDestinationUrl("https://a.example.com")).not.toBe(normalizeDestinationUrl("https://b.example.com"));
    expect(normalizeDestinationUrl("https://a.example.com/one")).not.toBe(normalizeDestinationUrl("https://a.example.com/two"));
    expect(normalizeDestinationUrl("https://a.example.com:8443")).not.toBe(normalizeDestinationUrl("https://a.example.com"));
    expect(normalizeDestinationUrl("https://a.example.com?t=1")).not.toBe(normalizeDestinationUrl("https://a.example.com?t=2"));
  });

  test("rejects credentials in the URL rather than silently dropping them", () => {
    expect(() => normalizeDestinationUrl("https://user:pass@ops.example.com")).toThrow(/credentials/);
  });

  test("rejects non-http(s) schemes and junk", () => {
    expect(() => normalizeDestinationUrl("file:///etc/passwd")).toThrow();
    expect(() => normalizeDestinationUrl("not a url")).toThrow();
  });
});

describe("destination-scoped copy identities", () => {
  test("a copy gets its OWN secret and its OWN id — never central's", () => {
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const central = store.centralIdentity();
    const copy = store.copyIdentityFor("https://ops.example.com");

    expect(copy.instance_secret).not.toBe(central.instance_secret);
    expect(copy.instance_id).not.toBe(central.instance_id);
    expect(copy.instance_id).toMatch(INSTANCE_ID_PATTERN);
  });

  test("the central secret NEVER appears in the copy identity file", () => {
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const central = store.centralIdentity();
    store.copyIdentityFor("https://ops.example.com");

    const raw = fs.readFileSync(copyIdentityFilePath(root), "utf8");
    expect(raw).not.toContain(central.instance_secret);
    expect(raw).not.toContain(central.instance_id);
    expect(fs.statSync(copyIdentityFilePath(root)).mode & 0o777).toBe(0o600);
  });

  test("is stable for the same destination across spellings", () => {
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const first = store.copyIdentityFor("https://ops.example.com/ingest");
    const again = store.copyIdentityFor("https://OPS.example.com/ingest/");
    expect(again.instance_secret).toBe(first.instance_secret);
  });

  test("CHANGING the destination rotates: the new endpoint never receives the old secret", () => {
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const first = store.copyIdentityFor("https://a.example.com");
    const second = store.copyIdentityFor("https://b.example.com");

    expect(second.instance_secret).not.toBe(first.instance_secret);
    expect(second.instance_id).not.toBe(first.instance_id);

    // The retired destination's secret is DESTROYED, not archived — an operator who regains the
    // old URL must not get the old credential back.
    const stored = JSON.parse(fs.readFileSync(copyIdentityFilePath(root), "utf8")) as {
      current_destination: string;
      destinations: Record<string, unknown>;
    };
    expect(Object.keys(stored.destinations)).toEqual(["https://b.example.com"]);
    expect(fs.readFileSync(copyIdentityFilePath(root), "utf8")).not.toContain(first.instance_secret);

    // Returning to the first URL mints a THIRD identity, not the first one again.
    const third = store.copyIdentityFor("https://a.example.com");
    expect(third.instance_secret).not.toBe(first.instance_secret);
    expect(third.instance_secret).not.toBe(second.instance_secret);
  });

  test("clearing retires the identity entirely", () => {
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const copy = store.copyIdentityFor("https://ops.example.com");
    expect(store.currentCopyDestination()).toBe("https://ops.example.com");
    store.clearCopyIdentity();
    expect(store.currentCopyDestination()).toBeUndefined();
    expect(fs.readFileSync(copyIdentityFilePath(root), "utf8")).not.toContain(copy.instance_secret);
  });

  test("copy identities are independent of the central rotation", () => {
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const copy = store.copyIdentityFor("https://ops.example.com");
    store.rotateCentral();
    expect(store.copyIdentityFor("https://ops.example.com").instance_secret).toBe(copy.instance_secret);
  });
});
