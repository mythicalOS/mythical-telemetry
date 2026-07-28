// Atomic, mode-pinned file writes for telemetry state (identity secrets, delivery state).
//
// Every rule here exists because the file it protects is either a credential or the only record
// that a delivery already happened:
//   - write a temp file in the SAME directory and rename() it, so a crash can never leave a
//     half-written identity that a reader would treat as corrupt and replace with a fresh mint;
//   - create the temp with O_EXCL so two concurrent writers cannot share it;
//   - chmod explicitly after creation — the `mode` argument to open() is masked by umask, and a
//     022 umask would leave a 0644 secret behind;
//   - fsync before rename so the rename cannot land ahead of the bytes;
//   - fsync the DIRECTORY after the rename, because the rename is a directory-metadata change and
//     syncing the file's contents says nothing about the durability of the entry that points at
//     them. Without it a power loss can leave the OLD directory entry in place even though the new
//     bytes are on disk — and for `instance.json` that is not a lost update but a lost IDENTITY:
//     the next boot finds no file, mints a fresh secret, and every heartbeat already sent under the
//     previous id becomes data the installation can no longer read OR DELETE, since the id is the
//     capability a user exercises to ask for their data back.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const SECRET_FILE_MODE = 0o600;
export const SECRET_DIR_MODE = 0o700;

function errnoOf(err: unknown): string {
  return typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "";
}

/**
 * Make sure the directory exists WITHOUT touching the mode of one that already does.
 *
 * `mkdirSync(recursive)` applies `mode` only to directories it creates, which is the property this
 * relies on. An explicit `chmod` here would be a bug, not a hardening: a deployment may have set a
 * deliberate group-traversable mode on the state directory (0710 for a helper user, say), and a
 * telemetry write that flattens it to 0700 breaks something that has nothing to do with telemetry.
 * A sibling product in this family was burned by exactly that.
 */
function ensureDirNoChmod(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
}

export function atomicWriteFileSync(filePath: string, data: string, mode: number = SECRET_FILE_MODE): void {
  const dir = path.dirname(filePath);
  ensureDirNoChmod(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, data, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, mode); // umask-proof: open()'s mode is masked, chmod is not
    fs.renameSync(tmp, filePath);
    fsyncDirSync(dir);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the throw below is the real failure */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * Errnos from `link(2)` that mean "this filesystem cannot make hard links", as opposed to "the
 * link failed". The set is deliberately tiny: anything outside it is a real error and is RETHROWN,
 * because a fallback that swallows an unknown failure is a fallback that silently clobbers.
 *
 * `EPERM` is the important one — POSIX specifies it for a filesystem that does not support link
 * creation, which is how a container bind mount typically refuses.
 */
const LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(["EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EXDEV"]);

export interface ExclusiveCreateOptions {
  mode?: number;
  /** Warning sink — used when the filesystem cannot hard-link and the weaker fallback is taken. */
  log?: (line: string) => void;
}

/**
 * GET-OR-CREATE, not write. Creates `filePath` holding `data` if and only if it does not exist yet;
 * returns `true` when THIS call created it and `false` when it already existed — in which case
 * nothing on disk was changed and the caller has lost the race and must adopt the winner.
 *
 * WHY THIS EXISTS ALONGSIDE `atomicWriteFileSync`. That function always clobbers, which is right
 * for a document whose new contents supersede the old and wrong for a first-writer-wins claim:
 * two processes minting an identity would each write a perfectly atomic file and one identity
 * would still be destroyed. Atomic write is not atomic get-or-create, and using it for one is how
 * a lost identity happens with every individual write looking correct.
 *
 * WHY WRITE-THEN-LINK RATHER THAN `O_CREAT|O_EXCL` ON THE DESTINATION. `open(…, "wx")` publishes
 * the final name FIRST and the bytes after it, so a concurrent reader — or this process after a
 * crash in between — can observe the destination existing but empty, and an empty identity file
 * reads as corrupt and gets replaced by a fresh mint, which is the exact loss the claim exists to
 * prevent. Writing into a private same-directory temp and then `link(2)`-ing it into place makes
 * the destination atomically go from absent to complete: `link` fails with `EEXIST` if the name is
 * taken, and that failure IS the lock.
 *
 * The link-less fallback below is taken only where hard links are genuinely unavailable. It keeps
 * exclusivity — `O_EXCL` is still a real claim — and gives up only the never-observed-empty
 * property, which is why it warns.
 */
export function createFileExclusiveSync(filePath: string, data: string, options: ExclusiveCreateOptions = {}): boolean {
  const mode = options.mode ?? SECRET_FILE_MODE;
  const log = options.log ?? ((): void => {});
  const dir = path.dirname(filePath);
  ensureDirNoChmod(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, data, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, mode); // umask-proof, and it must happen BEFORE the link publishes the inode
    try {
      fs.linkSync(tmp, filePath);
    } catch (err) {
      const code = errnoOf(err);
      // We lost. Someone else's file is there and it is not ours to touch.
      if (code === "EEXIST") return false;
      if (!LINK_UNSUPPORTED_CODES.has(code)) throw err;
      log(
        `hard links are unavailable on the filesystem holding ${filePath} (${code}) — claiming by exclusive open instead, ` +
          `which is momentarily visible as an empty file`,
      );
      return createByExclusiveOpen(filePath, data, mode);
    }
    fsyncDirSync(dir);
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the throw already in flight is the real failure */
      }
    }
    // Unlinks the temp NAME. After a successful link the inode lives on under the final name, so
    // this is cleanup and not a rollback; on every other path it is the rollback.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Is `filePath` still the exact inode we created, or has someone replaced the name under us?
 *
 * A CHECK, NOT A HOLD, and the difference is worth being exact about: the answer is true "as of
 * this stat", and nothing stops a replacement landing immediately after it returns. There is no
 * unlink-if-inode or return-if-still-mine anywhere in POSIX, so that residual is irreducible rather
 * than unfixed. What the check does remove is the wide window — the whole write — during which the
 * destination is a ZERO-LENGTH file that a reader will judge unreadable and replace. What is left
 * is the ordinary clobber-a-complete-file window that every writer here shares, and that the
 * package documents as the reason one writer per state directory is the supported topology.
 */
