// The validator seam — asserted, not merely documented.
//
// The whole reason this repository exists is that the schema, the emitter and
// the acceptor must not drift. That holds only while there is exactly ONE
// runtime validator, in the published client package. These tests fail if the
// collector ever grows a second one.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadCanonicalValidator, safeValidate, type HeartbeatValidator } from '../src/validator';
import { INSTANCE_A } from './fixtures';

const SRC = join(import.meta.dir, '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('there is no second validator in the collector', () => {
  test('no source file pulls in a schema library', () => {
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/from\s+['"]zod['"]/);
      expect(text, file).not.toMatch(/from\s+['"]ajv['"]/);
      expect(text, file).not.toMatch(/require\(['"]zod['"]\)/);
    }
  });

  test('the client package is named in exactly ONE source file — the wiring site', () => {
    const naming = sourceFiles(SRC).filter((f) => readFileSync(f, 'utf8').includes('@mythicalos/telemetry'));
    expect(naming.map((f) => f.replace(`${SRC}/`, ''))).toEqual(['validator.ts']);
  });

  test('the collector declares no runtime dependency it does not have', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    // The client package is added here at merge; until then declaring it would
    // break `bun install` for everyone on this branch.
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe('loadCanonicalValidator', () => {
  test('refuses to start rather than falling back when the package is absent', async () => {
    // On this branch the package genuinely does not exist, which is exactly
    // the condition being asserted: no silent permissive fallback.
    await expect(loadCanonicalValidator()).rejects.toThrow(/cannot load the canonical heartbeat validator/);
  });
});

describe('safeValidate — the collector never trusts the injected validator to behave', () => {
  const valid = {
    schema_version: 2 as const,
    instance_id: INSTANCE_A,
    day: '2026-07-09',
    product: { name: 'brokkr', version: '0.1.0' },
    platform: { os: 'darwin', arch: 'arm64' },
    metrics: {},
  };

  function stub(impl: () => unknown): HeartbeatValidator {
    return { validate: impl as HeartbeatValidator['validate'] };
  }

  test('a well-behaved validator passes its value through', () => {
    const result = safeValidate(stub(() => ({ ok: true, value: valid })), {});
    expect(result).toEqual({ ok: true, value: valid });
  });

  test('a throwing validator becomes a rejection', () => {
    expect(safeValidate(stub(() => { throw new Error('x'); }), {})).toEqual({
      ok: false,
      error: 'validator_threw',
    });
  });

  test('a malformed result becomes a rejection', () => {
    for (const bad of [undefined, null, 'yes', 42, {}, { ok: 'true' }]) {
      const result = safeValidate(stub(() => bad), {});
      expect(result.ok).toBe(false);
    }
  });

  test('an "ok" result whose envelope is unusable as a key is rejected, not stored', () => {
    // These would become primary-key components. A non-string here corrupts
    // the store rather than rejecting a request, so it is caught here.
    const bad: unknown[] = [
      { ok: true, value: { ...valid, instance_id: 42 } },
      { ok: true, value: { ...valid, day: null } },
      { ok: true, value: { ...valid, product: undefined } },
      { ok: true, value: { ...valid, product: { name: 7, version: '1.0.0' } } },
      { ok: true, value: null },
      { ok: true },
    ];
    for (const result of bad) {
      expect(safeValidate(stub(() => result), {})).toEqual({
        ok: false,
        error: 'validator_malformed_result',
      });
    }
  });

  test('a rejection reason is carried through when it is a string', () => {
    expect(safeValidate(stub(() => ({ ok: false, error: 'metrics' })), {})).toEqual({
      ok: false,
      error: 'metrics',
    });
    expect(safeValidate(stub(() => ({ ok: false, error: { deep: true } })), {})).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
});
