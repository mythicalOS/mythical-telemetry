// Atomic, mode-pinned file writes for telemetry state (identity secrets, delivery state).
//
// Every rule here exists because the file it protects is either a credential or the only record
// that a delivery already happened:
//   - write a temp file in the SAME directory and rename() it, so a crash can never leave a
//     half-written identity that a reader would treat as corrupt and replace with a fresh mint;
//   - create the temp with O_EXCL so two concurrent writers cannot share it;
//   - chmod explicitly after creation — the `mode` argument to open() is masked by umask, and a
//     022 umask would leave a 0644 secret behind;
//   - fsync before rename so the rename cannot land ahead of the bytes.

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

/** Read + JSON.parse, returning undefined for absent/unreadable/corrupt rather than throwing. */
export function readJsonSync(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
