// v1 → v2 normalization (plan §13).
//
// v2 is the native shape. v1 is still accepted for a stated support window,
// because the collector is operator-deployable and the client is public on
// npm: "no client emits v1 any more" is not enforceable by anyone.
//
// This file performs a STRUCTURAL MOVE ONLY. It is not a validator and makes
// no judgement about whether a payload is acceptable — the normalized document
// is handed to the one canonical validator, which decides. That split is what
// keeps a single validator in the repo AND keeps v1 from becoming a second,
// weaker acceptance path.
//
// The one property that matters for security here is that normalization must
// not LAUNDER anything. A v1 payload carrying an undeclared section must stay
// undeclared after the move, so the v2 validator still rejects it. That is why
// every non-envelope key is moved wholesale into `metrics` rather than a known
// list being copied across: copying a known list would silently drop an
// attacker's extra section and turn a rejectable payload into an acceptable
// one.
//
// v1 is brokkr-only by construction (its schema pins `product.name`), so no
// other product has a v1 shape to normalize.

/** Envelope keys that stay at the top level in v2. Everything else moves under `metrics`. */
const V2_ENVELOPE_KEYS = new Set(['schema_version', 'instance_id', 'day', 'product', 'platform']);

export type WireVersion = 1 | 2;

export type NormalizeResult =
  | { ok: true; wireVersion: WireVersion; value: unknown }
  | { ok: false; reason: 'not_an_object' | 'unsupported_schema_version' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the wire version discriminator without trusting anything else about the
 * document. Anything that is not the literal 1 or 2 is unsupported.
 */
export function detectWireVersion(raw: unknown): WireVersion | null {
  if (!isPlainObject(raw)) return null;
  const v = raw['schema_version'];
  if (v === 1) return 1;
  if (v === 2) return 2;
  return null;
}

/**
 * Normalize any accepted wire version into the v2 shape.
 *
 * v2 documents pass through untouched — normalizing them would mean the
 * collector could alter a payload the emitter and the schema agreed on.
 */
export function normalizeToV2(raw: unknown): NormalizeResult {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not_an_object' };
  const version = detectWireVersion(raw);
  if (version === null) return { ok: false, reason: 'unsupported_schema_version' };
  if (version === 2) return { ok: true, wireVersion: 2, value: raw };
  return { ok: true, wireVersion: 1, value: v1ToV2(raw) };
}

/**
 * The v1 → v2 move, in full:
 *
 *   • `schema_version: 1` becomes `2`;
 *   • `product.daemon_version` is renamed to `product.version`;
 *   • every top-level key that is not an envelope key moves under `metrics`.
 *
 * Nothing is dropped, nothing is invented, and nothing is coerced. A v1
 * document that was already invalid stays invalid.
 */
export function v1ToV2(raw: Record<string, unknown>): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (V2_ENVELOPE_KEYS.has(key)) out[key] = value;
    else metrics[key] = value;
  }

  out['schema_version'] = 2;

  // `product` is rebuilt only when it is an object we can rebuild. Anything
  // else is passed through unchanged so the validator sees — and rejects —
  // exactly what arrived.
  const product = raw['product'];
  if (isPlainObject(product)) {
    out['product'] = renameDaemonVersion(product);
  }

  // A v1 document that already carried a `metrics` key had it moved into
  // `metrics.metrics` by the loop above (it is not an envelope key), which the
  // validator rejects as an undeclared section. That is the intended outcome:
  // v1 has no `metrics`, so its presence is an undeclared field, not a hint.
  out['metrics'] = metrics;

  return out;
}

/**
 * Rename `daemon_version` → `version`.
 *
 * When BOTH keys are present the rename is refused and the object is passed
 * through unchanged: renaming would have to overwrite one of two values the
 * sender supplied, and picking a winner is a guess. Passing both through means
 * the v2 validator rejects the payload on the undeclared `daemon_version`,
 * which is the honest answer.
 */
function renameDaemonVersion(product: Record<string, unknown>): Record<string, unknown> {
  const hasLegacy = Object.hasOwn(product, 'daemon_version');
  const hasCurrent = Object.hasOwn(product, 'version');
  if (!hasLegacy || hasCurrent) return { ...product };

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(product)) {
    if (key === 'daemon_version') out['version'] = value;
    else out[key] = value;
  }
  return out;
}
