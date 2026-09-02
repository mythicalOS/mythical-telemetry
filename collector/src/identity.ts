// Derived identity — stateless authorization for BOTH writes and reads.
//
// instance_secret = 32 random bytes hex, minted by the install, never
// serialized into any payload; it travels only in a request header.
// instance_id = the first 16 bytes of sha256(instance_secret) formatted as a
// UUID with v4 version/variant bits stamped.
//
// The collector authorizes by recomputing derive(presented_secret) and
// constant-time comparing it to the claimed id. There is no registration step,
// no stored key material, no first-writer claim race, and NO shared or baked
// key of any kind. Forging access to an identity is a sha256 preimage.
//
// The derivation is byte-frozen: ids at rest depend on it, and every existing
// install would silently mint a new identity — orphaning its history and its
// own delete capability — if any step drifted. It hashes the UTF-8 bytes of
// the 64-char hex STRING, not the 32 bytes that string decodes to.

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Canonical lowercase UUIDv4 shape.
 *
 * ROUTE HYGIENE ONLY. This is not payload validation: it exists so a path
 * parameter is rejected before it ever reaches a prepared statement, and so a
 * malformed id is indistinguishable from an unknown one. Heartbeat payload
 * validation belongs exclusively to the injected canonical validator
 * (see `validator.ts`).
 */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Derive the instance UUID from the presented secret.
 *
 * Byte discipline: byte6 high nibble := 4 (version), byte8 top two bits := 10
 * (variant), then 8-4-4-4-12 lowercase hex formatting.
 */
export function uuidFromSecret(secretHex: string): string {
  const digest = createHash('sha256').update(secretHex, 'utf8').digest();
  const b = Uint8Array.from(digest.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Constant-time string equality — the derived-identity check must not leak
 * match position through timing.
 *
 * Both operands here are fixed-length lowercase UUID strings, so the length
 * itself is not a secret and an early length return leaks nothing. The
 * comparison itself delegates to node's `timingSafeEqual` rather than a
 * hand-rolled loop, because a JS loop over two Buffers is not a timing
 * guarantee the engine is obliged to honour.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  if (ab.length === 0) return true;
  return timingSafeEqual(ab, bb);
}

/**
 * Authorize a presented secret against a claimed instance id.
 *
 * Returns false for an absent secret without distinguishing it from a wrong
 * one at the call site — the route surface must answer both identically.
 */
export function authorizesInstance(secret: string | null | undefined, instanceId: string): boolean {
  if (secret === null || secret === undefined || secret === '') return false;
  return constantTimeEqual(uuidFromSecret(secret), instanceId);
}
