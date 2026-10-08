const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { shutdownChildren } = require("../shutdown.js");

// A stand-in for a ChildProcess. `obeys` decides whether SIGTERM makes it exit.
function fakeChild({ pid = 4000, obeysTerm = true, obeysKill = true, isGroupLeader = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.isGroupLeader = isGroupLeader;
  child.signals = [];
  child.exit = (signal = "SIGTERM") => { child.signalCode = signal; child.emit("exit", null, signal); };
  child.kill = (signal = "SIGTERM") => {
    child.signals.push(signal);
    if ((signal === "SIGTERM" && obeysTerm) || (signal === "SIGKILL" && obeysKill)) setImmediate(() => child.exit(signal));
    return true;
  };
  return child;
}

const quick = { timeoutMs: 40, forcedWaitMs: 40 };

test("a child that exits on SIGTERM is waited for and never forced", async () => {
  const child = fakeChild();
  const result = await shutdownChildren({ children: [child], ...quick });
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.deepEqual(result, { exited: 1, forced: [] });
});

test("a child that ignores SIGTERM is forced after the wait", async () => {
  const child = fakeChild({ obeysTerm: false });
  const result = await shutdownChildren({ children: [child], ...quick });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result.forced, [4000]);
  assert.equal(result.exited, 1);
});

test("the group kill is used only in the timeout branch, only for a group leader whose handle is still live", async () => {
  const groupKills = [];
  const leader = fakeChild({ pid: 5000, obeysTerm: false, isGroupLeader: true });
  await shutdownChildren({ children: [leader], ...quick, platform: "darwin", killGroup: (pid, signal) => { groupKills.push([pid, signal]); leader.exit("SIGKILL"); } });
  assert.deepEqual(groupKills, [[5000, "SIGKILL"]]);

  // obeys SIGTERM: no group signal at all
  const polite = fakeChild({ pid: 5001, isGroupLeader: true });
  groupKills.length = 0;
  await shutdownChildren({ children: [polite], ...quick, platform: "darwin", killGroup: (pid, signal) => groupKills.push([pid, signal]) });
  assert.deepEqual(groupKills, [], "no group signal after a graceful exit (the child was already reaped)");
});

test("no group kill off POSIX, or for a child that does not lead a group", async () => {
  const groupKills = [];
  const record = (pid, signal) => groupKills.push([pid, signal]);
  const windows = fakeChild({ pid: 6000, obeysTerm: false, isGroupLeader: true });
  await shutdownChildren({ children: [windows], ...quick, platform: "win32", killGroup: record });
  const follower = fakeChild({ pid: 6001, obeysTerm: false, isGroupLeader: false });
  await shutdownChildren({ children: [follower], ...quick, platform: "darwin", killGroup: record });
  assert.deepEqual(groupKills, []);
  assert.deepEqual(windows.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(follower.signals, ["SIGTERM", "SIGKILL"]);
});

test("a child that has already exited is never signalled", async () => {
  const gone = fakeChild();
  gone.exitCode = 0;
  const result = await shutdownChildren({ children: [gone, null, undefined], ...quick });
  assert.deepEqual(gone.signals, []);
  assert.deepEqual(result, { exited: 0, forced: [] });
});

test("several children are stopped together and all are waited for", async () => {
  const children = [fakeChild({ pid: 1 }), fakeChild({ pid: 2, obeysTerm: false }), fakeChild({ pid: 3 })];
  const result = await shutdownChildren({ children, ...quick });
  assert.equal(result.exited, 3);
  assert.deepEqual(result.forced, [2]);
});

test("a process that survives even SIGKILL does not hang the quit", async () => {
  const stubborn = fakeChild({ obeysTerm: false, obeysKill: false });
  const started = Date.now();
  const result = await shutdownChildren({ children: [stubborn], ...quick });
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.exited, 0);
});

test("main.js: quitting waits, relaunch handlers do nothing while shutting down, mode switches wait too", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /app\.on\("before-quit", event => \{[\s\S]*event\?\.preventDefault\?\.\(\)/);
  assert.match(main, /app\.on\("second-instance", \(\) => \{\s*[^\n]*\n\s*if \(shuttingDown\) return;/);
  assert.match(main, /app\.on\("activate", \(\) => \{ if \(shuttingDown\) return;/);
  assert.equal((main.match(/await stopHostServer\(\);/g) || []).length, 2, "both mode switches wait for the old server to stop");
  assert.match(main, /detached: CHILDREN_LEAD_GROUPS/);
});

test("the packaged app and the release check both include the shutdown module", () => {
  const pkg = require("../package.json");
  assert.ok(pkg.build.files.includes("shutdown.js"));
  assert.match(fs.readFileSync(path.join(__dirname, "..", "scripts", "check-release.cjs"), "utf8"), /desktop\/shutdown\.js/);
});
