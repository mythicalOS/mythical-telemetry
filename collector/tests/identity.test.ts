// Derived identity: instance_id = the first 16 bytes of sha256(secret)
// formatted as a UUID with v4 version/variant bits. Stateless verification:
// derive(presented) === claimed, constant-time.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { authorizesInstance, constantTimeEqual, UUID_V4_RE, uuidFromSecret } from '../src/identity';
import { INSTANCE_A, INSTANCE_B, SECRET_A, SECRET_B } from './fixtures';

describe('uuidFromSecret', () => {
  test('produces a lowercase UUIDv4-shaped id', () => {
    const id = uuidFromSecret(SECRET_A);
    expect(UUID_V4_RE.test(id)).toBe(true);
    expect(id).toBe(id.toLowerCase());
  });

  test('version nibble is 4 and variant bits are 10 (byte6/byte8 discipline)', () => {
    for (const secret of [SECRET_A, SECRET_B, 'c'.repeat(64), 'deadbeef', '']) {
      const id = uuidFromSecret(secret);
      expect(id.charAt(14)).toBe('4');
      expect(['8', '9', 'a', 'b']).toContain(id.charAt(19));
    }
  });

  test('deterministic: same secret, same id', () => {
    expect(uuidFromSecret(SECRET_A)).toBe(uuidFromSecret(SECRET_A));
  });

  test('pinned regression vectors — the derivation must never drift', () => {
    // Ids at rest depend on these exact bytes. A change here silently orphans
    // every existing install's history and its own delete capability.
    expect(uuidFromSecret(SECRET_A)).toBe('ffe054fe-7ae0-4b6d-865c-3af9b61d5209');
    expect(uuidFromSecret(SECRET_B)).toBe('a0fab137-7f49-4759-b57f-63318262ebe8');
  });

  test('hashes the UTF-8 bytes of the hex STRING, not the 32 bytes it decodes to', () => {
    // The distinction is the whole compatibility hazard called out in the
    // plan, so it is pinned rather than described.
    const asString = createHash('sha256').update(SECRET_A, 'utf8').digest();
    const asBytes = createHash('sha256').update(Buffer.from(SECRET_A, 'hex')).digest();
    expect(asString.equals(asBytes)).toBe(false);
    expect(uuidFromSecret(SECRET_A).replace(/-/g, '').slice(0, 12)).toBe(asString.subarray(0, 6).toString('hex'));
  });

  test('distinct secrets derive distinct ids', () => {
    expect(INSTANCE_A).not.toBe(INSTANCE_B);
  });
});

describe('constantTimeEqual', () => {
  test('equal strings compare true', () => {
    expect(constantTimeEqual(INSTANCE_A, INSTANCE_A)).toBe(true);
  });
  test('differing strings compare false', () => {
    expect(constantTimeEqual(INSTANCE_A, INSTANCE_B)).toBe(false);
  });
  test('strings differing only in the LAST character compare false', () => {
    const almost = `${INSTANCE_A.slice(0, -1)}${INSTANCE_A.endsWith('a') ? 'b' : 'a'}`;
    expect(constantTimeEqual(INSTANCE_A, almost)).toBe(false);
  });
  test('length mismatch compares false without throwing', () => {
    expect(constantTimeEqual('short', INSTANCE_A)).toBe(false);
    expect(constantTimeEqual('', INSTANCE_A)).toBe(false);
    expect(constantTimeEqual(`${INSTANCE_A}x`, INSTANCE_A)).toBe(false);
  });
  test('multi-byte input does not throw or falsely match', () => {
    expect(constantTimeEqual('é'.repeat(18), INSTANCE_A)).toBe(false);
  });
});

describe('authorizesInstance', () => {
  test('the owning secret authorizes; any other does not', () => {
    expect(authorizesInstance(SECRET_A, INSTANCE_A)).toBe(true);
    expect(authorizesInstance(SECRET_B, INSTANCE_A)).toBe(false);
  });
  test('absent or empty secrets never authorize', () => {
    expect(authorizesInstance(null, INSTANCE_A)).toBe(false);
    expect(authorizesInstance(undefined, INSTANCE_A)).toBe(false);
    expect(authorizesInstance('', INSTANCE_A)).toBe(false);
  });
  test('the derived id itself is not a credential', () => {
    // Presenting the id as if it were the secret must not authorize — that is
    // the whole point of the id being derived rather than shared.
    expect(authorizesInstance(INSTANCE_A, INSTANCE_A)).toBe(false);
  });
});
