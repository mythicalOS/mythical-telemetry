// @mythicalos/telemetry — the shared heartbeat client for the mythicalOS product family.
//
// The privacy rules exist exactly ONCE, here, for the heartbeat channel. Three hand-maintained
// copies of "counts and buckets only, nothing nameable" is three chances to leak, and a
// client/collector pair that each keep their own validator is a live drift hazard: a broader
// client gets its payloads rejected, a narrower one loses real data to "other".
//
// Scope note, because it matters for the copy a product writes: this package covers the HEARTBEAT
// channel. A product may have other outbound channels with their own consent story. Do not write
// "telemetry is pseudonymous and carries no identifiers" over a product whose other channels say
// otherwise — scope the claim to usage telemetry, and describe the rest separately.

export {
  SCHEMA_VERSION,
  PRODUCT_NAMES,
  PLATFORM_OS,
  PLATFORM_ARCH,
  UPTIME_BUCKETS,
  DETECTION_STATES,
  DAY_PATTERN,
  INSTANCE_ID_PATTERN,
  PRODUCT_VERSION_PATTERN,
  validateHeartbeat,
  isHeartbeat,
  normalizeProductVersion,
  normalizePlatform,
  utcDayOf,
  uptimeBucket,
  type ProductName,
  type ProductMetrics,
  type UptimeBucket,
  type DetectionState,
  type BrokkrMetrics,
  type SagaMetrics,
  type SkuldMetrics,
  type HeartbeatEnvelope,
  type BrokkrHeartbeat,
  type SagaHeartbeat,
  type SkuldHeartbeat,
  type Heartbeat,
  type ValidationResult,
} from "./envelope.ts";

export { MODEL_ID_ALLOWLIST, MODEL_OTHER, normalizeModelId, type AllowlistedModelId } from "./model-id-allowlist.ts";

export {
  deriveInstanceId,
  mintInstanceSecret,
  normalizeDestinationUrl,
  telemetryDirPath,
  instanceFilePath,
  copyIdentityFilePath,
  IdentityStore,
  INSTANCE_SECRET_PATTERN,
  type InstanceIdentity,
  type IdentityStoreOptions,
} from "./identity.ts";

export {
  unsetConsent,
  userConsent,
  applyDefaultOn,
  fromLegacyBoolean,
  parseConsent,
  isSendPermitted,
  consentGeneration,
  type ConsentSource,
  type ConsentState,
} from "./optout.ts";

export * from "./bodies/index.ts";

export {
  blockedAddressReason,
  isLoopbackAddress,
  resolveAndPin,
  postPinned,
  EndpointRejected,
  type EndpointPolicy,
  type PinnedEndpoint,
  type PostResult,
  type PostOptions,
} from "./ssrf.ts";

export {
  Transport,
  TransportConfigError,
  assertDestinations,
  destinationGeneration,
  deliveryStateFilePath,
  ingestUrlFor,
  describeSendReport,
  type DestinationKind,
  type DeliveryStatus,
  type DeliveryRecord,
  type DestinationOutcome,
  type DestinationInput,
  type SendInput,
  type SendReport,
  type TransportOptions,
} from "./transport.ts";

export {
  HeartbeatEmitter,
  type EmitterDeps,
  type EmitterEndpoints,
  type DisclosureEntry,
  type EmitResult,
} from "./emitter.ts";
