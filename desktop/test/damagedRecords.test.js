"use strict";

// The launch-time check and the "Move Aside Damaged Process Records" action: what is moved, when it refuses, what it says.
// It moves, never deletes; it refuses while Bodun's own server or site agent is running; every sentence is plain.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  checkRecordsAtLaunch, moveAsideDamagedRecords, confirmationDialog, refusalDialog, nothingFoundDialog, doneDialog, DIALOG_TEXT,
} = require("../damagedRecords.js");

const BOOT = Date.UTC(2026, 9, 7, 8, 0, 0);
const MINUTE = 60_000;

function folder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "damaged-records-"));
}

function timed(file, mtimeMs) {
  return {
    ...fs,
    statSync: target => {
      const real = fs.statSync(target);
      return path.resolve(String(target)) === path.resolve(file)
        ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { mtimeMs, ctimeMs: mtimeMs, birthtimeMs: mtimeMs })
        : real;
    },
  };
}

function files(dir) {
  return [
    { id: "children", label: "the record of Bodun's own server and site agent", filePath: path.join(dir, "desktop-children.json"), key: "children" },
    { id: "ownership", label: "the record of the phone processes", filePath: path.join(dir, "process-ownership.json"), key: "processes" },
  ];
}

const GOOD = { children: JSON.stringify({ version: 1, children: {} }), processes: JSON.stringify({ version: 1, processes: {} }) };

// ---- the launch check -----------------------------------------------------------------------------------------

