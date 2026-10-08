"use strict";

// Remembers the child processes this app started (the Bodun server and the site agent), in app storage, so a crash or
// force-quit that leaves one running can be recognised and cleaned up on the next launch. A record is written the moment a
// child is spawned, as soon as its start time can be read; a record whose start time could not be read is `unverified` and
// is never signalled.
//
// Reads are strict: a file that cannot be read as this record throws a typed error and is never changed. Only the explicit
// recover() may move a damaged file aside, and only when it is provably older than the Mac's last start (see
// damagedRecordRecovery.js); ordinary record(), remove() and list() never move anything.
const nodeFs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { classifyRecordFile, readBootTimeMs, recoverDamagedRecord } = require("./damagedRecordRecovery");

const STORE_UNAVAILABLE = "CHILD_OWNERSHIP_STORE_UNAVAILABLE";
const STORE_MESSAGE = "Bodun cannot check processes from its previous session because the record of them is damaged or unreadable. Quit Bodun and open it again. Bodun will then offer to move the damaged record aside.";

// reason: "damaged" (the content cannot be used, or something that is not a file is in its place: a person has to act) or
// "unreadable" (the file could not be read at all, for example a permissions problem).
function unavailableStoreError(reason = "damaged") {
  const error = new Error(STORE_MESSAGE);
  error.code = STORE_UNAVAILABLE;
  error.reason = reason;
  return error;
}

function readAll(fsImpl, filePath) {
  const state = classifyRecordFile({ fsImpl, filePath, key: "children" });
  if (state.status === "missing") return {};
  if (state.status === "ok") return state.records;
  throw unavailableStoreError(state.status === "unreadable" ? "unreadable" : "damaged");
}

// Best effort: some systems cannot open a folder to flush it, and on macOS a flush does not make the drive empty its own cache
// (that needs F_FULLFSYNC, which Node cannot ask for). The write order is what matters: data on disk, then the name, then the folder.
function flushFolder(fsImpl, folder) {
  let handle;
  try {
    handle = fsImpl.openSync(folder, "r");
    fsImpl.fsyncSync(handle);
  } catch { /* best effort */ } finally {
    try { if (handle !== undefined) fsImpl.closeSync(handle); } catch { /* best effort */ }
  }
}

// write the temporary file, flush it to disk, rename it into place, then flush the folder, so a power cut leaves either the old
// complete file or the new complete file under the real name, never a half-written one.
function writeAll(fsImpl, filePath, children) {
  const folder = path.dirname(filePath);
  fsImpl.mkdirSync(folder, { recursive: true });
  const temporary = path.join(folder, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(handle, `${JSON.stringify({ version: 1, children }, null, 2)}\n`, "utf8");
    fsImpl.fsyncSync(handle);
    fsImpl.closeSync(handle);
    handle = undefined;
    fsImpl.renameSync(temporary, filePath);
    flushFolder(fsImpl, folder);
  } finally {
    try { if (handle !== undefined) fsImpl.closeSync(handle); } catch { /* the original error matters more */ }
    fsImpl.rmSync(temporary, { force: true });
  }
}

function createChildrenStore({
  filePath, describe, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 3, delayMs = 100,
  // Injectable so tests can watch the write order and choose the clock, the Mac's start time and the damaged-copy name.
  fsImpl = nodeFs, bootTime = () => readBootTimeMs(), clock = () => Date.now(), randomSuffix = undefined, log = null,
} = {}) {
  if (!filePath) throw new Error("a children-record file path is required");
  const generations = new Map();
  let movedAside = false;
  return {
    filePath,
    async record({ kind, pid, port = null }) {
      if (!kind || !Number.isSafeInteger(pid) || pid <= 0) return null;
      const generation = (generations.get(kind) ?? 0) + 1;
      generations.set(kind, generation);
      let description = null;
      for (let attempt = 0; attempt < attempts && !description; attempt += 1) {
        description = await Promise.resolve(describe?.(pid)).catch(() => null);
        if (!description && attempt < attempts - 1) await sleep(delayMs);
      }
      if (generations.get(kind) !== generation) return null; // already removed or replaced
      const record = {
        kind, pid, port, startTime: description?.startTime ?? null, command: description?.command ?? null,
        unverified: !description?.startTime, recordedAt: new Date().toISOString(),
      };
      try {
        const all = readAll(fsImpl, filePath);
        all[kind] = record;
        writeAll(fsImpl, filePath, all);
      } catch { /* bookkeeping must never break the app */ }
      return record;
    },
    remove({ kind, pid = null }) {
      generations.set(kind, (generations.get(kind) ?? 0) + 1);
      try {
        const all = readAll(fsImpl, filePath);
        if (!all[kind] || (pid !== null && all[kind].pid !== pid)) return false;
        delete all[kind];
        writeAll(fsImpl, filePath, all);
        return true;
      } catch {
        return false;
      }
    },
    list() {
      return Object.values(readAll(fsImpl, filePath));
    },
    // Moves a damaged record aside (never deleting it) when it is provably older than the Mac's last start. → { recovered, ... }
    recover() {
      const outcome = recoverDamagedRecord({ fsImpl, filePath, key: "children", bootTime, now: clock, log, randomSuffix });
      if (outcome.recovered) movedAside = true;
      return outcome;
    },
    // "intact" | "moved aside" | "damaged" | "unreadable", for Copy Diagnostics. Never changes anything.
    health() {
      const state = classifyRecordFile({ fsImpl, filePath, key: "children" });
      if (state.status === "damaged" || state.status === "not_a_file") return "damaged";
      if (state.status === "unreadable") return "unreadable";
      return movedAside ? "moved aside" : "intact";
    },
  };
}

module.exports = { createChildrenStore, STORE_UNAVAILABLE };
