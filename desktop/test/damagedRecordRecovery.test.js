"use strict";

// The desktop copy of the damaged-record rule (desktop/damagedRecordRecovery.js), tested against the SAME shared list of damaged
// shapes as the server's copy (system/server/test/fixtures/damagedRecordCases.json), with the desktop record's own key.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  classifyRecordFile, olderThanBoot, readBootTimeMs, moveAside, recoverDamagedRecord, BOOT_MARGIN_MS,
} = require("../damagedRecordRecovery.js");

// A damaged ownership record is moved aside automatically ONLY when it is certain that every process it could name is gone:
// the file was last changed well before the Mac last started (a restart ends every process). Anything doubtful stays blocked.

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../../system/server/test/fixtures/damagedRecordCases.json"), "utf8"));
const MINUTE = 60_000;
const BOOT = Date.UTC(2026, 9, 7, 8, 0, 0);

function tempFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bodun-damaged-"));
}

function writeAt(file, text, timeMs) {
  fs.writeFileSync(file, text);
  const seconds = timeMs / 1000;
  fs.utimesSync(file, seconds, seconds);
}

test("the shared fixture cases get the same verdict", () => {
  const folder = tempFolder();
  for (const item of fixtures.cases) {
    const file = path.join(folder, "records.json");
    fs.writeFileSync(file, item.text.replaceAll("$KEY", "children"));
    const verdict = classifyRecordFile({ fsImpl: fs, filePath: file, key: "children" });
    assert.equal(verdict.status === "ok" ? "ok" : verdict.status, item.verdict, item.name);
  }
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a missing file, a folder in its place, and an unreadable file are not content damage", () => {
  const folder = tempFolder();
  assert.equal(classifyRecordFile({ fsImpl: fs, filePath: path.join(folder, "none.json"), key: "children" }).status, "missing");
  fs.mkdirSync(path.join(folder, "dir.json"));
  assert.equal(classifyRecordFile({ fsImpl: fs, filePath: path.join(folder, "dir.json"), key: "children" }).status, "not_a_file");
  const unreadable = { ...fs, statSync: () => ({ isFile: () => true }), readFileSync: () => { const error = new Error("denied"); error.code = "EACCES"; throw error; } };
  assert.equal(classifyRecordFile({ fsImpl: unreadable, filePath: "x.json", key: "children" }).status, "unreadable");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("older than the last start is judged on both sides of the boundary, using the newest of the file's times", () => {
  const stat = (mtimeMs, ctimeMs = mtimeMs, birthtimeMs = mtimeMs) => ({ mtimeMs, ctimeMs, birthtimeMs });
  assert.equal(olderThanBoot({ stat: stat(BOOT - BOOT_MARGIN_MS - 1), bootMs: BOOT }), true);
  assert.equal(olderThanBoot({ stat: stat(BOOT - BOOT_MARGIN_MS), bootMs: BOOT }), false, "exactly on the margin is not older");
  assert.equal(olderThanBoot({ stat: stat(BOOT - 1000), bootMs: BOOT }), false, "just before the start is inside the margin");
  assert.equal(olderThanBoot({ stat: stat(BOOT + 1000), bootMs: BOOT }), false, "after the start");
  assert.equal(olderThanBoot({ stat: stat(BOOT - 10 * MINUTE, BOOT + 1000), bootMs: BOOT }), false, "a newer status change counts");
  assert.equal(olderThanBoot({ stat: stat(BOOT - 10 * MINUTE, BOOT - 10 * MINUTE, BOOT + 1000), bootMs: BOOT }), false, "a newer creation time counts");
  assert.equal(olderThanBoot({ stat: stat(Number.NaN), bootMs: BOOT }), false, "an unreadable time never qualifies");
  assert.equal(olderThanBoot({ stat: stat(BOOT - 10 * MINUTE), bootMs: null }), false, "an unknown start never qualifies");
  assert.equal(olderThanBoot({ stat: stat(BOOT - 10 * MINUTE), bootMs: Number.NaN }), false);
  assert.equal(olderThanBoot({ stat: {}, bootMs: BOOT }), false);
});

// ---- the boot time: two sources that must agree -----------------------------------------------------

test("the start time of the Mac is used only when the kernel and the uptime agree", () => {
  const now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const kernel = seconds => () => `{ sec = ${seconds}, usec = 0 } Wed Oct  7 08:00:00 2026\n`;
  const upSince = 4 * 3600; // 08:00 by uptime
  const base = { platform: "darwin", now: () => now, uptime: () => upSince };
  assert.equal(readBootTimeMs({ ...base, execFileSync: kernel(BOOT / 1000) }), BOOT);
  assert.equal(readBootTimeMs({ ...base, execFileSync: kernel(BOOT / 1000 + 59) }), BOOT + 59_000, "59 seconds apart still agrees");
  assert.equal(readBootTimeMs({ ...base, execFileSync: kernel(BOOT / 1000 + 61) }), null, "61 seconds apart does not");
  assert.equal(readBootTimeMs({ ...base, execFileSync: kernel(BOOT / 1000 - 3600) }), null, "an hour apart (slept? stepped clock?) does not");
});

test("no start time off macOS, and none when anything is missing or implausible", () => {
  const now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const good = { platform: "darwin", now: () => now, uptime: () => 4 * 3600, execFileSync: () => `{ sec = ${BOOT / 1000}, usec = 0 }` };
  assert.equal(readBootTimeMs({ ...good, platform: "linux" }), null);
  assert.equal(readBootTimeMs({ ...good, platform: "win32" }), null);
  assert.equal(readBootTimeMs({ ...good, uptime: () => 0 }), null);
  assert.equal(readBootTimeMs({ ...good, uptime: () => Number.NaN }), null);
  assert.equal(readBootTimeMs({ ...good, execFileSync: () => { throw new Error("no sysctl"); } }), null);
  assert.equal(readBootTimeMs({ ...good, execFileSync: () => "garbage" }), null);
  assert.equal(readBootTimeMs({ ...good, execFileSync: () => "{ sec = 100, usec = 0 }" }), null, "before 2001 is not plausible");
  assert.equal(readBootTimeMs({ ...good, execFileSync: () => `{ sec = ${now / 1000 + 5000}, usec = 0 }` }), null, "in the future is not plausible");
});

test("the start time is read with fixed, read-only arguments", () => {
  const calls = [];
  readBootTimeMs({
    platform: "darwin", now: () => BOOT + 3600_000, uptime: () => 3600,
    execFileSync: (...args) => { calls.push(args); return `{ sec = ${BOOT / 1000}, usec = 0 }`; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "sysctl");
  assert.deepEqual(calls[0][1], ["-n", "kern.boottime"]);
});

// ---- moving aside: never overwrite, never delete -----------------------------------------------------

test("moving aside keeps every byte in a timestamped copy next to the record and removes only the old name", () => {
  const folder = tempFolder();
  const file = path.join(folder, "records.json");
  const bytes = "{\"version\":1,\"children\":{\"a:";
  fs.writeFileSync(file, bytes);
  const name = moveAside({ fsImpl: fs, filePath: file, now: () => Date.UTC(2026, 9, 7, 9, 30, 15), randomSuffix: () => "zz" });
  assert.equal(name, "records.json.damaged-20261007T093015Z");
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(folder, name), "utf8"), bytes);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("an existing copy is never overwritten: a second move picks another name and both copies survive", () => {
  const folder = tempFolder();
  const file = path.join(folder, "records.json");
  const clock = () => Date.UTC(2026, 9, 7, 9, 30, 15);
  fs.writeFileSync(file, "first-damage");
  const first = moveAside({ fsImpl: fs, filePath: file, now: clock, randomSuffix: () => "aa" });
  fs.writeFileSync(file, "second-damage");
  const second = moveAside({ fsImpl: fs, filePath: file, now: clock, randomSuffix: () => "bb" });
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(path.join(folder, first), "utf8"), "first-damage");
  assert.equal(fs.readFileSync(path.join(folder, second), "utf8"), "second-damage");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("when the old name has already gone (another session moved it first) nothing is thrown and nothing is deleted", () => {
  const folder = tempFolder();
  const result = moveAside({ fsImpl: fs, filePath: path.join(folder, "records.json"), now: () => BOOT, randomSuffix: () => "x" });
  assert.equal(result, null);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a folder in the record's place is moved by rename, also without overwriting", () => {
  const folder = tempFolder();
  const dir = path.join(folder, "records.json");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "inside.txt"), "keep me");
  const name = moveAside({ fsImpl: fs, filePath: dir, now: () => Date.UTC(2026, 9, 7, 9, 0, 0), randomSuffix: () => "q" });
  assert.equal(fs.readFileSync(path.join(folder, name, "inside.txt"), "utf8"), "keep me");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a record is moved with one atomic rename: no copy is made and no name is removed", () => {
  const folder = tempFolder();
  const file = path.join(folder, "records.json");
  fs.writeFileSync(file, "damaged");
  const calls = [];
  const spy = {
    ...fs,
    renameSync: (from, to) => { calls.push(["rename", path.basename(from)]); fs.renameSync(from, to); },
    unlinkSync: target => { calls.push(["unlink", path.basename(target)]); fs.unlinkSync(target); },
    copyFileSync: (from, to) => { calls.push(["copy", path.basename(from)]); fs.copyFileSync(from, to); },
  };
  const name = moveAside({ fsImpl: spy, filePath: file, now: () => BOOT, randomSuffix: () => "r" });
  assert.deepEqual(calls, [["rename", "records.json"]]);
  assert.equal(fs.readFileSync(path.join(folder, name), "utf8"), "damaged");
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(folder, { recursive: true, force: true });
});

// ---- the whole rule ----------------------------------------------------------------------------------------

// A file system whose answer about ONE file's three times is chosen by the test (the real status-change time of a file written
// a moment ago is always "now", so a real file cannot be made to look old); every other call is the real file system.
function timed(file, { mtimeMs, ctimeMs = mtimeMs, birthtimeMs = mtimeMs }) {
  return {
    ...fs,
    statSync: target => {
      const real = fs.statSync(target);
      return path.resolve(String(target)) === path.resolve(file)
        ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { mtimeMs, ctimeMs, birthtimeMs })
        : real;
    },
  };
}

function setup(text, mtimeMs, times = {}) {
  const folder = tempFolder();
  const file = path.join(folder, "records.json");
  fs.writeFileSync(file, text);
  return { folder, file, fsImpl: timed(file, { mtimeMs, ...times }) };
}

const common = { key: "children", now: () => BOOT + 60 * MINUTE, randomSuffix: () => "t" };

test("damaged and older than the last start: moved aside, logged without a path, original bytes preserved", () => {
  const { folder, file, fsImpl } = setup("{\"version\":1,\"children\":{", BOOT - 30 * MINUTE);
  const lines = [];
  const result = recoverDamagedRecord({ ...common, fsImpl, filePath: file, bootTime: () => BOOT, log: line => lines.push(line) });
  assert.equal(result.recovered, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(folder, result.name), "utf8"), "{\"version\":1,\"children\":{");
  assert.equal(lines.length >= 1, true);
  for (const line of lines) assert.doesNotMatch(line, /[\\/]|records\.json/, "a log line never carries a path or the file name");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("every damaged shape older than the start is recovered; every valid file is left alone", () => {
  for (const item of fixtures.cases) {
    const { folder, file, fsImpl } = setup(item.text.replaceAll("$KEY", "children"), BOOT - 30 * MINUTE);
    const result = recoverDamagedRecord({ ...common, fsImpl, filePath: file, bootTime: () => BOOT });
    assert.equal(result.recovered, item.verdict === "damaged", item.name);
    if (item.verdict === "ok") assert.equal(fs.existsSync(file), true, item.name);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("damaged but newer than the last start: never moved, bytes untouched", () => {
  const { folder, file, fsImpl } = setup("{\"broken", BOOT + 5 * MINUTE);
  const result = recoverDamagedRecord({ ...common, fsImpl, filePath: file, bootTime: () => BOOT });
  assert.deepEqual({ recovered: result.recovered, reason: result.reason }, { recovered: false, reason: "not_older_than_boot" });
  assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("damaged inside the margin before the start: never moved", () => {
  const { folder, file, fsImpl } = setup("{\"broken", BOOT - 2 * MINUTE);
  assert.equal(recoverDamagedRecord({ ...common, fsImpl, filePath: file, bootTime: () => BOOT }).recovered, false);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("start time unknown: never moved", () => {
  for (const bootTime of [() => null, () => Number.NaN, () => { throw new Error("no clock"); }]) {
    const { folder, file, fsImpl } = setup("{\"broken", BOOT - 30 * MINUTE);
    const result = recoverDamagedRecord({ ...common, fsImpl, filePath: file, bootTime });
    assert.deepEqual({ recovered: result.recovered, reason: result.reason }, { recovered: false, reason: "boot_time_unknown" });
    assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("file time unknown: never moved", () => {
  const { folder, file, fsImpl } = setup("{\"broken", BOOT - 30 * MINUTE);
  const blind = { ...fsImpl, statSync: target => (target === file ? { isFile: () => true, isDirectory: () => false, mtimeMs: Number.NaN, ctimeMs: Number.NaN, birthtimeMs: Number.NaN } : fs.statSync(target)) };
  const result = recoverDamagedRecord({ ...common, fsImpl: blind, filePath: file, bootTime: () => BOOT });
  assert.equal(result.recovered, false);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a folder in the place of the record, or a missing file, is never moved automatically", () => {
  const folder = tempFolder();
  fs.mkdirSync(path.join(folder, "records.json"));
  const dir = recoverDamagedRecord({ ...common, fsImpl: fs, filePath: path.join(folder, "records.json"), bootTime: () => BOOT });
  assert.deepEqual({ recovered: dir.recovered, reason: dir.reason }, { recovered: false, reason: "not_a_file" });
  const missing = recoverDamagedRecord({ ...common, fsImpl: fs, filePath: path.join(folder, "other.json"), bootTime: () => BOOT });
  assert.deepEqual({ recovered: missing.recovered, reason: missing.reason }, { recovered: false, reason: "missing" });
  fs.rmSync(folder, { recursive: true, force: true });
});

const HEALTHY = "{\"version\":1,\"processes\":{\"a:b\":{\"pid\":7}}}";

// What another session's safe write does: a complete new file is put under the record's name in one step.
function replaceAtomically(file) {
  const fresh = `${file}.fresh`;
  fs.writeFileSync(fresh, HEALTHY);
  fs.renameSync(fresh, file);
}

test("a record rewritten by another session just before the move is put back untouched", () => {
  const { folder, file, fsImpl } = setup("{\"broken", BOOT - 30 * MINUTE);
  const swapping = {
    ...fsImpl,
    renameSync: (from, to) => {
      fs.writeFileSync(from, HEALTHY); // another session wrote a good file just now
      fs.renameSync(from, to);
    },
  };
  const result = recoverDamagedRecord({ ...common, fsImpl: swapping, filePath: file, bootTime: () => BOOT });
  assert.deepEqual({ recovered: result.recovered, reason: result.reason }, { recovered: false, reason: "changed_meanwhile" });
  assert.equal(fs.readFileSync(file, "utf8"), HEALTHY, "the healthy record is back under its name");
  assert.deepEqual(fs.readdirSync(folder), ["records.json"], "the moved file went back; nothing else was touched");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a healthy record that another session puts in place at the last moment is never deleted", () => {
  const { folder, file, fsImpl } = setup("{\"broken", BOOT - 30 * MINUTE);
  // Whichever step of the move comes next, a complete healthy file lands on the record's name first.
  const racing = {
    ...fsImpl,
    renameSync: (from, to) => { if (from === file) replaceAtomically(file); fs.renameSync(from, to); },
    unlinkSync: target => { if (target === file) replaceAtomically(file); fs.unlinkSync(target); },
  };
  const result = recoverDamagedRecord({ ...common, fsImpl: racing, filePath: file, bootTime: () => BOOT });
  assert.equal(result.recovered, false);
  assert.equal(fs.readFileSync(file, "utf8"), HEALTHY, "the healthy record is still there, byte for byte");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("putting a mistaken move back also works where hard links are not available, and never overwrites a newer file", () => {
  const noLinks = base => ({ ...base, linkSync: () => { const error = new Error("no links here"); error.code = "ENOTSUP"; throw error; } });
  {
    const { folder, file, fsImpl } = setup("{\"broken", BOOT - 30 * MINUTE);
    const racing = noLinks({ ...fsImpl, renameSync: (from, to) => { replaceAtomically(from); fs.renameSync(from, to); } });
    assert.equal(recoverDamagedRecord({ ...common, fsImpl: racing, filePath: file, bootTime: () => BOOT }).recovered, false);
    assert.equal(fs.readFileSync(file, "utf8"), HEALTHY);
    assert.deepEqual(fs.readdirSync(folder), ["records.json"]);
    fs.rmSync(folder, { recursive: true, force: true });
  }
  {
    // A third file appears under the name before the put-back: it wins, and what was moved stays safe under its new name.
    const { folder, file, fsImpl } = setup("{\"broken", BOOT - 30 * MINUTE);
    const racing = {
      ...fsImpl,
      renameSync: (from, to) => { replaceAtomically(from); fs.renameSync(from, to); fs.writeFileSync(from, "newest"); },
    };
    assert.equal(recoverDamagedRecord({ ...common, fsImpl: racing, filePath: file, bootTime: () => BOOT }).recovered, false);
    assert.equal(fs.readFileSync(file, "utf8"), "newest", "a newer file is never overwritten");
    const kept = fs.readdirSync(folder).filter(name => name.includes(".damaged-"));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(folder, kept[0]), "utf8"), HEALTHY, "the bytes that were moved are still there");
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("when the move itself fails the file is left exactly as it was", () => {
  const { folder, file, fsImpl } = setup("{\"broken", BOOT - 30 * MINUTE);
  const failing = { ...fsImpl, renameSync: () => { const error = new Error("denied"); error.code = "EACCES"; throw error; } };
  const result = recoverDamagedRecord({ ...common, fsImpl: failing, filePath: file, bootTime: () => BOOT });
  assert.deepEqual({ recovered: result.recovered, reason: result.reason }, { recovered: false, reason: "move_failed" });
  assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
  fs.rmSync(folder, { recursive: true, force: true });
});
