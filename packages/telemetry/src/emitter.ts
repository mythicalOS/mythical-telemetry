// The emitter: assemble the envelope around a product body, consult consent, hand to transport.
//
// Two things here are deliberately not conveniences.
//
// SELF-VALIDATION BEFORE SEND. The emitter validates its own document against the canonical
// validator and refuses to send an invalid one, surfacing WHY. The alternative is a collector that
// silently rejects the payload and a day that vanishes with no local trace — the exact failure
// mode this package exists to remove.
//
// THE DISCLOSURE PAYLOAD IS A COLLECTION, AND IT WORKS WHEN OPTED OUT. "Show me exactly what you
// would send" is only honest if it shows what would go to EACH destination: under dual-send the
// central and copy bodies differ — different `instance_id`, because the copy carries its own
// destination-scoped identity — so a single response is exact for at most one of them. And it must
// answer while telemetry is off, or the one moment a user most wants to look is the moment the
// answer disappears.

import {
  normalizeProductVersion,
  normalizePlatform,
  utcDayOf,
  validateHeartbeat,
  type Heartbeat,
  type ProductMetrics,
  type ProductName,
} from "./envelope.ts";
import { IdentityStore, normalizeDestinationUrl, type InstanceIdentity } from "./identity.ts";
import { isSendPermitted, type ConsentState } from "./optout.ts";
import {
  assertDestinations,
  destinationGeneration,
  ingestUrlFor,
  Transport,
  TransportConfigError,
  type DestinationKind,
  type SendReport,
} from "./transport.ts";

const MS_PER_DAY = 86_400_000;

export interface EmitterEndpoints {
  /** The central collector. Always required when telemetry is enabled. */
  centralUrl: string;
  /** An operator's own collector. Optional, and never a replacement for central. */
  copyUrl?: string | undefined;
}

export interface EmitterDeps<P extends ProductName> {
  product: P;
  /** The product's package version. Non-semver folds to "other" — no org-nameable space. */
  version: string;
  identity: IdentityStore;
  transport: Transport;
  /** Read LIVE per call: a consent flip must take effect on the next tick, not the next restart. */
  getConsent: () => ConsentState;
  /** Read LIVE per call, for the same reason. */
  getEndpoints: () => EmitterEndpoints;
  /** The product's body for a given UTC day. */
  buildMetrics: (day: string) => ProductMetrics<P>;
  /** Test seam; defaults to process.platform/arch. */
  platform?: { os: string; arch: string };
  nowMs?: () => number;
  log?: (line: string) => void;
}

export interface DisclosureEntry {
  destination: DestinationKind;
  /** The exact URL this body would be POSTed to. */
  endpoint: string;
  /** The identity this destination sees. Central's and the copy's are deliberately different. */
  instance_id: string;
  payload: Heartbeat;
  /** The exact bytes that would go on the wire, for this destination. */
  wire_bytes: string;
  byte_length: number;
}

export type EmitResult =
  | {
      sent: true;
      report: SendReport;
      /**
       * Re-attempts of EARLIER days that were still unresolved. Without this the durable delivery
       * state would be decorative: the candidate day rolls forward at midnight, so a day whose
       * retry window crossed it would never be revisited and would age out of retention unsent.
       */
      drained: SendReport[];
      /**
       * The copy destination was configured but unusable, so this send went to central only.
       * Surfaced rather than swallowed — an operator's typo must be visible — and it does NOT
       * suppress central, which is the whole point of decoupling the two destinations.
       */
      copy_error?: string;
    }
  | { sent: false; reason: "opted_out" | "invalid_payload" | "misconfigured"; detail: string };

