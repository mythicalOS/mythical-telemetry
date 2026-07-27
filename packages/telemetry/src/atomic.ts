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

export function atomicWriteFileSync(filePath: string, data: string, mode: number = SECRET_FILE_MODE): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
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
