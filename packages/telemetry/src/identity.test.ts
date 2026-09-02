import { describe, expect, spyOn, test } from "bun:test";
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
  type InstanceIdentity,
} from "./identity.ts";
import { INSTANCE_ID_PATTERN } from "./envelope.ts";
import { atomicWriteFileSync, createFileExclusiveSync } from "./atomic.ts";

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

/**
 * REAL CONCURRENCY, DELIBERATELY. A load-or-mint TOCTOU cannot be demonstrated by calling the store
 * twice in one process — the second call reads what the first wrote and agrees with it no matter
 * how the code is written. It needs genuinely simultaneous first boots, so these spawn child
 * processes and release them on a shared millisecond.
 *
 * The store passes when every child returns the identity that is ON DISK. Reading, minting when
 * absent and writing afterwards fails it: each child mints its own secret, the writes clobber, and
 * the children that lost are already holding an id that no longer exists anywhere — data the
 * install can no longer read or delete, because the id is how a user asks for their data back.
 */
const RACE_CHILD = `
import fs from "node:fs";
import path from "node:path";

const [root, startAtRaw, modulePath, copyUrl, barrierDir, siblingsRaw, index] = process.argv.slice(2);
const { IdentityStore } = await import(modulePath);
const startAt = Number(startAtRaw);
const siblings = Number(siblingsRaw);

const lead = startAt - Date.now();
if (lead > 5) await Bun.sleep(lead - 5);
while (Date.now() < startAt) {
  /* spin the last few ms so every child is released on the same tick */
}

const store = new IdentityStore({ stateRoot: root });
const central = store.centralIdentity();

// A SECOND barrier, and a real rendezvous rather than a fixed instant: resolving central serialises
// the children on that file by wildly varying amounts, so a wall-clock delay here would let a fast
// child run its copy claim uncontended while a slow one is still on central. Each child announces
// that it is ready and waits for the others; the deadline only stops a wedged sibling hanging the
// suite, and a child that hits it still runs — it just may not contend.
fs.writeFileSync(path.join(barrierDir, "ready-" + index), "");
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  if (fs.readdirSync(barrierDir).filter((n) => n.startsWith("ready-")).length >= siblings) break;
}

const copy = store.copyIdentityFor(copyUrl);
process.stdout.write(JSON.stringify({ central: central.instance_secret, copy: copy.instance_secret }));
`;

/**
 * The DETERMINISTIC half of the same proof, and the one that actually guards the fix.
 *
 * `nowMs` is called while minting — after the file has been read and before it is written — so a
 * test can stand a rival writer up in exactly that window using nothing but the public options. No
 * scheduling luck involved: read-then-write-anyway fails this every single time, because it
 * overwrites the rival and hands its caller a secret that is no longer on disk.
 */
describe("a rival that claims the file mid-mint is ADOPTED, not overwritten", () => {
  const FIXED = Date.parse("2026-01-01T00:00:00.000Z");
  const RIVAL_SECRET = "ab".repeat(32);

  function rivalDoc(): string {
    return JSON.stringify({
      instance_secret: RIVAL_SECRET,
      instance_id: deriveInstanceId(RIVAL_SECRET),
      created_at: "2025-12-31T00:00:00.000Z",
      rotated_at: "2025-12-31T00:00:00.000Z",
    });
  }

  test("central: the caller gets the winner's identity and the winner's file survives", () => {
    const root = tmpRoot();
    let fired = false;
    const store = new IdentityStore({
      stateRoot: root,
      nowMs: () => {
        if (!fired) {
          fired = true;
          // Another process claims the name in the gap between our read and our write.
          expect(createFileExclusiveSync(instanceFilePath(root), rivalDoc())).toBe(true);
        }
        return FIXED;
      },
    });

    const got = store.centralIdentity();
    expect(fired).toBe(true);
    expect(got.instance_secret).toBe(RIVAL_SECRET);
    expect(got.created_at).toBe("2025-12-31T00:00:00.000Z");
    // The rival's file is untouched: losing a claim must change nothing on disk.
    expect((JSON.parse(fs.readFileSync(instanceFilePath(root), "utf8")) as { instance_secret: string }).instance_secret).toBe(RIVAL_SECRET);
    // And the identity is stable for the rest of the process.
    expect(store.centralIdentity().instance_secret).toBe(RIVAL_SECRET);
  });

  test("copy: one secret per destination, even when both processes mint for it at once", () => {
    const root = tmpRoot();
    const url = "https://ops.example.com/ingest";
    let fired = false;
    const store = new IdentityStore({
      stateRoot: root,
      nowMs: () => {
        if (!fired) {
          fired = true;
          expect(
            createFileExclusiveSync(
              copyIdentityFilePath(root),
              JSON.stringify({ current_destination: url, destinations: { [url]: JSON.parse(rivalDoc()) } }),
            ),
          ).toBe(true);
        }
        return FIXED;
      },
    });

    const got = store.copyIdentityFor(url);
    expect(fired).toBe(true);
    expect(got.instance_secret).toBe(RIVAL_SECRET);
    const stored = JSON.parse(fs.readFileSync(copyIdentityFilePath(root), "utf8")) as {
      destinations: Record<string, { instance_secret: string }>;
    };
    expect(stored.destinations[url]!.instance_secret).toBe(RIVAL_SECRET);
  });

  test("a file that exists but cannot be read is still self-healed rather than looping", () => {
    // The claim can never win against a corrupt document — nothing will ever release that name —
    // so the pre-existing replace-and-carry-on behaviour has to survive the new claim path.
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
    fs.writeFileSync(instanceFilePath(root), "{ truncated");
    const lines: string[] = [];
    const identity = new IdentityStore({ stateRoot: root, log: (line) => lines.push(line) }).centralIdentity();

    expect(identity.instance_secret).toMatch(INSTANCE_SECRET_PATTERN);
    expect((JSON.parse(fs.readFileSync(instanceFilePath(root), "utf8")) as { instance_secret: string }).instance_secret).toBe(
      identity.instance_secret,
    );
    expect(lines.join("\n")).toContain("unreadable");
  });
});

