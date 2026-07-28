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
      'One shape, no negotiation',
    ]) {
      expect(readme.toLowerCase(), required).toContain(required.toLowerCase());
    }
    // ...and it must not re-grow a support window. The repository collapsed to a
    // single schema precisely because the earlier one never had a consumer;
    // documenting a window again would promise operators something no code does.
    for (const stale of [
      /\b(?:compatibility|support)\s+window\b/i,
      /MYTHICAL_TELEMETRY_ACCEPT_V1/,
      /\bnormali[sz]ed to (?:the )?v2\b/i,
      /ingest_accepted_wire_v|ingest_rejected_v1_window_closed/,
      // The prose form, not just the identifier: a bullet promising counts
      // "split by wire version" outlived the counters once already.
      /\bwire version\b/i,
      /\bv1 and v2\b/i,
    ]) {
      expect(stale.test(readme), `README describes a retired compatibility path: ${stale}`).toBe(false);
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

  test('the README describes retention as a CLOCK, and never as a row cap', () => {
    // The retention claim was false in code for months while this README
    // described the row cap accurately — a document can be honest about the
    // wrong control. Both halves are pinned here: the section has to name the
    // basis the code actually uses, and the environment table must not sell the
    // window as a row cap again.
    const readme = readFileSync(join(COLLECTOR, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('\n## Retention'));
    expect(section.length).toBeGreaterThan(0);
    for (const required of ['received_day', 'arrives', 'instances', 'admission ledger']) {
      expect(section.toLowerCase(), `the Retention section must explain ${required}`).toContain(
        required.toLowerCase(),
      );
    }
    const envRow = readme
      .split('\n')
      .find((l) => l.startsWith('|') && l.includes('MYTHICAL_TELEMETRY_RETENTION_DAYS'));
    expect(envRow, 'the retention variable must be documented in the environment table').toBeDefined();
    expect(envRow).not.toMatch(/row cap/i);
    expect(envRow).toMatch(/arrival/i);
  });
});