export class HeartbeatEmitter<P extends ProductName> {
  private readonly nowMs: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: EmitterDeps<P>) {
    this.nowMs = deps.nowMs ?? Date.now;
    this.log = deps.log ?? ((): void => {});
  }

  /** The most recent COMPLETED UTC day — the one a heartbeat reports on. */
  candidateDay(): string {
    return utcDayOf(this.nowMs() - MS_PER_DAY);
  }

  /** Build the exact document for one destination's identity. */
  buildPayload(day: string, instanceId: string): Heartbeat {
    const platform = this.deps.platform ?? { os: process.platform, arch: process.arch };
    const normalized = normalizePlatform(platform.os, platform.arch);
    return {
      schema_version: 2,
      instance_id: instanceId,
      day,
      product: { name: this.deps.product, version: normalizeProductVersion(this.deps.version) },
      platform: normalized,
      metrics: this.deps.buildMetrics(day),
    } as Heartbeat;
  }

  /**
   * Every destination's exact wire bytes, as a collection. Works regardless of consent — this is
   * the transparency surface, and it must not go dark exactly when someone opts out to inspect it.
   *
   * It does mint identities if none exist yet (local state only; nothing is sent). That is
   * deliberate: the disclosure surface has to work from day zero, before any send has happened.
   */
  disclosure(day: string = this.candidateDay()): DisclosureEntry[] {
    const endpoints = this.deps.getEndpoints();
    const entries: DisclosureEntry[] = [];

    if (endpoints.centralUrl !== "") {
      entries.push(this.entryFor("central", endpoints.centralUrl, this.deps.identity.centralIdentity(), day));
    }
    if (endpoints.copyUrl !== undefined && endpoints.copyUrl !== "") {
      entries.push(this.entryFor("copy", endpoints.copyUrl, this.deps.identity.copyIdentityFor(endpoints.copyUrl), day));
    }
    return entries;
  }

  private entryFor(kind: DestinationKind, url: string, identity: InstanceIdentity, day: string): DisclosureEntry {
    const payload = this.buildPayload(day, identity.instance_id);
    const bytes = JSON.stringify(payload);
    return {
      destination: kind,
      endpoint: ingestUrlFor(normalizeDestinationUrl(url)),
      instance_id: identity.instance_id,
      payload,
      wire_bytes: bytes,
      byte_length: Buffer.byteLength(bytes, "utf8"),
    };
  }

  /**
   * Emit one day. Returns a structured result rather than throwing: telemetry must never be able
   * to break the product it reports on, and a caller that ignores the result loses nothing but the
   * detail.
   */
  async emit(day: string = this.candidateDay()): Promise<EmitResult> {
    const consent = this.deps.getConsent();
    const endpoints = this.deps.getEndpoints();

    // CONSENT IS CHECKED FIRST, before any configuration objection. Ordering it after the
    // destination check meant an install whose central URL had been removed returned
    // "misconfigured" and never reached the fence — so an opt-out left pending payloads on disk
    // for exactly the installs least able to send them.
    if (!isSendPermitted(consent)) {
      // The hard fence: cancel queued retries and purge pending payloads for EVERY destination.
      this.deps.transport.fenceAll("telemetry disabled");
      return { sent: false, reason: "opted_out", detail: `consent source=${consent.source} enabled=${consent.enabled}` };
    }

    // EACH DESTINATION IS JUDGED ON ITS OWN. Treating any configuration failure as a whole-config
    // failure meant a typo in the OPERATOR's URL deleted central's unresolved payloads — a
    // cross-destination purge, which is exactly what the per-destination fence exists to prevent.
    const copyCheck = this.checkCopyEndpoint(endpoints.copyUrl);
    if (copyCheck.error !== undefined) {
      // The copy is retired: its scoped secret is destroyed and its queued deliveries purged.
      // CENTRAL IS UNTOUCHED — a broken operator endpoint never suppresses central.
      if (this.deps.identity.currentCopyDestination() !== undefined) this.deps.identity.clearCopyIdentity();
      this.deps.transport.fenceDestination("copy", undefined, undefined);
      this.log(`telemetry copy destination unusable, sending to central only — ${copyCheck.error}`);
    }

    try {
      // The copy is passed too when it is USABLE, so "a copy configured without a central" keeps
      // its own specific error rather than collapsing into a generic "central required".
      assertDestinations({ central: endpoints.centralUrl === "" ? undefined : endpoints.centralUrl, copy: copyCheck.url });
      // Presence is not validity. `ftp://…`, a malformed URL, or one carrying credentials all pass
      // an is-it-configured check and then throw deep inside the transport — past the fence, with
      // the previous endpoint's pending payload still retained.
      normalizeDestinationUrl(endpoints.centralUrl);
    } catch (err) {
      // Central is unusable, so it is retired — but only central.
      this.deps.transport.fenceDestination("central", undefined, undefined);
      const detail = err instanceof TransportConfigError ? `${err.reason}: ${err.message}` : String(err);
      this.log(`heartbeat not sent — ${detail}`);
      return { sent: false, reason: "misconfigured", detail };
    }

    const central = this.deps.identity.centralIdentity();
    const usableCopyUrl = copyCheck.url;

    // A copy that has been REMOVED retires with its destination too.
    if (usableCopyUrl === undefined && copyCheck.error === undefined) {
      if (this.deps.identity.currentCopyDestination() !== undefined) this.deps.identity.clearCopyIdentity();
      this.deps.transport.fenceDestination("copy", undefined, undefined);
    }

    const copyIdentity = usableCopyUrl === undefined ? undefined : this.deps.identity.copyIdentityFor(usableCopyUrl);
    if (copyIdentity !== undefined && copyIdentity.instance_secret === central.instance_secret) {
      // Defensive: the central secret must never be presented to an operator endpoint. Holding it
      // would let that operator authenticate as this install at central and delete its data.
      return { sent: false, reason: "misconfigured", detail: "copy identity must not reuse the central secret" };
    }

    const centralPayload = this.buildPayload(day, central.instance_id);
    const centralCheck = validateHeartbeat(centralPayload);
    if (!centralCheck.ok) {
      const detail = centralCheck.errors.slice(0, 5).join("; ");
      this.log(`heartbeat not sent — the emitter produced an invalid document: ${detail}`);
      return { sent: false, reason: "invalid_payload", detail };
    }

    let copyBody: string | undefined;
    if (copyIdentity !== undefined) {
      const copyPayload = this.buildPayload(day, copyIdentity.instance_id);
      const copyCheck = validateHeartbeat(copyPayload);
      if (!copyCheck.ok) {
        return { sent: false, reason: "invalid_payload", detail: copyCheck.errors.slice(0, 5).join("; ") };
      }
      copyBody = JSON.stringify(copyPayload);
    }

    const copyDestination =
      copyIdentity === undefined || copyBody === undefined || usableCopyUrl === undefined
        ? undefined
        : { url: usableCopyUrl, identity: copyIdentity, body: copyBody };

    const report = await this.deps.transport.send({
      day,
      product: this.deps.product,
      consent,
      central: { url: endpoints.centralUrl, identity: central, body: JSON.stringify(centralPayload) },
      copy: copyDestination,
    });

    // Then re-attempt anything older that is still unresolved, using the bytes those deliveries
    // were created with. A delta-normalising producer cannot rebuild an older day — its snapshot
    // has moved on — so a retry that is not a re-send of the stored payload is not a retry at all.
    const drained = await this.deps.transport.drain({
      product: this.deps.product,
      consent,
      central: { url: endpoints.centralUrl, identity: central },
      copy: copyDestination === undefined ? undefined : { url: copyDestination.url, identity: copyDestination.identity },
      exceptDay: day,
    });

    return copyCheck.error === undefined ? { sent: true, report, drained } : { sent: true, report, drained, copy_error: copyCheck.error };
  }

  /**
   * Is the copy endpoint absent, usable, or configured-but-broken? Its verdict never touches
   * central: they are independent destinations and a fault in one must not fence the other.
   */
  private checkCopyEndpoint(copyUrl: string | undefined): { url?: string; error?: string } {
    if (copyUrl === undefined || copyUrl === "") return {};
    try {
      normalizeDestinationUrl(copyUrl);
      return { url: copyUrl };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Per-destination delivery state for a day, without sending. */
  status(day: string = this.candidateDay()): SendReport | undefined {
    const endpoints = this.deps.getEndpoints();
    if (endpoints.centralUrl === "") return undefined;
    return this.deps.transport.status({
      day,
      central: { url: endpoints.centralUrl },
      copy: endpoints.copyUrl === undefined || endpoints.copyUrl === "" ? undefined : { url: endpoints.copyUrl },
    });
  }

  /**
   * Apply a consent or endpoint change immediately, without waiting for the next tick.
   *
   * A global opt-out fences BOTH destinations. An endpoint change fences only the destination it
   * changed: switching the operator URL must not cancel an unresolved central delivery whose
   * consent and configuration are unchanged.
   */
  applyConfigChange(): void {
    const consent = this.deps.getConsent();
    if (!isSendPermitted(consent)) {
      this.deps.transport.fenceAll("telemetry disabled");
      return;
    }
    const endpoints = this.deps.getEndpoints();
    // Each destination is fenced on ITS OWN validity, in its own try. A malformed copy URL must
    // not reach across and purge central's unresolved deliveries, and neither may throw at the
    // caller — this runs on a settings-save path.
    this.fenceOne("central", endpoints.centralUrl, consent);
    this.fenceOne("copy", endpoints.copyUrl, consent);
  }

  private fenceOne(kind: DestinationKind, url: string | undefined, consent: ConsentState): void {
    if (url === undefined || url === "") {
      // Removed ⇒ retired: purge what was queued for it rather than leaving it addressed to
      // something that may never come back.
      if (kind === "copy" && this.deps.identity.currentCopyDestination() !== undefined) this.deps.identity.clearCopyIdentity();
      this.deps.transport.fenceDestination(kind, undefined, undefined);
      return;
    }
    try {
      const destination = normalizeDestinationUrl(url);
      const identity = kind === "central" ? this.deps.identity.centralIdentity() : this.deps.identity.copyIdentityFor(url);
      this.deps.transport.fenceDestination(kind, destination, destinationGeneration(consent, kind, destination, identity.instance_secret));
    } catch (err) {
      // Unusable ⇒ retired, but only this destination.
      this.log(`telemetry ${kind} destination unusable: ${err instanceof Error ? err.message : String(err)}`);
      if (kind === "copy" && this.deps.identity.currentCopyDestination() !== undefined) this.deps.identity.clearCopyIdentity();
      this.deps.transport.fenceDestination(kind, undefined, undefined);
    }
  }
}
