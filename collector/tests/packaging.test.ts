// Packaging: the collector is deployed, never published.
//
// The repository publishes exactly one package. An npm publish is
// irreversible, so "the collector must not end up in a tarball" is asserted
// mechanically rather than left to the release workflow being read correctly.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const COLLECTOR = join(import.meta.dir, '..');
const ROOT = join(COLLECTOR, '..');

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('the collector can never be published', () => {
  const pkg = readJson(join(COLLECTOR, 'package.json'));

  test('it is marked private', () => {
    expect(pkg.private).toBe(true);
  });

  test('it carries no publish configuration of any kind', () => {
    expect(pkg.publishConfig).toBeUndefined();
    expect(pkg.files).toBeUndefined();
    expect(pkg.prepublishOnly).toBeUndefined();
    expect(pkg.scripts?.prepublishOnly).toBeUndefined();
    expect(pkg.scripts?.publish).toBeUndefined();
  });

  test('its name is unscoped, so it cannot be mistaken for a published package', () => {
    expect(String(pkg.name).startsWith('@')).toBe(false);
  });
});

describe('the repository root', () => {
  const root = readJson(join(ROOT, 'package.json'));

  test('is private and lists the collector as a workspace', () => {
    expect(root.private).toBe(true);
    expect(root.workspaces).toContain('collector');
  });

  test('publishes nothing itself', () => {
    expect(root.files).toBeUndefined();
    expect(root.publishConfig).toBeUndefined();
  });
});

describe('operator artifacts are present', () => {
  test('the Dockerfile and its ignore file ship with the collector', () => {
    expect(existsSync(join(COLLECTOR, 'Dockerfile'))).toBe(true);
    expect(existsSync(join(COLLECTOR, '.dockerignore'))).toBe(true);
    expect(existsSync(join(COLLECTOR, 'README.md'))).toBe(true);
  });

  test('the README documents the public-unauthenticated-ingest posture honestly', () => {
    const readme = readFileSync(join(COLLECTOR, 'README.md'), 'utf8');
    for (const required of [
      'X-Forwarded-For',
      'trusted',
      'untrusted',
      'pseudonymous',
      'admission',
      'compatibility window',
    ]) {
      expect(readme.toLowerCase(), required).toContain(required.toLowerCase());
    }
    // The data must never be DESCRIBED as anonymous — while saying "not
    // anonymous" is exactly what is wanted.
    expect(readme).toContain('pseudonymous, not anonymous');
    const claims = [
      /\b(?:is|are|it's)\s+anonymous\b/i,
      /\banonymous\s+(?:daily|product|usage|telemetry|heartbeat)/i,
    ];
    for (const claim of claims) {
      expect(claim.test(readme), `README claims anonymity: ${claim}`).toBe(false);
    }
  });
});
