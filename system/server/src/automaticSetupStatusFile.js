import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// A small status file next to the process-ownership record, so the desktop app can put the status of automatic phone setup
// into Copy Diagnostics without asking the server (which would need a sign-in). It names the record file and its folder,
// never a full path, carries the pid of the process that wrote it (so a stale file is recognisable), and is removed when
// setup stops cleanly. Best effort: a failure here must never get in the way of setup.

export const STATUS_FILE_NAME = "automatic-setup-status.json";

export function statusFilePathFor(ownershipPath) {
  return path.join(path.dirname(ownershipPath), STATUS_FILE_NAME);
}

export function writeStatusFile({ ownershipPath, status, pid = process.pid, now = () => Date.now() }) {
  try {
    const target = statusFilePathFor(ownershipPath);
    const folder = path.dirname(target);
    const temporary = path.join(folder, `.${STATUS_FILE_NAME}.${randomUUID()}.tmp`);
    const body = {
      state: status.state, code: status.code, message: status.message,
      recordFile: path.basename(ownershipPath), folder: path.basename(folder), pid, writtenAt: new Date(now()).toISOString(),
    };
    try {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  } catch { /* best effort */ }
}

export function removeStatusFile(ownershipPath) {
  try { fs.rmSync(statusFilePathFor(ownershipPath), { force: true }); } catch { /* best effort */ }
}
