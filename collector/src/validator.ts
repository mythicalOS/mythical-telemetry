// ══════════════════════════════════════════════════════════════════════════
//  THE VALIDATOR SEAM
// ══════════════════════════════════════════════════════════════════════════
//
// There is exactly ONE runtime heartbeat validator in this repository and it
// lives in the published client package, next to the JSON Schema and the
// emitter that produces payloads. A second validator here would be precisely
// the drift this repo exists to eliminate: the schema, the emitter and the
// acceptor must be provably the same contract, and a lockstep test can only
// span them while they are one artifact.
//
// The collector therefore OWNS NO SCHEMA KNOWLEDGE. It declares the narrow
// interface below, takes an implementation as a constructor dependency, and
// treats a validated payload as opaque apart from the envelope fields it must
// index by (id, product, day).
//
// Tests inject a test double. Production injects the canonical validator at
// the single wiring site — see `loadCanonicalValidator()` at the bottom of
// this file, called only from `src/cli/server.ts`.

/**
 * The v2 envelope, as far as the collector is concerned.
 *
 * These are the only fields the collector reads directly; `metrics` is opaque
 * — the collector stores it, echoes it back to its owner, and folds declared
 * paths out of it (see `totals.ts`) without ever asserting its shape.
 */
export interface Heartbeat {
  schema_version: 2;
  instance_id: string;
  day: string;
  product: { name: string; version: string };
  platform: { os: string; arch: string };
  metrics: Record<string, unknown>;
}

export type ValidationResult =
  | { ok: true; value: Heartbeat }
  | { ok: false; error: string };

/**
 * The one thing the collector needs from the client package.
 *
 * `validate` must be total: it accepts genuinely arbitrary input from a public
 * unauthenticated route and must never throw. The collector still wraps every
 * call defensively (`safeValidate`), because "must never throw" is a contract
 * with a third party, not a guarantee.
 */
export interface HeartbeatValidator {
  validate(raw: unknown): ValidationResult;
}

/**
 * Call a validator without trusting it to honour its own contract. A thrown
 * validator becomes an ordinary rejection rather than a 500 — one malformed
 * input must not be able to take the ingest route down.
 */
export function safeValidate(validator: HeartbeatValidator, raw: unknown): ValidationResult {
  let result: ValidationResult;
  try {
    result = validator.validate(raw);
  } catch {
    return { ok: false, error: 'validator_threw' };
  }
  if (!result || typeof result !== 'object') return { ok: false, error: 'validator_malformed_result' };
  if (result.ok !== true) return { ok: false, error: typeof result.error === 'string' ? result.error : 'invalid' };
  const value = result.value as Heartbeat | undefined;
  // Envelope fields the collector indexes by must exist and be strings even if
  // a future validator's typing says otherwise — they become primary-key
  // components, so a non-string here would corrupt the store rather than
  // reject a request.
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.instance_id !== 'string' ||
    typeof value.day !== 'string' ||
    !value.product ||
    typeof value.product !== 'object' ||
    typeof value.product.name !== 'string'
  ) {
    return { ok: false, error: 'validator_malformed_result' };
  }
  return { ok: true, value };
}

// ── The wiring site ───────────────────────────────────────────────────────
//
// MERGE POINT — this is the ONLY place the canonical validator is named.
//
// At merge with the client-package branch:
//   1. add `"@mythicalos/telemetry": "workspace:*"` to collector/package.json
//      `dependencies` (it is deliberately absent while the package does not
//      exist on this branch — declaring it would break `bun install`);
//   2. confirm the export name below matches what the package exports, and
//      replace the dynamic import with a static one if a static import is
//      preferred.
//
// Nothing else in the collector imports the package. If this function is the
// only thing that needs changing at merge, the seam did its job.

const CANONICAL_VALIDATOR_MODULE = '@mythicalos/telemetry';

/**
 * What the client package actually exports: a total function returning
 * `{ok:true, value}` or `{ok:false, errors: string[]}` — note the PLURAL,
 * which is why this is an adapter and not a rename.
 */
interface ValidatorModuleShape {
  validateHeartbeat?: (raw: unknown) => { ok: true; value: unknown } | { ok: false; errors: string[] };
}

/**
 * The package's rejection detail is DISCARDED rather than adapted through.
 *
 * Its error strings are of the form `path: expectation`, and a path can embed
 * an attacker-supplied property name from a rejected document. The collector
 * only ever uses this string to choose between two counter names — it is never
 * returned on the wire and never stored — so passing the real text through
 * would buy nothing and would put attacker-controlled bytes on a code path
 * that a future change could easily start logging or persisting. The client
 * package removed an equivalent field for exactly this reason after it was
 * bypassed four separate ways; re-introducing the class here would undo that.
 *
 * `schema_invalid` deliberately does NOT start with `validator_`, so the server
 * still distinguishes a rejected payload from a faulty validator.
 */
const SCHEMA_INVALID = 'schema_invalid';

/**
 * Load the canonical validator from the client package.
 *
 * Throws a deliberately actionable error when the package is absent or does
 * not export a validator: the collector must refuse to start rather than fall
 * back to a permissive local approximation. "Accepts everything because the
 * validator failed to load" is the one failure mode that must be impossible.
 */
export async function loadCanonicalValidator(): Promise<HeartbeatValidator> {
  // Indirected through a variable so this file typechecks on a branch where
  // the package is not yet present.
  const spec: string = CANONICAL_VALIDATOR_MODULE;
  let mod: ValidatorModuleShape;
  try {
    mod = (await import(spec)) as ValidatorModuleShape;
  } catch (err) {
    throw new Error(
      `cannot load the canonical heartbeat validator from "${CANONICAL_VALIDATOR_MODULE}": ${
        err instanceof Error ? err.message : String(err)
      }. The collector refuses to start without it — it never validates payloads itself.`,
    );
  }
  const validateHeartbeat = mod.validateHeartbeat;
  if (typeof validateHeartbeat !== 'function') {
    throw new Error(
      `"${CANONICAL_VALIDATOR_MODULE}" exports no heartbeat validator ` +
        '(expected a `validateHeartbeat` function).',
    );
  }
  return {
    validate(raw: unknown): ValidationResult {
      const result = validateHeartbeat(raw);
      if (result.ok) return { ok: true, value: result.value as Heartbeat };
      return { ok: false, error: SCHEMA_INVALID };
    },
  };
}
