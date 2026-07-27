// Direct coverage for the write primitive every piece of telemetry state depends on. It was
// previously exercised only through its callers, which meant the properties it exists to provide —
// atomicity, a pinned mode, no debris on failure — were never asserted anywhere.

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync, readJsonSync, SECRET_FILE_MODE } from "./atomic.ts";

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