/**
 * The retry of a mint that could not be written is the back door into the same identity loss: by
 * the time it runs, another process may have legitimately persisted an identity of its own, and a
 * plain re-write renames over it. An identity that never reached disk has no claim on the name.
 */
describe("an identity that was never written does not get to overwrite one that was", () => {
  /** Make the claim fail HARD — an errno outside the link-unsupported allowlist is rethrown. */
  function withFailingClaim<T>(body: () => T): T {
    const linkSync = spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    });
    try {
      return body();
    } finally {
      linkSync.mockRestore();
    }
  }

  test("the retry ADOPTS an identity another writer persisted in the meantime", () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const store = new IdentityStore({ stateRoot: root, log: (line) => lines.push(line) });

    const unwritten = withFailingClaim(() => store.centralIdentity());
    expect(fs.existsSync(instanceFilePath(root))).toBe(false); // nothing landed

    // Another process finds the file absent and persists its own — and starts emitting under it.
    const rivalSecret = "cd".repeat(32);
    expect(
      createFileExclusiveSync(
        instanceFilePath(root),
        JSON.stringify({ instance_secret: rivalSecret, instance_id: deriveInstanceId(rivalSecret) }),
      ),
    ).toBe(true);

    const settled = store.centralIdentity();
    expect(settled.instance_secret).toBe(rivalSecret);
    expect(settled.instance_secret).not.toBe(unwritten.instance_secret);
    expect((JSON.parse(fs.readFileSync(instanceFilePath(root), "utf8")) as { instance_secret: string }).instance_secret).toBe(rivalSecret);
    expect(lines.join("\n")).toContain("adopting it");
    // ...and it stays settled.
    expect(store.centralIdentity().instance_secret).toBe(rivalSecret);
  });

  test("the retry still WRITES when the name is genuinely free", () => {
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const unwritten = withFailingClaim(() => store.centralIdentity());
    expect(fs.existsSync(instanceFilePath(root))).toBe(false);

    expect(store.centralIdentity().instance_secret).toBe(unwritten.instance_secret);
    expect((JSON.parse(fs.readFileSync(instanceFilePath(root), "utf8")) as { instance_secret: string }).instance_secret).toBe(
      unwritten.instance_secret,
    );
  });

  test("a name that VANISHED is claimed again, not replaced over whoever took it next", () => {
    // A lost claim followed by a read that finds nothing is ambiguous: the name may have been taken
    // by something unreadable, or it may simply have gone away between the two. Treating it as
    // "unreadable, replace it" hands replacement authority to a process holding an identity that
    // was never on disk — and renames it over the one that legitimately claimed the name next.
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const unwritten = withFailingClaim(() => store.centralIdentity());
    expect(fs.existsSync(instanceFilePath(root))).toBe(false);

    const rivalSecret = "ef".repeat(32);
    const realLinkSync = fs.linkSync;
    const realReadFileSync = fs.readFileSync;
    let links = 0;
    let planted = false;

    const linkSync = spyOn(fs, "linkSync").mockImplementation((...args: Parameters<typeof fs.linkSync>) => {
      links += 1;
      // The retry's FIRST claim loses to a name that is momentarily taken...
      if (links === 1) throw Object.assign(new Error("simulated EEXIST"), { code: "EEXIST" });
      return realLinkSync(...args);
    });
    // The overloads on readFileSync do not survive a mock signature, so it is delegated untyped.
    const passThroughRead = (target: unknown, options?: unknown): unknown => {
      try {
        return (realReadFileSync as (t: unknown, o?: unknown) => unknown)(target, options);
      } finally {
        // ...and by the time the lost claim's read has come back empty, a third writer has claimed
        // the name for real and is already using the identity it put there.
        if (!planted && String(target) === instanceFilePath(root)) {
          planted = true;
          createFileExclusiveSync(
            instanceFilePath(root),
            JSON.stringify({ instance_secret: rivalSecret, instance_id: deriveInstanceId(rivalSecret) }),
          );
        }
      }
    };
    const readFileSync = spyOn(fs, "readFileSync").mockImplementation(passThroughRead as unknown as typeof fs.readFileSync);

    try {
      const settled = store.centralIdentity();
      expect(planted).toBe(true);
      expect(settled.instance_secret).toBe(rivalSecret);
      expect(settled.instance_secret).not.toBe(unwritten.instance_secret);
    } finally {
      readFileSync.mockRestore();
      linkSync.mockRestore();
    }
    expect((JSON.parse(fs.readFileSync(instanceFilePath(root), "utf8")) as { instance_secret: string }).instance_secret).toBe(rivalSecret);
  });

  test("a document that appears while the unreadable one is being replaced is adopted, not overwritten", () => {
    // The self-heal is the last place a live identity could be destroyed by a process that has only
    // ever read garbage: it decides "this is corrupt" and then writes over the name, and in between
    // a real document can arrive. The replace is tied to the inode that was read, so the arrival
    // wins.
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
    fs.writeFileSync(instanceFilePath(root), "{ truncated");

    const rivalSecret = "ba".repeat(32);
    const realReadFileSync = fs.readFileSync;
    let pathReads = 0;
    // Three rounds of read → claim happen before the self-heal; plant on the LAST of those reads,
    // which is the moment the code has just concluded "unreadable" and is about to act on it.
    const passThroughRead = (target: unknown, options?: unknown): unknown => {
      try {
        return (realReadFileSync as (t: unknown, o?: unknown) => unknown)(target, options);
      } finally {
        if (String(target) === instanceFilePath(root)) {
          pathReads += 1;
          if (pathReads === 3) {
            atomicWriteFileSync(
              instanceFilePath(root),
              JSON.stringify({ instance_secret: rivalSecret, instance_id: deriveInstanceId(rivalSecret) }),
            );
          }
        }
      }
    };
    const readFileSync = spyOn(fs, "readFileSync").mockImplementation(passThroughRead as unknown as typeof fs.readFileSync);

    let settled: InstanceIdentity;
    try {
      settled = new IdentityStore({ stateRoot: root }).centralIdentity();
    } finally {
      readFileSync.mockRestore();
    }

    expect(pathReads).toBeGreaterThanOrEqual(3);
    expect(settled.instance_secret).toBe(rivalSecret);
    expect((JSON.parse(fs.readFileSync(instanceFilePath(root), "utf8")) as { instance_secret: string }).instance_secret).toBe(rivalSecret);
  });

  test("a ROTATION whose write failed still replaces — it does not adopt the identity it is retiring", () => {
    // The rotation case is the opposite of the mint case: superseding what is stored IS the intent,
    // so a retry that claimed and adopted would silently undo the rotation.
    const root = tmpRoot();
    const store = new IdentityStore({ stateRoot: root });
    const first = store.centralIdentity();

    const renameSync = spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
    });
    let rotated: InstanceIdentity;
    try {
      rotated = store.rotateCentral();
    } finally {
      renameSync.mockRestore();
    }
    expect(rotated.instance_secret).not.toBe(first.instance_secret);
    // The write failed, so the OLD identity is still the one on disk.
    expect((JSON.parse(fs.readFileSync(instanceFilePath(root), "utf8")) as { instance_secret: string }).instance_secret).toBe(
      first.instance_secret,
    );

    expect(store.centralIdentity().instance_secret).toBe(rotated.instance_secret);
    expect((JSON.parse(fs.readFileSync(instanceFilePath(root), "utf8")) as { instance_secret: string }).instance_secret).toBe(
      rotated.instance_secret,
    );
  });
});

