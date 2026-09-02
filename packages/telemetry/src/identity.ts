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
import { atomicWriteFileSync, claimByReplacingSync, createFileExclusiveSync, readJsonSync } from "./atomic.ts";

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
 * How many read → claim rounds a get-or-create takes before it concludes that the file on disk is
 * not a lost race but an unreadable document. One round is enough to resolve a genuine race (the
 * claim fails, the re-read finds the winner); the extra rounds exist so a burst of contending
 * first-boots cannot be mistaken for corruption.
 */
const CLAIM_ROUNDS = 3;

/**
 * Load-or-mint identity storage. Never throws on a persist failure: telemetry must not be able to
 * break the product it reports on, so a failed write degrades to a process-stable in-memory
 * identity and is retried on the next call.
 *
 * ⚠ THE GET-OR-CREATE MUST RESOLVE BEFORE THE IDENTITY IS HANDED TO ANYONE. Reading, minting when
 * absent, and then writing is a TOCTOU: two processes on one state directory each mint a DIFFERENT
 * secret, each return their own to their own caller, and only one write survives. The loser may
 * already have emitted under an id that is about to stop existing on disk — and per the note at the
 * top of `atomic.ts`, an id that no longer exists locally is data the installation can neither read
 * nor delete, because the id is the capability a user exercises to ask for their data back. A
 * better WRITE primitive does not repair that; only completing the claim before returning does. So
 * every mint below goes through `createFileExclusiveSync`, and a caller that loses the race ADOPTS
 * the winner's identity rather than returning its own.
 */
