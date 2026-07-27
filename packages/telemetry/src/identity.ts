// Derived instance identity — the scheme is PRESERVED from the agent-session product, not
// redesigned. Everything in this file is load-bearing on that preservation.
//
// `instance_secret` — 32 random bytes, hex (64 chars). NEVER serialized on any HTTP route.
// `instance_id`     — uuidv4Format(sha256(instance_secret)[0..16]). Uniformly random to any
//                     observer, but only the secret-holder can authenticate as it: the collector
//                     recomputes derive(header_secret) and constant-time compares it to the
//                     payload's claimed id. Stateless — no registration, no stored key material,
//                     no first-writer race, and NO shared or baked write key. Do not introduce one.
//
// ⚠ THE DERIVATION HASHES THE UTF-8 BYTES OF THE 64-CHAR HEX STRING, NOT THE DECODED 32 BYTES.
// That is not an accident and not an improvement waiting to happen. Every installed product
// already holds a secret whose id was derived this way; changing it silently mints a new id for
// every install, orphaning its history AND its delete capability — the id is how a user asks for
// their data back. The pinned vectors in identity.test.ts exist to make that failure loud.
//
// The on-disk layout and path are preserved for the same reason: `<state>/telemetry/instance.json`
// holding `{instance_secret, instance_id, created_at, rotated_at}`. An existing install must keep
// reading its own file after moving to this package.
//
// DESTINATION-SCOPED COPY IDENTITIES. When an operator configures a copy destination, that
// destination gets its OWN secret and its OWN derived id. The central secret is NEVER sent to a
// copy: a copy destination holding it could authenticate as this install at central and issue an
// authenticated DELETE. The copy identity is bound to the destination and retired with it —
// changing the copy URL rotates that entry, and a secret is never carried to a new destination
// (otherwise an install that moves from collector A to collector B hands both operators the same
// credential, letting either impersonate or delete that identity at the other).

import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { atomicWriteFileSync, readJsonSync } from "./atomic.ts";

/** 64 lowercase hex characters. */
export const INSTANCE_SECRET_PATTERN = /^[0-9a-f]{64}$/;
/** Lowercase UUIDv4 form — the exact grammar the schema pins. */
export const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface InstanceIdentity {
  /** 32 random bytes, hex (64 chars). NEVER serialized on any HTTP route. */
  instance_secret: string;
  /** uuidv4Format(sha256(secret)[0..16]) — the shareable read capability. */
  instance_id: string;
  created_at: string;
  /** Bumped on every rotation. `created_at` is preserved across rotations as the install anchor. */
  rotated_at: string;
}

/**
 * Derive the instance id from the secret: the first 16 bytes of sha256(secret-utf8), with the
 * UUID v4 version nibble (byte 6 high nibble = 4) and variant bits (byte 8 top bits = 10)
 * stamped, formatted 8-4-4-4-12. Deterministic — the collector re-derives it statelessly.
 *
 * The `"utf8"` argument is the whole compatibility contract. See the file header.
 */
export function deriveInstanceId(secret: string): string {
  const digest = createHash("sha256").update(secret, "utf8").digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Mint a fresh 32-byte secret, hex-encoded. */
export function mintInstanceSecret(): string {
  return randomBytes(32).toString("hex");
}

/** `<state>/telemetry/` — the directory both identity files live in. */
export function telemetryDirPath(stateRoot: string): string {
  return path.join(stateRoot, "telemetry");
}

/** `<state>/telemetry/instance.json` — the preserved central-identity path. */
export function instanceFilePath(stateRoot: string): string {
  return path.join(telemetryDirPath(stateRoot), "instance.json");
}

/** `<state>/telemetry/copy-identities.json` — destination-scoped copy secrets. Never central's. */
export function copyIdentityFilePath(stateRoot: string): string {
  return path.join(telemetryDirPath(stateRoot), "copy-identities.json");
}

/**
 * Normalise a destination URL into the key a copy identity is bound to.
 *
 * Two spellings of the same endpoint must key the same entry, or a trailing slash silently
 * rotates the operator's identity; two DIFFERENT endpoints must never collide, or a secret is
 * carried across a destination boundary. Scheme and host fold to lowercase, a default port is
 * dropped, a trailing slash is stripped, and the fragment is discarded (it never reaches the
 * wire). Userinfo is REJECTED, not normalised away: credentials in a telemetry endpoint are a
 * configuration error, and silently dropping them would send unauthenticated instead.
 */
export function normalizeDestinationUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("destination url is not a valid absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`destination url scheme ${url.protocol} is not http(s)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("destination url must not carry credentials — telemetry auth rides a header");
  }
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const defaultPort = scheme === "https:" ? "443" : "80";
  const port = url.port === "" || url.port === defaultPort ? "" : `:${url.port}`;
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `${scheme}//${bracketed}${port}${pathname}${url.search}`;
}

interface CopyIdentityFile {
  /** The destination the current copy identity belongs to (normalised). */
  current_destination: string;
  /** Exactly one entry: the current destination's. A retired destination's secret is destroyed. */
  destinations: Record<string, InstanceIdentity>;
}

