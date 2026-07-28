// Dual-send transport: always central, optionally ALSO an operator copy.
//
// THE RULES, AND WHY EACH ONE EXISTS
//
// Copy-without-central is not a valid configuration and is rejected at the type/validation
// boundary, not tolerated at runtime. A copy supplements central; it never replaces it.
//
// DELIVERY IS NOT ATOMIC AND MUST NOT BE COUPLED. Two HTTP calls cannot be atomic, and coupling
// them means a flaky operator endpoint suppresses central data while a central outage suppresses
// the operator's copy. The two run independently and one's failure never gates the other.
//
// PER-DESTINATION DURABLE STATE. A single per-day "sent" marker is wrong the moment there are two
// destinations: mark on first success and the copy never retries; leave it unmarked and central is
// re-sent on every copy retry, duplicating at a non-idempotent operator collector. So each
// (day, destination) carries its own attempt count, last attempt, next attempt and terminal status.
//
// BOUNDED ATTEMPTS WITH JITTER. A fixed retry interval turns a fleet into a thundering herd the
// moment an outage ends — every install retries in the same second. Backoff is exponential and
// jittered, and attempts are capped so a permanently broken endpoint stops rather than spins.
//
// SINGLE-FLIGHT per (day, destination), plus an idempotency key so an operator collector that
// does dedupe can, and one that does not at least sees the same key twice.
//
// OPT-OUT IS A HARD FENCE. Disabling telemetry, or changing an endpoint or credential, cancels
// queued retries and purges pending state — otherwise a scheduled retry fires AFTER the user opted
// out, to an endpoint they just removed. The fence is PER DESTINATION: changing only the copy URL
// must not cancel an unresolved central delivery whose consent and configuration are unchanged.
// Only a global opt-out fences both.
//
// PARTIAL STATE IS EXPOSED, NOT HIDDEN. "central delivered, copy unresolved" is a real and common
// state; a surface that reports only "sent" or nothing at all is lying by omission.

import { createHash } from "node:crypto";
import { atomicWriteFileSync, readJsonSync } from "./atomic.ts";
import { normalizeDestinationUrl, telemetryDirPath, type InstanceIdentity } from "./identity.ts";
import { consentGeneration, isSendPermitted, type ConsentState } from "./optout.ts";
import { EndpointRejected, postPinned, resolveAndPin, type EndpointPolicy, type PinnedEndpoint, type PostResult } from "./ssrf.ts";
import type { ProductName } from "./envelope.ts";
import path from "node:path";

export type DestinationKind = "central" | "copy";

export type DeliveryStatus =
  /** Accepted by the destination. Terminal, and never re-sent for that day. */
  | "delivered"
  /** Not yet delivered and still eligible — a retry is scheduled. */
  | "pending"
  /** Attempts exhausted, or the destination is rejected outright. Terminal until config changes. */
  | "exhausted";

export interface DeliveryRecord {
  day: string;
  kind: DestinationKind;
  /** Normalised destination URL — the identity of the endpoint, not the raw config string. */
  destination: string;
  /** Fences this record to one (consent decision, endpoint, credential) triple. */
  generation: string;
  idempotency_key: string;
  attempts: number;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  /** ISO time before which no further attempt is made. */
  next_attempt_at: string | null;
  status: DeliveryStatus;
  last_error: string | null;
  last_http_status: number | null;
  /**
   * The exact wire bytes this delivery is for, held ONLY while it is unresolved.
   *
   * Without it, an unresolved day can never be retried after midnight: the emitter reports the most
   * recent completed day, and a delta-normalising producer cannot rebuild an older day at all —
   * its snapshot has already moved on. So a day whose retry window crossed midnight would be
   * silently lost. Cleared the moment the delivery reaches a terminal state, and purged by every
   * fence, so an opt-out really does purge the pending payload rather than leaving it on disk.
   */
  body?: string;
}

interface BreakerState {
  consecutive_failures: number;
  /** ISO time until which the destination is not contacted at all. */
  open_until: string | null;
}

interface DeliveryStateFile {
  version: 1;
  records: Record<string, DeliveryRecord>;
  breakers: Record<string, BreakerState>;
}

export interface DestinationOutcome {
  kind: DestinationKind;
  destination: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  last_http_status: number | null;
  /** Why nothing was attempted this round, when nothing was. */
  skipped_because: "backoff" | "circuit_open" | "in_flight" | "budget_exhausted" | "opted_out" | null;
}

export interface SendReport {
  day: string;
  central: DestinationOutcome;
  copy: DestinationOutcome | null;
  /** True when the destinations disagree — the state a "sent/not sent" surface would hide. */
  partial: boolean;
}

export class TransportConfigError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "TransportConfigError";
  }
}

export interface DestinationInput {
  url: string;
  identity: InstanceIdentity;
  /** The exact wire bytes for THIS destination — the bodies differ (different instance_id). */
  body: string;
}

export interface SendInput {
  day: string;
  product: ProductName;
  consent: ConsentState;
  /** Always required. There is no copy-only configuration. */
  central: DestinationInput;
  copy?: DestinationInput | undefined;
}