describe("concurrent first boot resolves to ONE identity", () => {
  const CHILDREN = 12;
  const COPY_URL = "https://ops.example.com/ingest";

  async function raceChildren(root: string): Promise<Array<{ central: string; copy: string }>> {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mythical-telemetry-race-"));
    try {
      const childPath = path.join(scratch, "child.ts");
      fs.writeFileSync(childPath, RACE_CHILD);
      const barrierDir = path.join(scratch, "barrier");
      fs.mkdirSync(barrierDir);
      const startAt = Date.now() + 600;
      const children = Array.from({ length: CHILDREN }, (_unused, index) =>
        Bun.spawn({
          cmd: [
            process.execPath,
            childPath,
            root,
            String(startAt),
            path.join(import.meta.dir, "identity.ts"),
            COPY_URL,
            barrierDir,
            String(CHILDREN),
            String(index),
          ],
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      return await Promise.all(
        children.map(async (child) => {
          const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          if (code !== 0) throw new Error(`race child exited ${code}: ${err}`);
          return JSON.parse(out) as { central: string; copy: string };
        }),
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  test("every process returns the CENTRAL identity that is on disk, not its own mint", async () => {
    const root = tmpRoot();
    const results = await raceChildren(root);

    const secrets = new Set(results.map((r) => r.central));
    expect(secrets.size).toBe(1);

    const onDisk = JSON.parse(fs.readFileSync(instanceFilePath(root), "utf8")) as { instance_secret: string };
    expect([...secrets][0]).toBe(onDisk.instance_secret);
  }, 30_000);

  test("the destination-scoped COPY identity resolves the same way — one secret per endpoint", async () => {
    const root = tmpRoot();
    const results = await raceChildren(root);

    const secrets = new Set(results.map((r) => r.copy));
    expect(secrets.size).toBe(1);

    const onDisk = JSON.parse(fs.readFileSync(copyIdentityFilePath(root), "utf8")) as {
      current_destination: string;
      destinations: Record<string, { instance_secret: string }>;
    };
    expect(onDisk.current_destination).toBe(COPY_URL);
    expect(onDisk.destinations[COPY_URL]!.instance_secret).toBe([...secrets][0]!);
    // ...and it is emphatically not central's.
    expect(results[0]!.copy).not.toBe(results[0]!.central);
  }, 30_000);
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

  test("a corrupt copy file is not blindly replaced over an identity another writer just stored", () => {
    // Losing the claim to an UNREADABLE file is not the same as finding another destination's
    // entry: the first is a name this process merely failed to read, and renaming over it destroys
    // whatever legitimately arrived meanwhile. Only the second is a rotation.
    const root = tmpRoot();
    const url = "https://ops.example.com/ingest";
    fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
    fs.writeFileSync(copyIdentityFilePath(root), "{ truncated");

    const rivalSecret = "9a".repeat(32);
    const realReadFileSync = fs.readFileSync;
    let pathReads = 0;
    let planted = false;
    // Read 1 is the opening look, read 2 is the re-read after the claim is lost. Planting after
    // read 2 puts the arrival exactly where a blind replace would destroy it — earlier than that
    // and the ordinary adopt-after-a-lost-claim step catches it and nothing is proven.
    const passThroughRead = (target: unknown, options?: unknown): unknown => {
      try {
        return (realReadFileSync as (t: unknown, o?: unknown) => unknown)(target, options);
      } finally {
        if (String(target) === copyIdentityFilePath(root)) pathReads += 1;
        if (!planted && pathReads === 2) {
          planted = true;
          atomicWriteFileSync(
            copyIdentityFilePath(root),
            JSON.stringify({
              current_destination: url,
              destinations: { [url]: { instance_secret: rivalSecret, instance_id: deriveInstanceId(rivalSecret) } },
            }),
          );
        }
      }
    };
    const readFileSync = spyOn(fs, "readFileSync").mockImplementation(passThroughRead as unknown as typeof fs.readFileSync);

    let copy: InstanceIdentity;
    try {
      copy = new IdentityStore({ stateRoot: root }).copyIdentityFor(url);
    } finally {
      readFileSync.mockRestore();
    }

    expect(planted).toBe(true);
    expect(copy.instance_secret).toBe(rivalSecret);
    const stored = JSON.parse(fs.readFileSync(copyIdentityFilePath(root), "utf8")) as {
      destinations: Record<string, { instance_secret: string }>;
    };
    expect(stored.destinations[url]!.instance_secret).toBe(rivalSecret);
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
