import nodeFs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { classifyRecordFile, readBootTimeMs, recoverDamagedRecord } from "./damagedRecordRecovery.js";

// Durable "which operating-system processes did THIS Bodun start" memory.
//
// Why it exists: ownership used to live only in the supervisor's memory, so an
// iproxy left over from an earlier run (a crash, a force-quit) looked like a
// stranger and blocked its phone forever. A record is written for every process
// Bodun starts and removed when the process is confirmed gone. Reclaiming a
// leftover later (portReclaimer.js) needs ALL of: the pid, the process start
// time and the exact command line, so a recycled pid can never be mistaken for
// ours. A record whose start time could not be read is marked `unverified` and
// is never used to authorise a signal.

const SCHEMA_VERSION = 1;
export const STORE_UNAVAILABLE = "PROCESS_OWNERSHIP_STORE_UNAVAILABLE";
const STORE_MESSAGE = "Bodun cannot check its earlier phone connections because the record of them is damaged or unreadable. Quit Bodun and open it again. Bodun will then offer to move the damaged record aside.";

function keyOf(kind, udid) {
  return `${kind}:${udid}`;
}

// reason: "damaged" (the content cannot be used, or something that is not a file is in its place: a person has to act) or
// "unreadable" (the file could not be read at all, for example a permissions problem: a new look may succeed).
function unavailableStoreError(reason = "damaged") {
  const error = new Error(STORE_MESSAGE);
  error.code = STORE_UNAVAILABLE;
  error.reason = reason;
  return error;
}

function readFile(fsImpl, filePath, log) {
  const state = classifyRecordFile({ fsImpl, filePath, key: "processes" });
  if (state.status === "missing") return {};
  if (state.status === "ok") return state.records;
  if (state.status === "unreadable") {
    log?.("process-ownership record is unreadable; automatic provisioning is blocked");
    throw unavailableStoreError("unreadable");
  }
  if (state.status === "not_a_file") log?.("process-ownership record is not a file; automatic provisioning is blocked");
  else log?.("process-ownership record is damaged; automatic provisioning is blocked");
  throw unavailableStoreError("damaged");
}

// Best effort: some systems cannot open a folder to flush it (Windows), and on macOS a flush does not make the drive empty its own
// cache (that needs F_FULLFSYNC, which Node cannot ask for). The write order is what matters: data on disk, then the name, then the folder.
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
function writeFile(fsImpl, filePath, processes) {
  const folder = path.dirname(filePath);
  fsImpl.mkdirSync(folder, { recursive: true });
  const temporary = path.join(folder, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = fsImpl.openSync(temporary, "wx");
    fsImpl.writeFileSync(handle, `${JSON.stringify({ version: SCHEMA_VERSION, processes }, null, 2)}\n`, "utf8");
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

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createProcessOwnershipStore({
  filePath,
  inspector = null,
  owner = { pid: process.pid, startTime: null },
  sleep = defaultSleep,
  now = () => new Date().toISOString(),
  startTimeAttempts = 3,
  startTimeDelayMs = 100,
  log = null,
  // Injectable so tests can watch the write order and choose the clock, the Mac's start time and the damaged-copy name.
  fsImpl = nodeFs,
  bootTime = () => readBootTimeMs(),
  clock = () => Date.now(),
  randomSuffix = undefined,
} = {}) {
  if (typeof filePath !== "string" || !filePath) throw new Error("a process-ownership file path is required");

  let cache = null;
  let queue = Promise.resolve();
  // Bumped on every record()/release() for a key so a slow start-time lookup
  // can never write a record for a process that has already exited.
  const generations = new Map();

  function load() {
    if (!cache) cache = readFile(fsImpl, filePath, log);
    return cache;
  }

  function persist() {
    const snapshot = JSON.parse(JSON.stringify(load()));
    queue = queue.catch(() => {}).then(() => writeFile(fsImpl, filePath, snapshot));
    return queue.catch(error => {
      // A failed write must never break process supervision.
      log?.(`process-ownership file could not be written (${error?.code || error?.name})`);
    });
  }

  async function lookUpStartTime(pid) {
    if (!inspector) return null;
    for (let attempt = 0; attempt < startTimeAttempts; attempt += 1) {
      const description = await inspector.describe(pid).catch(() => null);
      if (description?.startTime) return description;
      if (attempt < startTimeAttempts - 1) await sleep(startTimeDelayMs);
    }
    return null;
  }

  return {
    filePath,

    async record({ kind, udid, pid, bin, args = [], ports = [] }) {
      if (!kind || !udid || !Number.isSafeInteger(pid) || pid <= 0) return null;
      const key = keyOf(kind, udid);
      const generation = (generations.get(key) ?? 0) + 1;
      generations.set(key, generation);
      const description = await lookUpStartTime(pid);
      if (generations.get(key) !== generation) return null; // released or replaced meanwhile
      const record = {
        kind, udid, pid,
        startTime: description?.startTime ?? null,
        command: description?.command ?? [bin, ...args].join(" "),
        unverified: !description?.startTime,
        ports: [...ports],
        ownerServerPid: owner?.pid ?? null,
        ownerServerStartTime: owner?.startTime ?? null,
        recordedAt: now(),
      };
      load()[key] = record;
      await persist();
      return record;
    },

    // Removes the record only when it still describes `pid`, so a late "exited"
    // event for an old process cannot delete the record of its replacement.
    async release({ kind, udid, pid = null }) {
      const key = keyOf(kind, udid);
      const existing = load()[key];
      if (!existing) {
        generations.set(key, (generations.get(key) ?? 0) + 1);
        return false;
      }
      if (pid !== null && existing.pid !== pid) return false;
      generations.set(key, (generations.get(key) ?? 0) + 1);
      delete load()[key];
      await persist();
      return true;
    },

    // Forgets what was read and reads the file again, so nothing older than "now" is ever kept or written back (another Bodun
    // session may have written to it). With `recover: true` a damaged record that is provably older than the Mac's last start
    // is first moved aside (never deleted); in every other case a damaged record still throws the typed error, bytes untouched.
    // Returns { recovered } and, when a recovery was tried and refused, its reason.
    reload({ recover = false } = {}) {
      cache = null;
      let outcome = { recovered: false };
      if (recover) outcome = recoverDamagedRecord({ fsImpl, filePath, key: "processes", bootTime, now: clock, log, randomSuffix });
      load();
      return outcome;
    },

    get(kind, udid) {
      return load()[keyOf(kind, udid)] ?? null;
    },

    list() {
      return Object.values(load()).map(record => ({ ...record }));
    },

    // Drops a record without touching any process (the sweep uses this for
    // records whose process is provably gone or provably somebody else's).
    async drop(kind, udid) {
      const key = keyOf(kind, udid);
      if (!(key in load())) return false;
      delete load()[key];
      await persist();
      return true;
    },

    // True only when the kept record proves the old process is gone: no record,
    // the pid no longer exists, or the pid now belongs to a different process
    // (different start time). Anything else — including "could not tell" — is false.
    async confirmGone({ kind, udid }) {
      const existing = load()[keyOf(kind, udid)];
      if (!existing) return true;
      if (!inspector || inspector.supported === false) return false;
      const description = await inspector.describe(existing.pid).catch(() => undefined);
      if (description === undefined) return false;
      if (description === null) return true;
      return Boolean(existing.startTime) && description.startTime !== existing.startTime;
    },

    async flush() {
      await queue.catch(() => {}); // a failed write was already reported by persist()
    },
  };
}
