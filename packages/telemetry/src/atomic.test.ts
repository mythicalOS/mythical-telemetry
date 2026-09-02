// Direct coverage for the write primitive every piece of telemetry state depends on. It was
// previously exercised only through its callers, which meant the properties it exists to provide —
// atomicity, a pinned mode, no debris on failure — were never asserted anywhere.

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync, createFileExclusiveSync, readJsonSync, claimByReplacingSync, SECRET_FILE_MODE } from "./atomic.ts";

const roots: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mythical-telemetry-atomic-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** Temp files are dotfiles ending in `.tmp`; none may survive a completed write. */
function debris(dir: string): string[] {
  return fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp"));
}

describe("atomicWriteFileSync", () => {
  test("writes through a directory that does not exist yet, at the pinned mode", () => {
    const file = path.join(tmpRoot(), "nested", "deeper", "state.json");
    atomicWriteFileSync(file, JSON.stringify({ ok: true }));
    expect(readJsonSync(file)).toEqual({ ok: true });
    expect(fs.statSync(file).mode & 0o777).toBe(SECRET_FILE_MODE);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  test("leaves no temp file behind — including after the directory sync that now follows the rename", () => {
    // The rename consumes the temp file and the directory fsync happens after it. A sync that
    // threw would send the caller into the failure path, which deletes a temp file that no longer
    // exists and rethrows — turning a write that actually landed into a reported failure. It is
    // swallowed for exactly that reason, so a completed write must leave a clean directory.
    const dir = tmpRoot();
    const file = path.join(dir, "state.json");
    for (let i = 0; i < 5; i++) atomicWriteFileSync(file, JSON.stringify({ n: i }));
    expect(readJsonSync(file)).toEqual({ n: 4 });
    expect(debris(dir)).toEqual([]);
  });

  test("overwrites in place and never leaves a partial document readable", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "state.json");
    atomicWriteFileSync(file, JSON.stringify({ generation: 1, payload: "a".repeat(4096) }));
    const before = readJsonSync(file) as { generation: number };
    atomicWriteFileSync(file, JSON.stringify({ generation: 2, payload: "b".repeat(4096) }));
    const after = readJsonSync(file) as { generation: number; payload: string };
    expect(before.generation).toBe(1);
    // Either generation is a COMPLETE document; a torn write would fail to parse and read as
    // undefined, which is what readJsonSync returns for corrupt input.
    expect(after.generation).toBe(2);
    expect(after.payload).toBe("b".repeat(4096));
  });

  test("a mode override is honoured and is not masked by umask", () => {
    const file = path.join(tmpRoot(), "public.json");
    atomicWriteFileSync(file, "{}", 0o644);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  test("a failed write throws and cleans up rather than leaving debris", () => {
    const dir = tmpRoot();
    // A directory where the file should be: the rename cannot replace a non-empty directory.
    const file = path.join(dir, "occupied");
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, "child"), "x");
    expect(() => atomicWriteFileSync(file, "{}")).toThrow();
    expect(debris(dir)).toEqual([]);
  });
});

