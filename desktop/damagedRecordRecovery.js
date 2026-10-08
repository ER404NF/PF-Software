"use strict";

// What to do with a record file of "which processes did Bodun start" that cannot be read as such. This is the same rule as
// system/server/src/damagedRecordRecovery.js (the server is an ES module package and this app is CommonJS, so the small
// helper exists once in each; both are tested against one shared list of damaged shapes).
//
// An automatic fix is allowed only when it is certain that every process the file could describe is gone: the file was last
// changed well before the Mac last started, and a restart ends every process. Anything doubtful (no start time, no file time,
// a clock that disagrees with itself, a folder or an unreadable file in its place) stays blocked, and the file is left byte for
// byte as it was. "Fixing" never deletes: the damaged file is kept next to the record under a new name.
//
// Known limit: both times are wall-clock times. A clock that was stepped after the Mac started shifts the comparison by the
// size of the step, which the margin does not cover. That is why this rule is limited to damaged files, never to valid ones.
// On macOS fsync does not force the drive to empty its own cache (that needs F_FULLFSYNC, which Node cannot ask for); the
// write order is still what keeps a crash from leaving a half-written file under the real name.

const nodeFs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync: nodeExecFileSync } = require("child_process");

const BOOT_MARGIN_MS = 5 * 60_000;
const CLOCK_DISAGREEMENT_MS = 60_000;
const EARLIEST_PLAUSIBLE_BOOT_MS = Date.UTC(2001, 0, 1);
const LINKLESS_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);

// → { status: "missing" | "ok" | "damaged" | "not_a_file" | "unreadable", records?: object, text?: string }
function classifyRecordFile({ fsImpl = nodeFs, filePath, key }) {
  let stat;
  try {
    stat = fsImpl.statSync(filePath);
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "missing" } : { status: "unreadable" };
  }
  if (!stat.isFile()) return { status: "not_a_file" };
  let text;
  try {
    text = fsImpl.readFileSync(filePath, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "missing" } : { status: "unreadable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "damaged", text };
  }
  const records = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed[key] : undefined;
  if (!records || typeof records !== "object" || Array.isArray(records)) return { status: "damaged", text };
  return { status: "ok", records, text };
}

// The Mac's start time in ms, or null when it cannot be known with confidence. Two independent sources must agree within a
// minute: the kernel's own record (a fixed, read-only `sysctl -n kern.boottime`) and the clock minus the uptime. Only macOS
// is trusted with this; elsewhere (a development machine, the tests) the answer is null.
function readBootTimeMs({
  platform = process.platform, execFileSync = nodeExecFileSync, now = () => Date.now(), uptime = () => os.uptime(),
} = {}) {
  if (platform !== "darwin") return null;
  try {
    const nowMs = now();
    const up = uptime();
    if (!Number.isFinite(nowMs) || !Number.isFinite(up) || up <= 0) return null;
    const output = String(execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 3000, windowsHide: true }));
    const match = /sec\s*=\s*(\d+)/.exec(output);
    if (!match) return null;
    const fromKernel = Number(match[1]) * 1000;
    if (!Number.isFinite(fromKernel) || fromKernel < EARLIEST_PLAUSIBLE_BOOT_MS || fromKernel > nowMs) return null;
    if (Math.abs(fromKernel - (nowMs - up * 1000)) > CLOCK_DISAGREEMENT_MS) return null;
    return fromKernel;
  } catch {
    return null;
  }
}

