// The CLOSED model-id allowlist: a heartbeat's `models[].name` carries ONLY publicly-published
// model IDs. Anything else — including pattern-plausible strings like `acme-internal-sonnet` that
// would carry org identity — buckets to "other" at the emitter, and is rejected by the collector's
// enum built from this same list. Identity-leak capacity: zero.
//
// The tradeoff is deliberate: a brand-new public model reports "other" until an updated allowlist
// ships, and an "other" spike is itself the refresh signal.
//
// THIS IS THE SINGLE COPY. It previously existed twice — once in the emitting product, once in the
// collector — hand-synced, where a mismatch is silently harmful in both directions (a broader
// client gets payloads rejected; a narrower one loses real data to "other"). The collector imports
// it from here. Do not fork it.

/** Publicly-published model IDs. Kept equal to the schema enum by the lockstep test. */
export const MODEL_ID_ALLOWLIST = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-1",
  "claude-sonnet-4-20250514",
  "claude-3-5-haiku-20241022",
  "gpt-5",
  "gpt-4.1",
  "o3",
  "codex-mini-latest",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
] as const;

/** The bucket value for everything off the list (also the model-unknown value). */
export const MODEL_OTHER = "other";

export type AllowlistedModelId = (typeof MODEL_ID_ALLOWLIST)[number] | typeof MODEL_OTHER;

const ALLOWED: ReadonlySet<string> = new Set<string>(MODEL_ID_ALLOWLIST);

/** Normalize a model id through the closed allowlist: exact member passes, everything else ⇒ "other". */
export function normalizeModelId(name: string | undefined | null): AllowlistedModelId {
  return typeof name === "string" && ALLOWED.has(name) ? (name as AllowlistedModelId) : MODEL_OTHER;
}