function isStillOurInode(filePath: string, ours: ReturnType<typeof fs.fstatSync>): boolean {
  try {
    const current = fs.statSync(filePath);
    return current.ino === ours.ino && current.dev === ours.dev;
  } catch {
    return false; // gone entirely — certainly not ours any more
  }
}

/**
 * The link-less claim: still exclusive, but it publishes the NAME first and the bytes after, so the
 * destination is briefly visible and empty.
 *
 * THAT WINDOW IS NOT COSMETIC AND IS WHY EVERYTHING BELOW IS INODE-GUARDED. A concurrent reader
 * that sees the empty file reads it as an unreadable document and may replace it — which is the
 * correct thing for it to do about a corrupt file, and it means the name we hold can stop being
 * ours between the `open` and the `write`. If that happens we LOST, and two further mistakes are
 * available: carrying on and reporting success (the caller would return an identity that is not on
 * disk — the exact loss this whole primitive exists to prevent), and "cleaning up our file" on a
 * failure path, which by then deletes the winner's file instead of our own. So the descriptor is
 * chmod'd through the fd rather than the path, the success is conditional on the destination still
 * being our inode, and the cleanup is too. Losing here returns false, changes nothing, and lets the
 * caller re-read and adopt the winner.
 */
function createByExclusiveOpen(filePath: string, data: string, mode: number): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "wx", mode);
  } catch (err) {
    if (errnoOf(err) === "EEXIST") return false;
    throw err;
  }
  // Everything after the open is inside the protected block, `fstatSync` included: it is the first
  // thing that can throw while we hold both a descriptor and a published empty name, and leaving it
  // outside leaked the descriptor AND left that empty file for the next reader to self-heal over.
  let ours: ReturnType<typeof fs.fstatSync> | undefined;
  try {
    ours = fs.fstatSync(fd);
    fs.writeFileSync(fd, data, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, mode); // the DESCRIPTOR, never the path — the path may not be ours any more
    if (!isStillOurInode(filePath, ours)) return false;
    fs.closeSync(fd);
    fd = undefined;
    fsyncDirSync(path.dirname(filePath));
    return true;
  } catch (err) {
    // Remove the half-made file, but ONLY while it still looks like ours — and never at all if the
    // fstat failed, because then we have no evidence of what we created and an unconditional unlink
    // of a name we cannot identify is how a winner's identity gets deleted by a loser's error path.
    // The asymmetry is deliberate: an unreadable file left behind is RECOVERABLE (every reader here
    // treats corrupt as absent and the self-heal replaces it, including this process on its next
    // call), and a deleted identity is not.
    if (ours !== undefined && isStillOurInode(filePath, ours)) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* best effort */
      }
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing left to do with it */
      }
    }
  }
}