/** An errno the way node throws it, without depending on the ambient NodeJS namespace. */
function errno(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

describe("createFileExclusiveSync", () => {
  test("creates the file when absent, at the pinned mode, and reports that it did", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "claim.json");
    expect(createFileExclusiveSync(file, JSON.stringify({ owner: "first" }))).toBe(true);
    expect(readJsonSync(file)).toEqual({ owner: "first" });
    expect(fs.statSync(file).mode & 0o777).toBe(SECRET_FILE_MODE);
    expect(debris(dir)).toEqual([]);
  });

  test("LOSES to an existing file: returns false and changes nothing", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "claim.json");
    createFileExclusiveSync(file, JSON.stringify({ owner: "first" }));
    const before = fs.statSync(file);

    expect(createFileExclusiveSync(file, JSON.stringify({ owner: "second" }))).toBe(false);

    // The winner's bytes, the winner's inode. A loser that clobbers here is the whole bug class.
    expect(readJsonSync(file)).toEqual({ owner: "first" });
    expect(fs.statSync(file).ino).toBe(before.ino);
    expect(debris(dir)).toEqual([]);
  });

  test("never re-chmods a directory that already exists", () => {
    // 0710 is a real, deliberate mode elsewhere in this family — group-traversable for a helper
    // user. A telemetry write that flattens it to 0700 breaks something unrelated to telemetry.
    const root = tmpRoot();
    const dir = path.join(root, "state");
    fs.mkdirSync(dir, { mode: 0o710 });
    fs.chmodSync(dir, 0o710); // defeat umask, so the assertion is about our code and not the shell

    createFileExclusiveSync(path.join(dir, "claim.json"), "{}");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o710);
    atomicWriteFileSync(path.join(dir, "written.json"), "{}");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o710);
  });

  test("creates the intermediate directories it does need, at 0700", () => {
    const file = path.join(tmpRoot(), "nested", "deeper", "claim.json");
    expect(createFileExclusiveSync(file, "{}")).toBe(true);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  test("where the filesystem cannot hard-link, it claims by exclusive open instead — and says so", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "claim.json");
    const warnings: string[] = [];
    const linkSync = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("EPERM"); // what a bind mount without hard links returns
    });
    try {
      expect(createFileExclusiveSync(file, JSON.stringify({ owner: "first" }), { log: (line) => warnings.push(line) })).toBe(true);
      expect(readJsonSync(file)).toEqual({ owner: "first" });
      expect(fs.statSync(file).mode & 0o777).toBe(SECRET_FILE_MODE);
      expect(warnings.join("\n")).toContain("hard links are unavailable");

      // Exclusivity is preserved by the fallback — that is the property it may not give up.
      expect(createFileExclusiveSync(file, JSON.stringify({ owner: "second" }))).toBe(false);
      expect(readJsonSync(file)).toEqual({ owner: "first" });
      expect(debris(dir)).toEqual([]);
    } finally {
      linkSync.mockRestore();
    }
  });

  test("a link failure that is NOT an unsupported-filesystem errno is rethrown, never fallen back on", () => {
    // The allowlist is the safety property: a fallback that swallows an unknown failure is a
    // fallback that clobbers something it did not understand.
    const dir = tmpRoot();
    const file = path.join(dir, "claim.json");
    const linkSync = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("EACCES");
    });
    try {
      expect(() => createFileExclusiveSync(file, "{}")).toThrow(/EACCES/);
      expect(fs.existsSync(file)).toBe(false);
      expect(debris(dir)).toEqual([]);
    } finally {
      linkSync.mockRestore();
    }
  });

  /**
   * Drive the link-less fallback and let a rival replace the destination in the window the fallback
   * opens — after the empty name exists and before the bytes are in it.
   *
   * The interleaving point is the SECOND `fsyncSync`: the first belongs to the private temp the
   * link path writes, the second is the fallback's own, by which time the destination is a
   * zero-length file that a concurrent reader would judge unreadable and replace.
   */
  function withLosingFallback(file: string, onLoss: () => void): { restore: () => void; lost: () => boolean } {
    const linkSync = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("EPERM");
    });
    let syncs = 0;
    let replaced = false;
    const fsyncSync = spyOn(fs, "fsyncSync").mockImplementation(() => {
      syncs += 1;
      if (syncs !== 2 || replaced) return;
      replaced = true;
      atomicWriteFileSync(file, JSON.stringify({ owner: "rival" }));
      onLoss();
    });
    return {
      restore: () => {
        fsyncSync.mockRestore();
        linkSync.mockRestore();
      },
      lost: () => replaced,
    };
  }

  test("the link-less claim LOSES rather than reporting success when its name is taken mid-write", () => {
    // Reporting success here would hand the caller content that is NOT what is on disk — for an
    // identity, exactly the loss this primitive exists to prevent.
    const dir = tmpRoot();
    const file = path.join(dir, "claim.json");
    const rival = withLosingFallback(file, () => {});
    try {
      expect(createFileExclusiveSync(file, JSON.stringify({ owner: "ours" }))).toBe(false);
      expect(rival.lost()).toBe(true);
      // The winner's file survives untouched — a loser neither overwrites nor deletes it.
      expect(readJsonSync(file)).toEqual({ owner: "rival" });
      expect(debris(dir)).toEqual([]);
    } finally {
      rival.restore();
    }
  });

  test("a failing link-less claim does not delete a file that is no longer its own", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "claim.json");
    const rival = withLosingFallback(file, () => {});
    // The claim then fails outright, on the very next step. Cleaning up "our path" at that point
    // deletes the winner's file, not our own — our inode was unlinked when the rival replaced it.
    const fchmodSync = spyOn(fs, "fchmodSync").mockImplementation(() => {
      throw errno("ENOSPC");
    });
    const chmodSync = spyOn(fs, "chmodSync").mockImplementation((target: fs.PathLike) => {
      if (String(target) === file) throw errno("ENOSPC");
    });
    try {
      expect(() => createFileExclusiveSync(file, JSON.stringify({ owner: "ours" }))).toThrow(/ENOSPC/);
      expect(rival.lost()).toBe(true);
      expect(readJsonSync(file)).toEqual({ owner: "rival" });
      expect(debris(dir)).toEqual([]);
    } finally {
      chmodSync.mockRestore();
      fchmodSync.mockRestore();
      rival.restore();
    }
  });

  test("a link-less claim that cannot identify what it created deletes NOTHING", () => {
    // `fstat` is the first thing that can throw while holding both a descriptor and a published
    // empty name, and it is the thing that tells us which inode is ours. Without that evidence an
    // unlink of the pathname is an unlink of whatever happens to be there — which, if a rival has
    // already replaced our empty file with its complete one, is the winner's identity. So it is
    // left alone. The residue is an unreadable file, which every reader here treats as absent and
    // the self-heal replaces; the alternative residue is a deleted identity, which nothing repairs.
    const dir = tmpRoot();
    const file = path.join(dir, "claim.json");
    const linkSync = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("EPERM");
    });
    const fstatSync = spyOn(fs, "fstatSync").mockImplementation(() => {
      throw errno("EIO");
    });
    try {
      expect(() => createFileExclusiveSync(file, "{}")).toThrow(/EIO/);
      // Stand the rival up now — the point is that nothing was deleted, whoever owns the name.
      fstatSync.mockRestore();
      linkSync.mockRestore();
      atomicWriteFileSync(file, JSON.stringify({ owner: "rival" }));
      expect(readJsonSync(file)).toEqual({ owner: "rival" });
      expect(debris(dir)).toEqual([]);
    } finally {
      fstatSync.mockRestore();
      linkSync.mockRestore();
    }
  });

  test("the file a failed link-less claim leaves behind is recoverable, not a wedge", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "claim.json");
    const linkSync = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("EPERM");
    });
    const fstatSync = spyOn(fs, "fstatSync").mockImplementation(() => {
      throw errno("EIO");
    });
    try {
      expect(() => createFileExclusiveSync(file, "{}")).toThrow(/EIO/);
      // Whatever is at that name now, it does not parse — which is exactly the state every reader
      // in this package treats as absent, and which the identity self-heal replaces.
      expect(readJsonSync(file)).toBeUndefined();
    } finally {
      fstatSync.mockRestore();
      linkSync.mockRestore();
    }
  });

  test("a mode override is honoured", () => {
    const file = path.join(tmpRoot(), "public.json");
    expect(createFileExclusiveSync(file, "{}", { mode: 0o644 })).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });
});