// True only when the NEWEST of the file's modified, status-change and creation times is more than `marginMs` before the start.
function olderThanBoot({ stat, bootMs, marginMs = BOOT_MARGIN_MS }) {
  if (!Number.isFinite(bootMs) || !stat || !Number.isFinite(stat.mtimeMs)) return false;
  const times = [stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs].filter(value => value !== undefined && value !== null);
  if (times.some(value => !Number.isFinite(value))) return false;
  return Math.max(...times) < bootMs - marginMs;
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Keeps the old file under a new name next to it, never overwriting an existing name and never deleting any bytes. ONE atomic
// rename moves whatever is at the record's name right now, so there is no moment in which a name could be removed from under a
// file that someone else has just put there. If `verify(copyPath)` says the moved bytes are not the ones that were judged
// damaged, they are put back (without overwriting anything newer; if that is not possible they stay safe under the new name).
// Returns the new name, or null when the old name was already gone.
function moveAside({ fsImpl = nodeFs, filePath, now = () => Date.now(), randomSuffix = () => Math.random().toString(36).slice(2, 8), verify = null }) {
  const folder = path.dirname(filePath);
  const base = path.basename(filePath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `${base}.damaged-${stamp(now())}${attempt === 0 ? "" : `-${randomSuffix()}`}`;
    const target = path.join(folder, name);
    try {
      try { fsImpl.lstatSync(target); continue; } catch (error) { if (error?.code !== "ENOENT") throw error; }
      fsImpl.renameSync(filePath, target);
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (verify && verify(target) === false) {
      putBack(fsImpl, target, filePath);
      const veto = new Error("the record changed while it was being moved");
      veto.code = "CHANGED_MEANWHILE";
      throw veto;
    }
    return name;
  }
  throw new Error("no free name was found for the damaged copy");
}

// Returns a moved file to its old name, but only if that name is still free (a hard link, or a copy that refuses to overwrite
// where links are not possible). When it cannot, the moved file simply stays under its new name: its bytes are never lost.
function putBack(fsImpl, movedPath, originalPath) {
  try {
    fsImpl.linkSync(movedPath, originalPath);
  } catch (error) {
    if (!LINKLESS_CODES.has(error?.code)) return;
    try { fsImpl.copyFileSync(movedPath, originalPath, nodeFs.constants.COPYFILE_EXCL); } catch { return; }
  }
  try { fsImpl.unlinkSync(movedPath); } catch { /* the bytes are in both places, which does no harm */ }
}

// → { recovered: true, name } | { recovered: false, reason }.
// reasons: missing, ok, unreadable, not_a_file (never moved automatically), boot_time_unknown, time_unknown,
// not_older_than_boot, changed_meanwhile, move_failed.
function recoverDamagedRecord({
  fsImpl = nodeFs, filePath, key, bootTime = () => readBootTimeMs(), now = () => Date.now(), log = null,
  marginMs = BOOT_MARGIN_MS, randomSuffix,
}) {
  const state = classifyRecordFile({ fsImpl, filePath, key });
  if (state.status !== "damaged") return { recovered: false, reason: state.status };
  let bootMs = null;
  try { bootMs = bootTime(); } catch { bootMs = null; }
  if (!Number.isFinite(bootMs)) return { recovered: false, reason: "boot_time_unknown" };
  let stat;
  try { stat = fsImpl.statSync(filePath); } catch { return { recovered: false, reason: "time_unknown" }; }
  if (!Number.isFinite(stat?.mtimeMs)) return { recovered: false, reason: "time_unknown" };
  if (!olderThanBoot({ stat, bootMs, marginMs })) {
    return { recovered: false, reason: [stat.ctimeMs, stat.birthtimeMs].some(value => value !== undefined && !Number.isFinite(value)) ? "time_unknown" : "not_older_than_boot" };
  }
  let name;
  try {
    name = moveAside({
      fsImpl, filePath, now, randomSuffix,
      verify: copyPath => { try { return fsImpl.readFileSync(copyPath, "utf8") === state.text; } catch { return false; } },
    });
  } catch (error) {
    return { recovered: false, reason: error?.code === "CHANGED_MEANWHILE" ? "changed_meanwhile" : "move_failed" };
  }
  if (name === null) return { recovered: false, reason: "missing" };
  log?.(`the record of earlier processes was damaged and had not changed since before this Mac last started (started ${new Date(bootMs).toISOString()}); it was moved aside to a safe copy and Bodun continued`);
  return { recovered: true, name };
}

module.exports = { BOOT_MARGIN_MS, classifyRecordFile, moveAside, olderThanBoot, readBootTimeMs, recoverDamagedRecord };
