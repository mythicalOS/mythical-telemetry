// Consent state, WITH PROVENANCE.
//
// A bare boolean cannot distinguish "never asked" from "the user said no". Products that shipped
// with telemetry off by default therefore hold a `false` that means one of two irreconcilable
// things, and a migration that rewrites every `false` to `true` overrides real opt-outs.
//
// So consent carries its source:
//   "unset"      — no one has decided. The ONLY state a migration may flip on.
//   "default-on" — the product's default decided it (opt-out model), not the user.
//   "user"       — the user decided. NEVER overwritten, by a migration or by anything else.
//
// Provenance prevents FUTURE ambiguity; it cannot reconstruct what an existing `{enabled:false}`
// meant. `fromLegacyBoolean` therefore defaults to the conservative reading — a pre-existing
// `false` is treated as a user opt-out — which honours every real opt-out at the cost of some
// installs never entering the opt-out world. That default is a placeholder for a product decision
// that has not been taken; the caller may override it, and the choice belongs in a release note.

export type ConsentSource = "unset" | "default-on" | "user";

export interface ConsentState {
  enabled: boolean;
  source: ConsentSource;
  /** ISO-8601. Changes whenever the decision changes — the transport fences retries on it. */
  decided_at: string;
}

const SOURCES: ReadonlySet<string> = new Set<ConsentSource>(["unset", "default-on", "user"]);

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/** The state of an install nobody has decided for yet. Sends nothing. */
export function unsetConsent(nowMs: number = Date.now()): ConsentState {
  return { enabled: false, source: "unset", decided_at: iso(nowMs) };
}

/** A decision the USER made. This is the state nothing may overwrite. */
export function userConsent(enabled: boolean, nowMs: number = Date.now()): ConsentState {
  return { enabled, source: "user", decided_at: iso(nowMs) };
}

/**
 * The opt-out migration: turn telemetry on for installs nobody has decided for.
 *
 * Returns the state UNCHANGED for `source: "user"` (an opt-out is honoured forever) and for
 * `source: "default-on"` (already migrated — re-running must not churn `decided_at`, which the
 * transport uses as a fence generation).
 */
export function applyDefaultOn(state: ConsentState, nowMs: number = Date.now()): ConsentState {
  if (state.source !== "unset") return state;
  return { enabled: true, source: "default-on", decided_at: iso(nowMs) };
}

/**
 * Adopt a legacy bare boolean into a provenanced state.
 *
 * `treatDisabledAs` decides what a pre-existing `false` meant, and it is genuinely unknowable —
 * see the file header. The default, `"user"`, is the conservative one.
 */
export function fromLegacyBoolean(
  enabled: boolean,
  nowMs: number = Date.now(),
  opts: { treatDisabledAs?: "user" | "unset" } = {},
): ConsentState {
  if (enabled) return { enabled: true, source: "default-on", decided_at: iso(nowMs) };
  return opts.treatDisabledAs === "unset" ? unsetConsent(nowMs) : userConsent(false, nowMs);
}

/** Parse a stored consent document. Returns undefined for anything unrecognised — the caller
 *  then decides, rather than this function guessing a permissive default. */
export function parseConsent(raw: unknown): ConsentState | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const doc = raw as Record<string, unknown>;
  if (typeof doc.enabled !== "boolean") return undefined;
  if (typeof doc.source !== "string" || !SOURCES.has(doc.source)) return undefined;
  if (typeof doc.decided_at !== "string" || Number.isNaN(Date.parse(doc.decided_at))) return undefined;
  return { enabled: doc.enabled, source: doc.source as ConsentSource, decided_at: doc.decided_at };
}

/** May this install send? `unset` never sends — nobody has decided yet. */
export function isSendPermitted(state: ConsentState): boolean {
  return state.enabled && state.source !== "unset";
}

/**
 * The transport's per-send fence input. Any change to the consent decision changes this string,
 * which invalidates every queued retry that was authorised under the old decision.
 */
export function consentGeneration(state: ConsentState): string {
  return `${state.source}:${state.enabled ? "on" : "off"}:${state.decided_at}`;
}