test("at launch, a damaged record older than the last start is moved aside by itself and nobody is asked", () => {
  const dir = folder();
  const [children, ownership] = files(dir);
  fs.writeFileSync(children.filePath, "{");
  fs.writeFileSync(ownership.filePath, GOOD.processes);
  const lines = [];
  const outcome = checkRecordsAtLaunch({
    files: [children, ownership], fsImpl: timed(children.filePath, BOOT - 30 * MINUTE), bootTime: () => BOOT, now: () => BOOT + 60 * MINUTE,
    randomSuffix: () => "q", log: line => lines.push(line),
  });
  assert.deepEqual(outcome.needsPerson, []);
  assert.equal(outcome.recovered.length, 1);
  assert.equal(outcome.recovered[0].id, "children");
  assert.equal(fs.existsSync(children.filePath), false);
  assert.equal(fs.existsSync(ownership.filePath), true, "a valid record is never touched");
  for (const line of lines) assert.ok(!line.includes(dir), "no path in a log line");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("at launch, a damaged record that cannot be proven stale is left untouched and reported as needing a person", () => {
  const dir = folder();
  const [children, ownership] = files(dir);
  fs.writeFileSync(children.filePath, "{broken");
  fs.writeFileSync(ownership.filePath, "");
  const outcome = checkRecordsAtLaunch({ files: [children, ownership], fsImpl: fs, bootTime: () => null });
  assert.deepEqual(outcome.needsPerson.map(item => item.id), ["children", "ownership"]);
  assert.equal(fs.readFileSync(children.filePath, "utf8"), "{broken");
  assert.equal(fs.readFileSync(ownership.filePath, "utf8"), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("at launch, a folder in a record's place needs a person; a missing record and a valid record need nobody", () => {
  const dir = folder();
  const [children, ownership] = files(dir);
  fs.mkdirSync(children.filePath);
  const outcome = checkRecordsAtLaunch({ files: [children, ownership], fsImpl: fs, bootTime: () => BOOT });
  assert.deepEqual(outcome.needsPerson.map(item => item.id), ["children"]);
  fs.writeFileSync(ownership.filePath, GOOD.processes);
  assert.deepEqual(checkRecordsAtLaunch({ files: [ownership], fsImpl: fs, bootTime: () => BOOT }).needsPerson, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the menu action ------------------------------------------------------------------------------------------

test("it refuses while Bodun's own server or site agent is running, and changes nothing", () => {
  const dir = folder();
  const [children] = files(dir);
  fs.writeFileSync(children.filePath, "{");
  for (const running of [{ isServerRunning: () => true, isAgentRunning: () => false }, { isServerRunning: () => false, isAgentRunning: () => true }]) {
    const result = moveAsideDamagedRecords({ files: [children], fsImpl: fs, ...running });
    assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "running" });
  }
  assert.equal(fs.readFileSync(children.filePath, "utf8"), "{");
  assert.deepEqual(fs.readdirSync(dir), ["desktop-children.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("it moves every damaged record aside, keeps every byte, deletes nothing, and leaves valid records alone", () => {
  const dir = folder();
  const [children, ownership] = files(dir);
  fs.writeFileSync(children.filePath, "{\"version\":1,\"chil");
  fs.writeFileSync(ownership.filePath, GOOD.processes);
  const third = { id: "extra", label: "x", filePath: path.join(dir, "third.json"), key: "processes" };
  fs.writeFileSync(third.filePath, "null");
  const result = moveAsideDamagedRecords({
    files: [children, ownership, third], fsImpl: fs, isServerRunning: () => false, isAgentRunning: () => false, now: () => BOOT, randomSuffix: () => "r",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.moved.map(item => item.id).sort(), ["children", "extra"]);
  assert.deepEqual(result.skipped, []);
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.filter(name => name.includes(".damaged-")).length, 2);
  assert.ok(names.includes("process-ownership.json"));
  const copy = names.find(name => name.startsWith("desktop-children.json.damaged-"));
  assert.equal(fs.readFileSync(path.join(dir, copy), "utf8"), "{\"version\":1,\"chil");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a folder in a record's place is moved aside with what is inside it", () => {
  const dir = folder();
  const [children] = files(dir);
  fs.mkdirSync(children.filePath);
  fs.writeFileSync(path.join(children.filePath, "inside.txt"), "keep");
  const result = moveAsideDamagedRecords({ files: [children], fsImpl: fs, isServerRunning: () => false, isAgentRunning: () => false, now: () => BOOT, randomSuffix: () => "s" });
  assert.equal(result.ok, true);
  const moved = fs.readdirSync(dir).find(name => name.includes(".damaged-"));
  assert.equal(fs.readFileSync(path.join(dir, moved, "inside.txt"), "utf8"), "keep");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unreadable record is reported and not moved", () => {
  const dir = folder();
  const [children] = files(dir);
  fs.writeFileSync(children.filePath, "{");
  const denied = { ...fs, readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  const result = moveAsideDamagedRecords({ files: [children], fsImpl: denied, isServerRunning: () => false, isAgentRunning: () => false });
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.skipped.map(item => [item.id, item.status]), [["children", "unreadable"]]);
  assert.equal(fs.existsSync(children.filePath), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with nothing damaged there is nothing to move", () => {
  const dir = folder();
  const [children, ownership] = files(dir);
  fs.writeFileSync(ownership.filePath, GOOD.processes);
  const result = moveAsideDamagedRecords({ files: [children, ownership], fsImpl: fs, isServerRunning: () => false, isAgentRunning: () => false });
  assert.deepEqual({ ok: result.ok, moved: result.moved.length, skipped: result.skipped.length }, { ok: true, moved: 0, skipped: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the words ------------------------------------------------------------------------------------------------

test("the confirmation says what it does, defaults to Cancel, and warns about a force-quit moments ago", () => {
  const dialog = confirmationDialog([{ id: "children", label: "the record of Bodun's own server" }]);
  assert.deepEqual([...dialog.buttons], ["Cancel", "Move aside"]);
  assert.equal(dialog.defaultId, 0);
  assert.equal(dialog.cancelId, 0);
  assert.match(dialog.detail, /moves the damaged record to a safe copy next to it/i);
  assert.match(dialog.detail, /Nothing is deleted/);
  assert.match(dialog.detail, /restarting this Mac first is the safest choice/);
  assert.match(dialog.detail, /may still need to be closed by hand/);
  assert.match(dialog.detail, /the record of Bodun's own server/);
});

test("the refusal says what to do; the done message offers Restart now; every sentence is plain", () => {
  assert.match(refusalDialog().detail, /Quit Bodun and open it again/);
  assert.match(refusalDialog().detail, /offer to move the damaged record aside/);
  assert.deepEqual([...doneDialog().buttons], ["Restart now", "Later"]);
  assert.match(nothingFoundDialog().message, /No damaged process records were found/);
  const everything = JSON.stringify([confirmationDialog([{ label: "a record" }]), refusalDialog(), nothingFoundDialog(), doneDialog(), DIALOG_TEXT]);
  assert.doesNotMatch(everything, /[A-Za-z]:\\|\/Users\/|\.json|\bpid\b|ENOENT|sysctl/i, "no path, file name or technical word");
});