describe("claimByReplacingSync", () => {
  const keepIfOwned = (parsed: unknown): boolean => parsed !== null && typeof parsed === "object" && "owner" in (parsed as object);

  test("replaces a document that cannot be read", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, "{ truncated");
    expect(claimByReplacingSync(file, JSON.stringify({ owner: "healer" }), keepIfOwned)).toBe(true);
    expect(readJsonSync(file)).toEqual({ owner: "healer" });
    expect(fs.statSync(file).mode & 0o777).toBe(SECRET_FILE_MODE);
    expect(debris(dir)).toEqual([]);
  });

  test("REFUSES to replace a document that can be read", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, JSON.stringify({ owner: "incumbent" }));
    expect(claimByReplacingSync(file, JSON.stringify({ owner: "healer" }), keepIfOwned)).toBe(false);
    expect(readJsonSync(file)).toEqual({ owner: "incumbent" });
  });

  test("claims outright when the name is free", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "state.json");
    expect(claimByReplacingSync(file, JSON.stringify({ owner: "healer" }), keepIfOwned)).toBe(true);
    expect(readJsonSync(file)).toEqual({ owner: "healer" });
  });

  test("a real document that arrives while the corrupt one is being read is left alone", () => {
    // The decision and the removal are tied to one inode, so the arrival is not overwritten — the
    // caller gets false and is expected to go and read it.
    const dir = tmpRoot();
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, "{ truncated");
    const realReadFileSync = fs.readFileSync;
    let planted = false;
    const passThrough = (target: unknown, options?: unknown): unknown => {
      try {
        return (realReadFileSync as (t: unknown, o?: unknown) => unknown)(target, options);
      } finally {
        if (!planted) {
          planted = true;
          atomicWriteFileSync(file, JSON.stringify({ owner: "arrival" }));
        }
      }
    };
    const readFileSync = spyOn(fs, "readFileSync").mockImplementation(passThrough as unknown as typeof fs.readFileSync);
    try {
      expect(claimByReplacingSync(file, JSON.stringify({ owner: "healer" }), keepIfOwned)).toBe(false);
    } finally {
      readFileSync.mockRestore();
    }
    expect(planted).toBe(true);
    expect(readJsonSync(file)).toEqual({ owner: "arrival" });
  });

  test("whoever claims the freed name first still wins", () => {
    const dir = tmpRoot();
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, "{ truncated");
    const realUnlinkSync = fs.unlinkSync;
    const unlinkSync = spyOn(fs, "unlinkSync").mockImplementation((target: fs.PathLike) => {
      realUnlinkSync(target);
      // The name is free for an instant, and someone else takes it.
      unlinkSync.mockRestore();
      createFileExclusiveSync(file, JSON.stringify({ owner: "faster" }));
    });
    try {
      expect(claimByReplacingSync(file, JSON.stringify({ owner: "healer" }), keepIfOwned)).toBe(false);
      expect(readJsonSync(file)).toEqual({ owner: "faster" });
    } finally {
      unlinkSync.mockRestore();
    }
  });
});

describe("readJsonSync", () => {
  test("absent, unreadable and corrupt all degrade to undefined rather than throwing", () => {
    const dir = tmpRoot();
    expect(readJsonSync(path.join(dir, "missing.json"))).toBeUndefined();
    const corrupt = path.join(dir, "corrupt.json");
    fs.writeFileSync(corrupt, "{ not json");
    expect(readJsonSync(corrupt)).toBeUndefined();
    // A directory is not a readable document either.
    expect(readJsonSync(dir)).toBeUndefined();
  });

  test("a JSON document that is merely EMPTY is still distinguishable from corrupt", () => {
    const file = path.join(tmpRoot(), "empty.json");
    atomicWriteFileSync(file, "{}");
    expect(readJsonSync(file)).toEqual({});
  });
});