export interface TransportOptions {
  stateRoot: string;
  /** Hard per-attempt deadline. Default 5s — the single-send path's existing abort, preserved. */
  perAttemptTimeoutMs?: number;
  /** Ceiling on the whole fan-out, so two slow destinations cannot serialise into a long stall. */
  overallBudgetMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  /** Concurrent destinations in flight. Bounded so a future fan-out cannot open N sockets. */
  maxConcurrency?: number;
  /** Days of delivery state kept before pruning. */
  retentionDays?: number;
  policy?: EndpointPolicy;
  nowMs?: () => number;
  random?: () => number;
  log?: (line: string) => void;
  /** Seams for tests — production uses the pinned, policy-checked implementations. */
  resolveImpl?: (url: string, policy: EndpointPolicy) => Promise<PinnedEndpoint>;
  postImpl?: (args: {
    endpoint: PinnedEndpoint;
    body: string;
    headers: Record<string, string>;
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<PostResult>;
}

const DEFAULTS = {
  perAttemptTimeoutMs: 5_000,
  overallBudgetMs: 20_000,
  maxAttempts: 6,
  baseBackoffMs: 60_000,
  maxBackoffMs: 6 * 60 * 60_000,
  breakerThreshold: 5,
  breakerCooldownMs: 30 * 60_000,
  maxConcurrency: 2,
  retentionDays: 35,
} as const;

export function deliveryStateFilePath(stateRoot: string): string {
  return path.join(telemetryDirPath(stateRoot), "delivery.json");
}

/** `<endpoint>/v1/ingest`, preserving any query string the operator configured. */
export function ingestUrlFor(normalizedDestination: string): string {
  const url = new URL(normalizedDestination);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/ingest`;
  return url.toString();
}

function recordKey(day: string, kind: DestinationKind, destination: string): string {
  return `${day}|${kind}|${destination}`;
}

function breakerKey(kind: DestinationKind, destination: string): string {
  return `${kind}|${destination}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The fence generation for one destination. Any change to the consent decision, the endpoint or
 * the credential produces a different value, which invalidates retries authorised under the old
 * one. The secret is HASHED here, never stored in the delivery state.
 */
export function destinationGeneration(consent: ConsentState, kind: DestinationKind, destination: string, secret: string): string {
  return sha256Hex(`${consentGeneration(consent)}|${kind}|${destination}|${secret}`).slice(0, 32);
}

/** Rejects the one configuration that is not allowed to exist. */
export function assertDestinations(input: { central?: unknown; copy?: unknown }): void {
  if (input.central === undefined || input.central === null) {
    if (input.copy !== undefined && input.copy !== null) {
      throw new TransportConfigError(
        "copy_without_central",
        "a copy destination without a central destination is not a valid configuration — a copy supplements central, it never replaces it",
      );
    }
    throw new TransportConfigError("central_required", "a central destination is required");
  }
}

export class Transport {
  private readonly opts: Required<Omit<TransportOptions, "policy" | "resolveImpl" | "postImpl" | "log">> & {
    policy: EndpointPolicy;
    resolveImpl: NonNullable<TransportOptions["resolveImpl"]>;
    postImpl: NonNullable<TransportOptions["postImpl"]>;
    log: (line: string) => void;
  };
  private readonly inflight = new Map<string, Promise<DestinationOutcome>>();
  /** Aborters for in-flight attempts, so a fence can cancel them mid-request. */
  private readonly aborters = new Map<string, AbortController>();

  constructor(options: TransportOptions) {
    this.opts = {
      stateRoot: options.stateRoot,
      perAttemptTimeoutMs: options.perAttemptTimeoutMs ?? DEFAULTS.perAttemptTimeoutMs,
      overallBudgetMs: options.overallBudgetMs ?? DEFAULTS.overallBudgetMs,
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
      baseBackoffMs: options.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      breakerThreshold: options.breakerThreshold ?? DEFAULTS.breakerThreshold,
      breakerCooldownMs: options.breakerCooldownMs ?? DEFAULTS.breakerCooldownMs,
      maxConcurrency: options.maxConcurrency ?? DEFAULTS.maxConcurrency,
      retentionDays: options.retentionDays ?? DEFAULTS.retentionDays,
      nowMs: options.nowMs ?? Date.now,
      random: options.random ?? Math.random,
      policy: options.policy ?? {},
      log: options.log ?? ((): void => {}),
      resolveImpl: options.resolveImpl ?? ((url, policy): Promise<PinnedEndpoint> => resolveAndPin(url, policy)),
      postImpl:
        options.postImpl ??
        ((args): Promise<PostResult> =>
          postPinned({
            endpoint: args.endpoint,
            body: args.body,
            headers: args.headers,
            timeoutMs: args.timeoutMs,
            signal: args.signal,
          })),
    };
  }

  // ── durable state ────────────────────────────────────────────────────────────────────────
  //
  // THIS DOCUMENT IS NEVER CACHED, AND THAT IS THE POINT. An earlier shape read the file once and
  // kept it in memory for the life of the object; every write then sent that whole remembered
  // document back. Two processes each holding a full stale copy do not lose a field, they erase
  // each other's delivery RECORDS — and those records are the only thing standing between a retry
  // and a duplicate send, or between an opt-out and a payload that is still on disk. So the file
  // is re-read immediately before every mutation and the mutation is applied to what is actually
  // there, in `transact` below.
  //
  // WHAT THIS DOES AND DOES NOT GUARANTEE, stated plainly because the stronger claim would be
  // false. `transact` narrows the read-modify-write to a single synchronous read → mutate → atomic
  // write with no `await` inside it, so nothing another writer did before it began is discarded,
  // and in particular the long window that used to span an entire HTTP round trip is gone. It is
  // not a compare-and-exchange: the filesystem offers none, so two writers landing inside that
  // microsecond window can still resolve to one. One writer per state directory remains the
  // supported topology; this makes the unsupported one degrade instead of corrupt.

  private readState(): DeliveryStateFile {
    const raw = readJsonSync(deliveryStateFilePath(this.opts.stateRoot));
    const empty: DeliveryStateFile = { version: 1, records: {}, breakers: {} };
    if (raw === null || typeof raw !== "object") return empty;
    const doc = raw as Record<string, unknown>;
    const records: Record<string, DeliveryRecord> = {};
    if (doc.records !== null && typeof doc.records === "object") {
      for (const [key, value] of Object.entries(doc.records as Record<string, unknown>)) {
        const rec = parseRecord(value);
        if (rec !== undefined) records[key] = rec;
      }
    }
    const breakers: Record<string, BreakerState> = {};
    if (doc.breakers !== null && typeof doc.breakers === "object") {
      for (const [key, value] of Object.entries(doc.breakers as Record<string, unknown>)) {
        if (value === null || typeof value !== "object") continue;
        const b = value as Record<string, unknown>;
        breakers[key] = {
          consecutive_failures: typeof b.consecutive_failures === "number" ? b.consecutive_failures : 0,
          open_until: typeof b.open_until === "string" ? b.open_until : null,
        };
      }
    }
    return { version: 1, records, breakers };
  }

  private writeState(state: DeliveryStateFile): void {
    this.prune(state);
    try {
      atomicWriteFileSync(deliveryStateFilePath(this.opts.stateRoot), JSON.stringify(state, null, 2));
    } catch (err) {
      // A delivery-state write that fails must not take the product down. The consequence is a
      // possible duplicate send after a restart, which the idempotency key exists to absorb.
      this.opts.log(`delivery state persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * One read-modify-write against the CURRENT on-disk document. `fn` runs synchronously — putting
   * an `await` inside it would re-open the window this exists to close — and says whether it
   * changed anything, so a read-only pass does not rewrite the file (and does not create it).
   */
  private transact<T>(fn: (state: DeliveryStateFile) => { value: T; changed: boolean }): T {
    const state = this.readState();
    const { value, changed } = fn(state);
    if (changed) this.writeState(state);
    return value;
  }

  private prune(state: DeliveryStateFile): void {
    const cutoff = new Date(this.opts.nowMs() - this.opts.retentionDays * 86_400_000).toISOString().slice(0, 10);
    for (const [key, rec] of Object.entries(state.records)) {
      if (rec.day < cutoff) delete state.records[key];
    }
  }

  /**
   * The durable record for one (day, destination), or undefined.
   *
   * A DETACHED SNAPSHOT, read from disk on each call. It used to be a live reference into the
   * cached document, so mutating the returned object silently changed what the next write
   * persisted; there is no cache now and no such back door. To change delivery state, call the
   * transport.
   */
  record(day: string, kind: DestinationKind, destinationUrl: string): DeliveryRecord | undefined {
    const destination = normalizeDestinationUrl(destinationUrl);
    return this.readState().records[recordKey(day, kind, destination)];
  }

  // ── fences ───────────────────────────────────────────────────────────────────────────────

  /**
   * The GLOBAL fence. Telemetry was turned off: every unresolved delivery is cancelled and purged,
   * in flight or queued, for every destination. A delivered record is left alone — it is a record
   * of something that already happened, not a pending payload.
   */
  fenceAll(reason = "opt-out"): void {
    for (const [key, controller] of this.aborters) {
      controller.abort();
      this.aborters.delete(key);
    }
    this.opts.log(`telemetry delivery fenced (${reason}): queued retries cancelled, pending payloads purged`);
    this.transact((state) => {
      for (const [key, rec] of Object.entries(state.records)) {
        if (rec.status !== "delivered") delete state.records[key];
      }
      state.breakers = {};
      // Always written, even when nothing matched: an opt-out that reports "purged" must leave a
      // document that says so rather than one that merely happens to look right.
      return { value: undefined, changed: true };
    });
  }

  /**
   * The PER-DESTINATION fence. Only records for `kind` are touched: changing the operator URL must
   * not cancel an unresolved central delivery whose consent and configuration are unchanged.
   * Purges records pointing at a retired destination, and pending records whose generation no
   * longer matches (endpoint or credential changed under them).
   */
  fenceDestination(kind: DestinationKind, destination: string | undefined, generation: string | undefined): void {
    this.transact((state) => {
      let changed = false;
      for (const [key, rec] of Object.entries(state.records)) {
        if (rec.kind !== kind) continue;
        const retired = destination === undefined || rec.destination !== destination;
        const stale = !retired && generation !== undefined && rec.generation !== generation && rec.status !== "delivered";
        if (retired || stale) {
          const controller = this.aborters.get(key);
          if (controller !== undefined) {
            controller.abort();
            this.aborters.delete(key);
          }
          delete state.records[key];
          changed = true;
        }
      }
      for (const key of Object.keys(state.breakers)) {
        if (key.startsWith(`${kind}|`) && (destination === undefined || key !== breakerKey(kind, destination))) {
          delete state.breakers[key];
          changed = true;
        }
      }
      return { value: undefined, changed };
    });
  }

  // ── sending ──────────────────────────────────────────────────────────────────────────────

  /** Read-only view of a day's per-destination state. Never sends. */
  status(input: { day: string; central: { url: string }; copy?: { url: string } | undefined }): SendReport {
    assertDestinations(input);
    const state = this.readState();
    const central = this.outcomeFor(state, input.day, "central", normalizeDestinationUrl(input.central.url), null);
    const copy = input.copy === undefined ? null : this.outcomeFor(state, input.day, "copy", normalizeDestinationUrl(input.copy.url), null);
    return { day: input.day, central, copy, partial: isPartial(central, copy) };
  }

  /**
   * Send one day to every configured destination. Independent per destination: an operator
   * endpoint that hangs, 500s or fails validation never suppresses central, and a central outage
   * never suppresses the copy.
   */
  async send(input: SendInput): Promise<SendReport> {
    return this.sendInternal(input, { fence: true });
  }

  /**
   * `fence: false` is used only by {@link drain}, which re-attempts EARLIER days under a
   * configuration the caller has already fenced for the current day. Re-fencing per drained day
   * would be wrong in both directions: a destination absent from one day's records would look
   * "retired" and purge every other day's state for that kind.
   */
  private async sendInternal(input: SendInput, opts: { fence: boolean; onlyExisting?: boolean }): Promise<SendReport> {
    assertDestinations(input);

    const centralDestination = normalizeDestinationUrl(input.central.url);
    const copyDestination = input.copy === undefined ? undefined : normalizeDestinationUrl(input.copy.url);
    if (copyDestination !== undefined && copyDestination === centralDestination) {
      throw new TransportConfigError(
        "copy_equals_central",
        "the copy destination must differ from central — the same endpoint would receive two identities for one install",
      );
    }

    if (!isSendPermitted(input.consent)) {
      // Opt-out is a hard fence, applied on the path that would otherwise have sent.
      this.fenceAll("consent not granted");
      return {
        day: input.day,
        central: skippedOutcome("central", centralDestination, "opted_out"),
        copy: copyDestination === undefined ? null : skippedOutcome("copy", copyDestination, "opted_out"),
        partial: false,
      };
    }

    const centralGeneration = destinationGeneration(input.consent, "central", centralDestination, input.central.identity.instance_secret);
    const copyGeneration =
      input.copy === undefined || copyDestination === undefined
        ? undefined
        : destinationGeneration(input.consent, "copy", copyDestination, input.copy.identity.instance_secret);
    if (opts.fence) {
      this.fenceDestination("central", centralDestination, centralGeneration);
      this.fenceDestination("copy", copyDestination, copyGeneration);
    }

    // One budget for the whole fan-out, on top of each attempt's own deadline.
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(), this.opts.overallBudgetMs);

    try {
      const semaphore = new Semaphore(this.opts.maxConcurrency);
      const tasks: Array<Promise<DestinationOutcome>> = [
        semaphore.run(() =>
          this.deliver({
            day: input.day,
            product: input.product,
            kind: "central",
            destination: centralDestination,
            generation: centralGeneration,
            input: input.central,
            budget: budget.signal,
            onlyExisting: opts.onlyExisting === true,
          }),
        ),
      ];
      const copyInput = input.copy;
      if (copyInput !== undefined && copyDestination !== undefined && copyGeneration !== undefined) {
        tasks.push(
          semaphore.run(() =>
            this.deliver({
              day: input.day,
              product: input.product,
              kind: "copy",
              destination: copyDestination,
              generation: copyGeneration,
              input: copyInput,
              budget: budget.signal,
              onlyExisting: opts.onlyExisting === true,
            }),
          ),
        );
      }

      // allSettled, never all: coupling the two is exactly the defect this design exists to avoid.
      const settled = await Promise.allSettled(tasks);
      const central = unwrap(settled[0], "central", centralDestination);
      const copy = settled.length > 1 ? unwrap(settled[1], "copy", copyDestination ?? "") : null;
      return { day: input.day, central, copy, partial: isPartial(central, copy) };
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  /**
   * Days that are still unresolved for a configured destination, oldest first.
   *
   * This exists because "durable delivery state" is a lie without a way to act on it: the emitter
   * reports the most recent COMPLETED day, so a day that failed and whose retry window crossed
   * midnight would never be revisited — the next tick sends the new day and the old record just
   * ages out of retention. Anything listed here still holds its payload and can be re-sent.
   */
  unresolvedDays(input: {
    central: { url: string };
    copy?: { url: string } | undefined;
    exceptDay?: string;
    /** Only days that could actually be attempted right now. Default true. */
    eligibleOnly?: boolean;
  }): string[] {
    const wanted = new Map<DestinationKind, string>([["central", normalizeDestinationUrl(input.central.url)]]);
    if (input.copy !== undefined) wanted.set("copy", normalizeDestinationUrl(input.copy.url));

    const state = this.readState();
    const now = this.opts.nowMs();
    const days = new Set<string>();
    for (const rec of Object.values(state.records)) {
      if (rec.status !== "pending") continue;
      if (rec.day === input.exceptDay) continue;
      if (wanted.get(rec.kind) !== rec.destination) continue;
      if (rec.body === undefined) continue; // nothing to re-send; a rebuild is impossible
      if (input.eligibleOnly !== false) {
        // A day still in backoff, or behind an open breaker, cannot be attempted — and if it were
        // counted anyway it would consume the drain cap on every tick, starving NEWER days that
        // ARE eligible until they aged out of retention unsent. That is the same silent loss the
        // drain exists to prevent, one level up.
        if (rec.next_attempt_at !== null && Date.parse(rec.next_attempt_at) > now) continue;
        const breaker = state.breakers[breakerKey(rec.kind, rec.destination)];
        if (breaker?.open_until != null && Date.parse(breaker.open_until) > now) continue;
      }
      days.add(rec.day);
    }
    return [...days].sort();
  }

  /**
   * Re-attempt every unresolved earlier day, oldest first. Uses each record's STORED payload — a
   * delta-normalising producer cannot rebuild an older day, and rebuilding would in any case
   * change the bytes behind an idempotency key the collector may already have seen.
   */
  async drain(input: {
    product: ProductName;
    consent: ConsentState;
    central: { url: string; identity: InstanceIdentity };
    copy?: { url: string; identity: InstanceIdentity } | undefined;
    exceptDay?: string;
    /** Cap on days drained per call, so a long outage does not turn one tick into a burst. */
    maxDays?: number;
  }): Promise<SendReport[]> {
    if (!isSendPermitted(input.consent)) {
      // A drain is a send. Consent that does not permit sending fences everything, exactly as it
      // would on the ordinary path — this must not depend on a caller having called send() first.
      this.fenceAll("consent not granted");
      return [];
    }

    // Drain FENCES FOR ITSELF rather than assuming a preceding send() did it. Without this, a
    // record left pending under identity A could be re-sent, after a rotation, with B's secret
    // authenticating A's stored body: the collector's derived-identity check rejects the mismatch,
    // the attempt is burned, and the day can be exhausted. The fence purges those records instead,
    // which is the correct outcome — a rotation is meant to orphan what came before it.
    const centralDestination = normalizeDestinationUrl(input.central.url);
    this.fenceDestination(
      "central",
      centralDestination,
      destinationGeneration(input.consent, "central", centralDestination, input.central.identity.instance_secret),
    );
    if (input.copy === undefined) {
      this.fenceDestination("copy", undefined, undefined);
    } else {
      const copyDestination = normalizeDestinationUrl(input.copy.url);
      this.fenceDestination(
        "copy",
        copyDestination,
        destinationGeneration(input.consent, "copy", copyDestination, input.copy.identity.instance_secret),
      );
    }

    const maxDays = input.maxDays ?? 3;
    const reports: SendReport[] = [];
    const visited = new Set<string>();
    let attempted = 0;

    // Eligibility is re-evaluated on EVERY pass, and only a day that actually produced an attempt
    // spends the cap. Selecting a fixed slice up front meant one day whose failure opened the
    // circuit breaker could make the next selections no-ops, so the cap was consumed by days that
    // never left the building while newer eligible days waited for a tick that never came.
    while (attempted < maxDays) {
      const day = this.unresolvedDays({ central: input.central, copy: input.copy, exceptDay: input.exceptDay }).find(
        (candidate) => !visited.has(candidate),
      );
      if (day === undefined) break;
      visited.add(day);

      const attemptsBefore = this.attemptsForDay(day, input.central.url, input.copy?.url);
      const central = this.record(day, "central", input.central.url);
      const copy = input.copy === undefined ? undefined : this.record(day, "copy", input.copy.url);
      // The stored body wins inside deliverOnce; these are only the record-creation fallback. A
      // destination with no stored body for this day is one that already reached a terminal state,
      // and an empty body is refused rather than posted (see deliverOnce).
      reports.push(
        await this.sendInternal(
          {
            day,
            product: input.product,
            consent: input.consent,
            central: { url: input.central.url, identity: input.central.identity, body: central?.body ?? "" },
            copy: input.copy === undefined ? undefined : { url: input.copy.url, identity: input.copy.identity, body: copy?.body ?? "" },
          },
          // Fenced once above, not once per day; and `onlyExisting` so draining one destination's
          // backlog cannot mint a record for a destination that never had one for that day.
          { fence: false, onlyExisting: true },
        ),
      );
      // A day skipped by a breaker that opened mid-loop made no request, so it must not count.
      if (this.attemptsForDay(day, input.central.url, input.copy?.url) > attemptsBefore) attempted += 1;
    }
    return reports;
  }

  /** Total attempts recorded for a day across its configured destinations. */
  private attemptsForDay(day: string, centralUrl: string, copyUrl: string | undefined): number {
    const state = this.readState();
    const central = state.records[recordKey(day, "central", normalizeDestinationUrl(centralUrl))]?.attempts ?? 0;
    const copy = copyUrl === undefined ? 0 : (state.records[recordKey(day, "copy", normalizeDestinationUrl(copyUrl))]?.attempts ?? 0);
    return central + copy;
  }

  private outcomeFor(
    state: DeliveryStateFile,
    day: string,
    kind: DestinationKind,
    destination: string,
    skipped: DestinationOutcome["skipped_because"],
  ): DestinationOutcome {
    const rec = state.records[recordKey(day, kind, destination)];
    if (rec === undefined) {
      return {
        kind,
        destination,
        status: "pending",
        attempts: 0,
        next_attempt_at: null,
        last_error: null,
        last_http_status: null,
        skipped_because: skipped,
      };
    }
    return {
      kind,
      destination,
      status: rec.status,
      attempts: rec.attempts,
      next_attempt_at: rec.next_attempt_at,
      last_error: rec.last_error,
      last_http_status: rec.last_http_status,
      skipped_because: skipped,
    };
  }

  private async deliver(args: {
    day: string;
    product: ProductName;
    kind: DestinationKind;
    destination: string;
    generation: string;
    input: DestinationInput;
    budget: AbortSignal;
    onlyExisting: boolean;
  }): Promise<DestinationOutcome> {
    const key = recordKey(args.day, args.kind, args.destination);

    // Single-flight: a concurrent tick joins the attempt already running rather than opening a
    // second socket to the same destination for the same day.
    const running = this.inflight.get(key);
    if (running !== undefined) {
      const outcome = await running;
      return { ...outcome, skipped_because: "in_flight" };
    }

    const task = this.deliverOnce(args, key).finally(() => {
      this.inflight.delete(key);
      this.aborters.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  private async deliverOnce(
    args: {
      day: string;
      product: ProductName;
      kind: DestinationKind;
      destination: string;
      generation: string;
      input: DestinationInput;
      budget: AbortSignal;
      onlyExisting: boolean;
    },
    key: string,
  ): Promise<DestinationOutcome> {
    const now = this.opts.nowMs();
    const nowIso = new Date(now).toISOString();
    const bKey = breakerKey(args.kind, args.destination);

    // ── phase one: claim the attempt, in ONE read-modify-write against the live document ──
    //
    // Everything that decides whether to send, and the attempt bookkeeping that must be durable
    // before the request leaves, happens here with no `await` in between. What crosses into the
    // request below is a value, not a live handle into a remembered document.
    type Claim =
      | { send: false; outcome: DestinationOutcome }
      // `generation` is the record's own, not `args.generation`: a drain re-sends a record created
      // under an earlier one, and phase two has to recognise the record it actually claimed.
      | { send: true; body: string; idempotencyKey: string; generation: string };

    const claim = this.transact<Claim>((state) => {
      const stop = (why: DestinationOutcome["skipped_because"], changed = false): { value: Claim; changed: boolean } => ({
        value: { send: false, outcome: this.outcomeFor(state, args.day, args.kind, args.destination, why) },
        changed,
      });

      let rec = state.records[key];
      // A drain re-sends what already exists; it must never CREATE a delivery. Otherwise draining
      // one destination's backlog would mint a body-less record for a destination that simply had
      // nothing for that day, and that record would immediately retire itself as unsendable.
      if (rec === undefined && args.onlyExisting) return stop(null);
      if (rec === undefined) {
        rec = {
          day: args.day,
          kind: args.kind,
          destination: args.destination,
          generation: args.generation,
          idempotency_key: sha256Hex(`${args.input.identity.instance_id}|${args.product}|${args.day}|${args.generation}`),
          attempts: 0,
          first_attempt_at: null,
          last_attempt_at: null,
          next_attempt_at: null,
          status: "pending",
          last_error: null,
          last_http_status: null,
        };
        state.records[key] = rec;
      }

      if (rec.status === "delivered") return stop(null);
      if (rec.status === "exhausted") return stop(null);

      if (rec.next_attempt_at !== null && Date.parse(rec.next_attempt_at) > now) return stop("backoff");

      const breaker = state.breakers[bKey];
      if (breaker?.open_until != null && Date.parse(breaker.open_until) > now) return stop("circuit_open");

      if (args.budget.aborted) return stop("budget_exhausted");

      // An empty body means the payload was never stored or has already been released. Posting
      // empty bytes would be a guaranteed rejection that still burns an attempt and looks like an
      // outage.
      if ((rec.body ?? args.input.body) === "") {
        rec.status = "exhausted";
        rec.next_attempt_at = null;
        rec.last_error = "payload not retained — this day can no longer be re-sent";
        return stop(null, true);
      }

      // Record the attempt BEFORE the request, and persist it. A crash mid-request must not look
      // like an attempt that never happened, or a restart loop retries without bound.
      rec.attempts += 1;
      rec.last_attempt_at = nowIso;
      if (rec.first_attempt_at === null) rec.first_attempt_at = nowIso;
      rec.next_attempt_at = new Date(now + this.backoffFor(rec.attempts)).toISOString();
      // Re-send the bytes the record was created with. The idempotency key is derived from the same
      // (identity, product, day, generation) tuple, so a retry must carry the same document, or a
      // deduping collector would silently keep the first version of a day it later re-received.
      if (rec.body === undefined) rec.body = args.input.body;
      return {
        value: { send: true, body: rec.body, idempotencyKey: rec.idempotency_key, generation: rec.generation },
        changed: true,
      };
    });

    if (!claim.send) return claim.outcome;

    // The aborter is registered BEFORE resolution, not after it. Registering it only around the
    // POST left a window in which a fence (opt-out, endpoint change) or the overall budget had
    // nothing to cancel while DNS was pending — the lookup would later succeed and the request
    // would go out, WITH ITS WRITE SECRET, after the user had already said no.
    const attemptAborter = new AbortController();
    this.aborters.set(key, attemptAborter);
    const onBudget = (): void => attemptAborter.abort();
    args.budget.addEventListener("abort", onBudget, { once: true });

    try {
      const endpoint = await this.opts.resolveImpl(ingestUrlFor(args.destination), {
        ...this.opts.policy,
        signal: attemptAborter.signal,
      });
      // Resolution can take time; a fence during it must still stop the send.
      if (attemptAborter.signal.aborted) throw new EndpointRejected("aborted", "attempt aborted during resolution");
      const result = await this.opts.postImpl({
        endpoint,
        body: claim.body,
        headers: {
          "content-type": "application/json",
          // Write auth rides the header, never the payload.
          "X-Mythical-Write-Key": args.input.identity.instance_secret,
          // Lets an operator collector dedupe a retry it already accepted.
          "Idempotency-Key": claim.idempotencyKey,
        },
        timeoutMs: this.opts.perAttemptTimeoutMs,
        signal: attemptAborter.signal,
      });

      // ── phase two: fold the outcome into whatever the document says NOW ──
      if (result.ok) {
        return this.transact((state) => {
          const rec = state.records[key];
          // Fenced while the request was in flight — an opt-out, or a configuration change. The
          // record is gone on purpose and must not be resurrected by its own late reply, and the
          // breaker the same fence cleared must not be re-seeded either.
          //
          // A DIFFERENT GENERATION AT THE SAME KEY IS NOT OUR RECORD EITHER, and matching on the key
          // alone would be worse than doing nothing: the fence purged our delivery and a NEW one was
          // started for the same day and destination under a new credential or endpoint, so marking
          // it delivered on the strength of our reply would drop the payload it is still holding and
          // the send that was actually authorised would never happen.
          if (rec === undefined || rec.generation !== claim.generation) {
            return { value: this.outcomeFor(state, args.day, args.kind, args.destination, null), changed: false };
          }
          rec.status = "delivered";
          rec.next_attempt_at = null;
          rec.last_error = null;
          rec.last_http_status = result.status;
          delete rec.body; // terminal — the retained payload has no further purpose
          state.breakers[bKey] = { consecutive_failures: 0, open_until: null };
          return { value: this.outcomeFor(state, args.day, args.kind, args.destination, null), changed: true };
        });
      }

      // The status and nothing else. The response BODY is never read into local state: the
      // endpoint is attacker-controlled and already holds the write key, so any excerpt of what it
      // says is bytes of its choosing landing in a file and on a status surface. See ssrf.ts.
      return this.recordFailure(args, key, bKey, claim.generation, `HTTP ${result.status}`, result.status);
    } catch (err) {
      // ONLY the closed reason is persisted — never the exception message. A message can carry
      // text that originated at the endpoint (a TLS error naming the certificate it presented, a
      // parser quoting what it received), and that is exactly the attacker-chosen-bytes-at-rest
      // problem the response-body removal exists to close. An unrecognised failure collapses to a
      // single fixed value rather than leaking its own description.
      return this.recordFailure(args, key, bKey, claim.generation, transportReason(err), null);
    } finally {
      args.budget.removeEventListener("abort", onBudget);
      this.aborters.delete(key);
    }
  }

  private recordFailure(
    args: { day: string; kind: DestinationKind; destination: string },
    key: string,
    bKey: string,
    generation: string,
    error: string,
    httpStatus: number | null,
  ): DestinationOutcome {
    return this.transact((state) => {
      const rec = state.records[key];
      // Fenced mid-flight, or replaced by a delivery under a different generation: same reasoning
      // as the success path — a purged delivery stays purged, and a failure that belongs to a
      // configuration nobody is using any more does not get to burn a live delivery's attempts or
      // open a circuit breaker against it.
      //
      // DELIVERED IS TERMINAL AND IS A FACT. If another writer's attempt for this same day and
      // destination succeeded while ours was in flight, the day IS delivered, and writing our
      // failure onto it would report an error against a delivery that happened and — worse — count
      // toward a circuit breaker against a destination that just accepted one, suppressing later
      // days over an outage that is not happening.
      if (rec === undefined || rec.generation !== generation || rec.status === "delivered") {
        return { value: this.outcomeFor(state, args.day, args.kind, args.destination, null), changed: false };
      }
      rec.last_error = error;
      rec.last_http_status = httpStatus;
      if (rec.attempts >= this.opts.maxAttempts) {
        rec.status = "exhausted";
        rec.next_attempt_at = null;
        delete rec.body; // terminal — do not retain a payload that will never be sent
      }
      const breaker = state.breakers[bKey] ?? { consecutive_failures: 0, open_until: null };
      breaker.consecutive_failures += 1;
      if (breaker.consecutive_failures >= this.opts.breakerThreshold) {
        breaker.open_until = new Date(this.opts.nowMs() + this.opts.breakerCooldownMs).toISOString();
        breaker.consecutive_failures = 0;
      }
      state.breakers[bKey] = breaker;
      return { value: this.outcomeFor(state, args.day, args.kind, args.destination, null), changed: true };
    });
  }

  /**
   * Exponential backoff with jitter. The jitter is the point: without it every install in a fleet
   * retries at the same instant after an outage and the collector is hit by the whole population
   * at once. Half the window is fixed so the spacing never collapses to zero.
   */
  private backoffFor(attempts: number): number {
    const capped = Math.min(this.opts.baseBackoffMs * 2 ** Math.max(0, attempts - 1), this.opts.maxBackoffMs);
    return Math.round(capped * (0.5 + 0.5 * this.opts.random()));
  }
}

/**
 * The CLOSED set of transport failure reasons this package will persist. Anything not on it —
 * including any exception message — collapses to `transport_error`.
 */
export const TRANSPORT_REASONS = [
  "invalid_url",
  "scheme_not_allowed",
  "credentials_in_url",
  "https_required",
  "host_not_routable",
  "address_blocked",
  "dns_empty",
  "dns_failed",
  "dns_timeout",
  "redirect_not_followed",
  "timeout",
  "aborted",
  "request_failed",
  "response_error",
  "transport_error",
] as const;

const TRANSPORT_REASON_SET: ReadonlySet<string> = new Set<string>(TRANSPORT_REASONS);

function transportReason(err: unknown): string {
  if (err instanceof EndpointRejected && TRANSPORT_REASON_SET.has(err.reason)) return err.reason;
  return "transport_error";
}

function parseRecord(value: unknown): DeliveryRecord | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const d = value as Record<string, unknown>;
  if (typeof d.day !== "string" || typeof d.destination !== "string") return undefined;
  if (d.kind !== "central" && d.kind !== "copy") return undefined;
  const status = d.status === "delivered" || d.status === "exhausted" ? d.status : "pending";
  return {
    day: d.day,
    kind: d.kind,
    destination: d.destination,
    generation: typeof d.generation === "string" ? d.generation : "",
    idempotency_key: typeof d.idempotency_key === "string" ? d.idempotency_key : "",
    attempts: typeof d.attempts === "number" && Number.isFinite(d.attempts) ? Math.max(0, Math.floor(d.attempts)) : 0,
    first_attempt_at: typeof d.first_attempt_at === "string" ? d.first_attempt_at : null,
    last_attempt_at: typeof d.last_attempt_at === "string" ? d.last_attempt_at : null,
    next_attempt_at: typeof d.next_attempt_at === "string" ? d.next_attempt_at : null,
    status,
    last_error: typeof d.last_error === "string" ? d.last_error : null,
    last_http_status: typeof d.last_http_status === "number" ? d.last_http_status : null,
    ...(typeof d.body === "string" ? { body: d.body } : {}),
  };
}

function skippedOutcome(kind: DestinationKind, destination: string, why: DestinationOutcome["skipped_because"]): DestinationOutcome {
  return {
    kind,
    destination,
    status: "pending",
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    last_http_status: null,
    skipped_because: why,
  };
}

function unwrap(settled: PromiseSettledResult<DestinationOutcome> | undefined, kind: DestinationKind, destination: string): DestinationOutcome {
  if (settled === undefined) return skippedOutcome(kind, destination, null);
  if (settled.status === "fulfilled") return settled.value;
  return {
    kind,
    destination,
    status: "pending",
    attempts: 0,
    next_attempt_at: null,
    last_error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
    last_http_status: null,
    skipped_because: null,
  };
}

function isPartial(central: DestinationOutcome, copy: DestinationOutcome | null): boolean {
  if (copy === null) return false;
  return (central.status === "delivered") !== (copy.status === "delivered");
}

/** A one-line human summary — the surface that must never say "sent" when only one destination was. */
export function describeSendReport(report: SendReport): string {
  const one = (o: DestinationOutcome): string => {
    const suffix = o.skipped_because !== null ? ` (${o.skipped_because})` : o.last_error !== null ? ` (${o.last_error})` : "";
    return `${o.kind} ${o.status}${suffix}`;
  };
  return report.copy === null ? `${report.day}: ${one(report.central)}` : `${report.day}: ${one(report.central)}, ${one(report.copy)}`;
}

/** Bounded concurrency. Two destinations today; the bound exists so a wider fan-out stays bounded. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next !== undefined) next();
    }
  }
}