export class IdentityStore {
  private central: InstanceIdentity | undefined;
  private centralPersisted = false;
  /**
   * How an identity that is held but not written should be retried. A first mint CLAIMS, because
   * anything that appeared at that name meanwhile is a real identity someone may be using; a
   * rotation REPLACES, because superseding the stored identity is the entire point of it.
   */
  private centralRetry: "claim" | "replace" = "claim";
  private readonly nowMs: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: IdentityStoreOptions) {
    this.nowMs = opts.nowMs ?? Date.now;
    this.log = opts.log ?? ((): void => {});
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private mint(): InstanceIdentity {
    const now = this.nowIso();
    const secret = mintInstanceSecret();
    return { instance_secret: secret, instance_id: deriveInstanceId(secret), created_at: now, rotated_at: now };
  }

  /** The central identity — loaded from `<state>/telemetry/instance.json`, minted if absent. */
  centralIdentity(): InstanceIdentity {
    if (this.central !== undefined) {
      // A previous call minted this but could not write it (a full disk, a read-only mount, an I/O
      // error). Retry — but see `retryPersistCentral`: an unwritten identity has no claim on the
      // name, and blindly renaming over whatever is there now destroys a REAL one.
      if (!this.centralPersisted) {
        const settled = this.centralRetry === "replace" ? this.replacePending(this.central) : this.retryPersistCentral(this.central);
        this.central = settled.identity;
        this.centralPersisted = settled.persisted;
      }
      return this.central;
    }
    const resolved = this.resolveCentral();
    this.central = resolved.identity;
    this.centralPersisted = resolved.persisted;
    this.centralRetry = "claim";
    return resolved.identity;
  }

  private replacePending(identity: InstanceIdentity): { identity: InstanceIdentity; persisted: boolean } {
    return { identity, persisted: this.writeCentral(identity) };
  }

  /**
   * Retry the write of an identity this process minted but never landed.
   *
   * NOT A PLAIN RE-WRITE, and the difference is the whole point. Between the failed write and this
   * retry, another process can have found the file absent or unreadable and legitimately persisted
   * an identity of its own — and it is emitting under one that is genuinely on disk, while ours is
   * on disk nowhere. Renaming ours over it would orphan the durable identity in favour of the
   * ephemeral one: the same loss this change exists to prevent, arriving through the back door.
   *
   * So the retry claims, in the same read → claim rounds as a first resolve. If the name is taken
   * by something READABLE we adopt it and say so. That does mean this process changes identity
   * mid-run and anything already sent under the unwritten id is orphaned — which is the lesser harm
   * and was already the outcome of the next restart, since an identity that never reached disk was
   * never going to survive one.
   *
   * A lost claim followed by a read that finds nothing does NOT mean "unreadable, replace it": the
   * name may simply have VANISHED between the two, and replacing on that basis would rename over
   * whoever claimed it next. It rounds again instead, and the next claim settles which it was. Only
   * a name that is never claimable and never readable is the corrupt case the self-heal exists for.
   */
  private retryPersistCentral(pending: InstanceIdentity): { identity: InstanceIdentity; persisted: boolean } {
    const file = instanceFilePath(this.opts.stateRoot);
    for (let round = 0; round < CLAIM_ROUNDS; round++) {
      try {
        if (createFileExclusiveSync(file, JSON.stringify(pending, null, 2), { log: this.log })) {
          return { identity: pending, persisted: true };
        }
      } catch (err) {
        this.log(`identity persist retry failed (in-memory identity retained): ${err instanceof Error ? err.message : String(err)}`);
        return { identity: pending, persisted: false };
      }
      const landed = parseIdentity(readJsonSync(file), () => this.nowIso());
      if (landed !== undefined) {
        this.log("a central identity is stored while ours was never written — adopting it; anything sent under the unwritten id is orphaned");
        return { identity: landed, persisted: true };
      }
    }
    return this.selfHeal(pending, "the identity this process is already using");
  }

  /**
   * The name is occupied by something that never parses across every round, which is corruption
   * rather than contention — nothing will ever release it, so it has to be replaced or this install
   * never gets a durable identity at all.
   *
   * The replace is inode-tied (see `claimByReplacingSync`): if a real document turned up while we
   * were deciding, it is left alone and adopted instead. Blindly renaming over the name here was
   * the last place a live identity could be destroyed by a process that had only ever read garbage.
   */
  private selfHeal(pending: InstanceIdentity, describe: string): { identity: InstanceIdentity; persisted: boolean } {
    const file = instanceFilePath(this.opts.stateRoot);
    this.log(`central identity file exists but is unreadable — replacing it with ${describe}`);
    let replaced: boolean;
    try {
      replaced = claimByReplacingSync(
        file,
        JSON.stringify(pending, null, 2),
        // Anything that parses as an identity is real and stays; only garbage is replaced.
        (parsed) => parseIdentity(parsed, () => this.nowIso()) !== undefined,
        { log: this.log },
      );
    } catch (err) {
      this.log(`identity self-heal failed (in-memory identity retained): ${err instanceof Error ? err.message : String(err)}`);
      return { identity: pending, persisted: false };
    }
    if (replaced) return { identity: pending, persisted: true };

    // Not replaced means something readable is there after all — ours to adopt, not to overwrite.
    const landed = parseIdentity(readJsonSync(file), () => this.nowIso());
    if (landed !== undefined) {
      this.log("a central identity appeared while the unreadable one was being replaced — adopting it rather than overwriting it");
      return { identity: landed, persisted: true };
    }
    // Occupied, unreadable, and not replaced: nothing durable to return, so say so and retry later.
    this.log("central identity could not be established this call — retrying on the next one");
    return { identity: pending, persisted: false };
  }

  /**
   * Read the file, or claim it — repeating until one of the two settles. A `false` from the claim
   * means the name was taken between our read and our link, so the next round reads the winner and
   * adopts it.
   *
   * Contention therefore always ends with the identity that is on disk. The two ways out that do
   * NOT are both reported: a claim that could not be attempted at all (returned with
   * `persisted: false`, so the caller keeps a process-stable identity and the write is retried),
   * and a file that never parses (replaced, loudly). Neither is a race.
   */
  private resolveCentral(): { identity: InstanceIdentity; persisted: boolean } {
    const file = instanceFilePath(this.opts.stateRoot);
    for (let round = 0; round < CLAIM_ROUNDS; round++) {
      const loaded = parseIdentity(readJsonSync(file), () => this.nowIso());
      if (loaded !== undefined) return { identity: loaded, persisted: true };

      const minted = this.mint();
      try {
        if (createFileExclusiveSync(file, JSON.stringify(minted, null, 2), { log: this.log })) {
          return { identity: minted, persisted: true };
        }
      } catch (err) {
        // The claim could not even be attempted. Degrade to a process-stable in-memory identity —
        // telemetry never takes its host down — and retry the write on the next call.
        this.log(`identity claim failed (in-memory identity retained): ${err instanceof Error ? err.message : String(err)}`);
        return { identity: minted, persisted: false };
      }
      // Lost the claim: something IS at that name. Loop round to read it.
    }

    // Every round found a file that exists and does not parse. That is not contention, it is a
    // corrupt or truncated document, and no claim can ever win against it — so the pre-existing
    // self-heal applies and it is replaced.
    return this.selfHeal(this.mint(), "a fresh mint");
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
    // A rotation supersedes what is stored, so if this write fails the retry must replace too —
    // claiming would find the OLD identity at the name and adopt it, silently undoing the rotation.
    this.centralRetry = "replace";
    this.centralPersisted = this.writeCentral(next);
    return next;
  }

  /**
   * The REPLACING write. Correct only where replacement is the intent — a rotation, or the
   * self-heal of a document that cannot be read — and never for a first mint, which claims.
   */
  private writeCentral(identity: InstanceIdentity): boolean {
    try {
      atomicWriteFileSync(instanceFilePath(this.opts.stateRoot), JSON.stringify(identity, null, 2));
      return true;
    } catch (err) {
      this.log(`identity persist failed (in-memory identity retained): ${err instanceof Error ? err.message : String(err)}`);
      return false;
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
    const stored = this.readCopyFile();
    const existing = stored.destinations[key];
    if (stored.current_destination === key && existing !== undefined) return existing;

    const minted = this.mint();
    // Replace, never merge: every retired destination's secret is dropped with it.
    const doc: CopyIdentityFile = { current_destination: key, destinations: { [key]: minted } };
    const json = JSON.stringify(doc, null, 2);
    const filePath = copyIdentityFilePath(this.opts.stateRoot);

    // FIRST MINT IS A CLAIM, for the same reason central's is: two processes reaching a fresh
    // state directory together would otherwise mint two secrets for one destination and destroy
    // one of them, leaving an operator's collector holding data under an id this install can no
    // longer authenticate as — so it can never be deleted.
    try {
      if (createFileExclusiveSync(filePath, json, { log: this.log })) return minted;
    } catch (err) {
      this.log(`copy identity claim failed (in-memory identity retained): ${err instanceof Error ? err.message : String(err)}`);
      return minted;
    }

    // The name was taken. If the winner is for OUR destination, adopt it — a second secret for one
    // endpoint is exactly what must not happen.
    const winner = this.readCopyFile();
    const adopted = winner.destinations[key];
    if (winner.current_destination === key && adopted !== undefined) return adopted;

    // What is there is either another destination's entry — a ROTATION, and replacing it is the
    // whole point, since the retired destination's secret is meant to be destroyed — or something
    // that cannot be read. The two are NOT the same and must not share a blind write: a corrupt
    // file is a name this process merely failed to READ, and renaming over it can destroy an
    // identity another process legitimately put there in the meantime. So the replace is inode-tied
    // and keeps anything already holding OUR destination, which also means two processes minting
    // for the same new destination at the same moment converge instead of each keeping a secret.
    let replaced: boolean;
    try {
      replaced = claimByReplacingSync(filePath, json, (parsed) => this.storedCopyIdentity(parsed, key) !== undefined, { log: this.log });
    } catch (err) {
      this.log(`copy identity persist failed: ${err instanceof Error ? err.message : String(err)}`);
      return minted;
    }
    if (replaced) return minted;

    const landed = this.readCopyFile();
    const persisted = landed.destinations[key];
    if (landed.current_destination === key && persisted !== undefined) return persisted;
    this.log("copy identity was not persisted (another writer or a failed write) — using an in-memory identity for this destination");
    return minted;
  }

  /** The stored copy identity for `key`, if the document is one and it is currently that key's. */
  private storedCopyIdentity(parsed: unknown, key: string): InstanceIdentity | undefined {
    if (parsed === null || typeof parsed !== "object") return undefined;
    const doc = parsed as Record<string, unknown>;
    if (doc.current_destination !== key) return undefined;
    const destinations = doc.destinations;
    if (destinations === null || typeof destinations !== "object") return undefined;
    return parseIdentity((destinations as Record<string, unknown>)[key], () => this.nowIso());
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