function parseIdentity(raw: unknown, nowIso: () => string): InstanceIdentity | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const doc = raw as Record<string, unknown>;
  const secret = doc.instance_secret;
  if (typeof secret !== "string" || !INSTANCE_SECRET_PATTERN.test(secret)) return undefined;
  const created = typeof doc.created_at === "string" ? doc.created_at : nowIso();
  const rotated = typeof doc.rotated_at === "string" ? doc.rotated_at : created;
  // The id is ALWAYS re-derived from the secret (self-healing; the derivation is the truth).
  return { instance_secret: secret, instance_id: deriveInstanceId(secret), created_at: created, rotated_at: rotated };
}

export interface IdentityStoreOptions {
  /** The product's state root. Files land under `<stateRoot>/telemetry/`. */
  stateRoot: string;
  nowMs?: () => number;
  /** Warning sink. A persist failure is reported here, never thrown at the caller. */
  log?: (line: string) => void;
}

/**
 * Load-or-mint identity storage. Never throws on a persist failure: telemetry must not be able to
 * break the product it reports on, so a failed write degrades to a process-stable in-memory
 * identity and is retried on the next call.
 */
export class IdentityStore {
  private central: InstanceIdentity | undefined;
  private centralPersisted = false;
  private readonly nowMs: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: IdentityStoreOptions) {
    this.nowMs = opts.nowMs ?? Date.now;
    this.log = opts.log ?? ((): void => {});
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /** The central identity — loaded from `<state>/telemetry/instance.json`, minted if absent. */
  centralIdentity(): InstanceIdentity {
    if (this.central !== undefined) {
      if (!this.centralPersisted) this.persistCentral(this.central);
      return this.central;
    }
    const loaded = parseIdentity(readJsonSync(instanceFilePath(this.opts.stateRoot)), () => this.nowIso());
    if (loaded !== undefined) {
      this.central = loaded;
      this.centralPersisted = true;
      return loaded;
    }
    const now = this.nowIso();
    const secret = mintInstanceSecret();
    const minted: InstanceIdentity = {
      instance_secret: secret,
      instance_id: deriveInstanceId(secret),
      created_at: now,
      rotated_at: now,
    };
    this.central = minted;
    this.persistCentral(minted);
    return minted;
  }

  /**
   * Rotate the central identity. `created_at` is preserved (the install anchor); `rotated_at` is
   * bumped. The old secret is gone afterwards, so any remote purge that uses it must happen
   * BEFORE this call — the caller owns that ordering.
   */
  rotateCentral(): InstanceIdentity {
    const old = this.centralIdentity();
    const secret = mintInstanceSecret();
    const next: InstanceIdentity = {
      instance_secret: secret,
      instance_id: deriveInstanceId(secret),
      created_at: old.created_at,
      rotated_at: this.nowIso(),
    };
    this.central = next;
    this.centralPersisted = false;
    this.persistCentral(next);
    return next;
  }

  private persistCentral(identity: InstanceIdentity): void {
    try {
      atomicWriteFileSync(instanceFilePath(this.opts.stateRoot), JSON.stringify(identity, null, 2));
      this.centralPersisted = true;
    } catch (err) {
      this.log(`identity persist failed (in-memory identity retained): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── destination-scoped copy identities ──────────────────────────────────────────────────

  private readCopyFile(): CopyIdentityFile {
    const raw = readJsonSync(copyIdentityFilePath(this.opts.stateRoot));
    const empty: CopyIdentityFile = { current_destination: "", destinations: {} };
    if (raw === null || typeof raw !== "object") return empty;
    const doc = raw as Record<string, unknown>;
    const current = typeof doc.current_destination === "string" ? doc.current_destination : "";
    const destinations: Record<string, InstanceIdentity> = {};
    const rawDests = doc.destinations;
    if (rawDests !== null && typeof rawDests === "object") {
      for (const [key, value] of Object.entries(rawDests as Record<string, unknown>)) {
        const identity = parseIdentity(value, () => this.nowIso());
        if (identity !== undefined) destinations[key] = identity;
      }
    }
    return { current_destination: current, destinations };
  }

  private writeCopyFile(file: CopyIdentityFile): void {
    try {
      atomicWriteFileSync(copyIdentityFilePath(this.opts.stateRoot), JSON.stringify(file, null, 2));
    } catch (err) {
      this.log(`copy identity persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The copy identity for `destinationUrl` — its OWN secret and its OWN derived id.
   *
   * Pointing at a different destination ROTATES: the previous entry is destroyed rather than
   * re-keyed, so no operator ever receives a secret that was minted for another endpoint. The
   * central secret is never read here, and the returned identity is never the central one.
   */
  copyIdentityFor(destinationUrl: string): InstanceIdentity {
    const key = normalizeDestinationUrl(destinationUrl);
    const file = this.readCopyFile();
    const existing = file.destinations[key];
    if (file.current_destination === key && existing !== undefined) return existing;

    const now = this.nowIso();
    const secret = mintInstanceSecret();
    const minted: InstanceIdentity = {
      instance_secret: secret,
      instance_id: deriveInstanceId(secret),
      created_at: now,
      rotated_at: now,
    };
    // Replace, never merge: every retired destination's secret is dropped with it.
    this.writeCopyFile({ current_destination: key, destinations: { [key]: minted } });
    return minted;
  }

  /** The destination the stored copy identity belongs to, if any. */
  currentCopyDestination(): string | undefined {
    const file = this.readCopyFile();
    return file.current_destination === "" ? undefined : file.current_destination;
  }

  /** Retire the copy identity entirely — the operator endpoint was removed. */
  clearCopyIdentity(): void {
    this.writeCopyFile({ current_destination: "", destinations: {} });
  }
}