/**
 * Take a name that is already occupied — replacing what is there UNLESS `shouldKeep` says the
 * occupant is one this caller must not destroy.
 *
 * This is the last hole in a get-or-create. Having read a file and decided it must go (it is
 * corrupt, or it holds a configuration that has been superseded), the obvious move is to write over
 * it; but between that read and that write another process can put a REAL document at the name, and
 * the rename then destroys it. For an identity that is the unrecoverable case, so the decision and
 * the removal are tied to one inode:
 *
 *   - the bytes and the identity of the file are taken through the SAME descriptor, so there is no
 *     gap between "this must go" and "this is the file I am talking about";
 *   - `shouldKeep` gets the parsed content — `undefined` when it does not parse at all — and a
 *     `true` means the occupant stays: return false, change nothing, let the caller adopt it;
 *   - the removal is guarded on the name still resolving to that same inode — checked immediately
 *     before it, so a document that appeared while we were reading is left alone (the gap between
 *     that check and the `unlink` itself is the irreducible one noted below);
 *   - and the fresh content goes in through the ordinary exclusive claim, so whoever took the freed
 *     name first still wins.
 *
 * Returns true when this call published `data`. Every false means "something else is there now, go
 * read it". The one instant it cannot cover is between the inode check and the `unlink`, which is
 * the same irreducible check-then-act every writer here has and the package documents as such.
 */
export function claimByReplacingSync(
  filePath: string,
  data: string,
  shouldKeep: (parsed: unknown) => boolean,
  options: ExclusiveCreateOptions = {},
): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (err) {
    // Gone: there is nothing to heal, and an ordinary claim is exactly right.
    if (errnoOf(err) === "ENOENT") return createFileExclusiveSync(filePath, data, options);
    throw err;
  }

  let ours: ReturnType<typeof fs.fstatSync>;
  try {
    ours = fs.fstatSync(fd);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
    } catch {
      parsed = undefined; // does not parse at all — one of the cases this function exists for
    }
    if (shouldKeep(parsed)) return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* nothing left to do with it */
    }
  }

  if (!isStillOurInode(filePath, ours)) return false; // replaced while we were reading it
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (errnoOf(err) !== "ENOENT") throw err;
  }
  return createFileExclusiveSync(filePath, data, options);
}

/**
 * Make the rename itself durable by syncing the directory that now holds the entry.
 *
 * BEST-EFFORT ON PURPOSE, and it must stay that way. Not every platform allows a directory to be
 * opened and synced — Windows does not — and a filesystem may refuse it for its own reasons. The
 * rename is already atomic without this; what the sync adds is a guarantee that it SURVIVES power
 * loss. Turning a platform that cannot offer that guarantee into a hard write failure would break
 * the product this package reports on, over a durability upgrade, which is the wrong trade in a
 * module whose first rule is that telemetry never takes its host down. So every failure here is
 * swallowed, and this function cannot throw — the caller's `catch` treats a throw as a failed
 * write and deletes a temp file that the rename has already consumed.
 */
function fsyncDirSync(dir: string): void {
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
  } catch {
    /* the platform will not sync a directory; the write itself still landed atomically */
  } finally {
    if (dirFd !== undefined) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* nothing left to do with it */
      }
    }
  }
}

/** Read + JSON.parse, returning undefined for absent/unreadable/corrupt rather than throwing. */
export function readJsonSync(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
