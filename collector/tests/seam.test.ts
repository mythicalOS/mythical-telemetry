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
// Deliberately a relative path, not the package name: these fixtures are
// excluded from the published tarball (they are test material, not API), and
// naming the package outside the wiring site would trip the guard above. The
// coupling is the point — the collector proves itself against payloads built
// by the package that owns the schema.
import { allFixtures } from '../../packages/telemetry/src/test-fixtures.ts';

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

  test('the collector declares EXACTLY ONE runtime dependency — the canonical validator', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    // Before the merge this asserted `{}`, because declaring a package that did
    // not yet exist would have broken `bun install`. The invariant it protects
    // is unchanged: the collector takes on no runtime dependency other than the
    // one validator it is not allowed to reimplement.
    expect(pkg.dependencies ?? {}).toEqual({ '@mythicalos/telemetry': 'workspace:*' });
  });
});

describe('loadCanonicalValidator — wired to the real thing', () => {
  test('resolves a validator that ACCEPTS a genuine payload from the client package', async () => {
    const validator = await loadCanonicalValidator();
    // Fixtures come from the package that owns the schema, so this fails if the
    // collector is ever pointed at a stub or a stale copy.
    for (const fixture of allFixtures()) {
      const result = validator.validate(fixture);
      expect(result.ok, `${fixture.product.name} fixture must validate`).toBe(true);
    }
  });

  test('REJECTS an invalid payload, and reports it as schema-invalid rather than a validator fault', async () => {
    const validator = await loadCanonicalValidator();
    const result = validator.validate({ schema_version: 2, nonsense: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The server splits its rejection counters on this prefix: `validator_*`
    // means the validator itself misbehaved, anything else means the payload
    // was bad. A schema rejection must not be miscounted as an internal fault.
    expect(result.error.startsWith('validator_')).toBe(false);
  });

  test('does not carry the validator\'s error text — a rejected document cannot put its own bytes on this path', async () => {
    const validator = await loadCanonicalValidator();
    // The package reports failures as `path: expectation`, and a path can embed
    // an attacker-supplied property name. The collector discards that detail:
    // it only ever needs to choose a counter, so the text is replaced by a
    // constant rather than adapted through. The package removed an equivalent
    // field after it was bypassed four separate ways; this keeps it closed.
    const marker = 'zzattackerpropzz';
    const result = validator.validate({ schema_version: 2, [marker]: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).not.toContain(marker);
    expect(result.error).toBe('schema_invalid');
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
