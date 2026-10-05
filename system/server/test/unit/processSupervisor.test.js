import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { SupervisedProcessGroup } from "../../src/processSupervisor.js";

// A fake child_process.ChildProcess-like object the test controls by hand.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test("start spawns exactly once per key and records the call", () => {
  const spawned = [];
  const children = [];
  const spawn = (bin, args) => {
    spawned.push([bin, args]);
    const child = fakeChild();
    children.push(child);
    return child;
  };
  const group = new SupervisedProcessGroup({ spawn });
  group.start("udid-1", "iproxy", ["-u", "udid-1", "8101:8100"]);
  group.start("udid-1", "iproxy", ["-u", "udid-1", "8101:8100"]); // already running — no-op
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0], ["iproxy", ["-u", "udid-1", "8101:8100"]]);
  assert.equal(group.isRunning("udid-1"), true);
});

// wdaProcessManager.js relies on this to pass WDA's MJPEG tuning env vars
// (production-readiness audit §5) — without it, `start()` had no way at all
// to hand extra environment to the spawned process; it silently inherited
// only process.env every time.
test("an optional env is merged over process.env for the spawned process, and reused across restarts", () => {
  const calls = [];
  const spawn = (bin, args, options) => { calls.push(options); return fakeChild(); };
  const group = new SupervisedProcessGroup({ spawn, restartBackoffMs: [10] });
  group.start("udid-1", "xcodebuild", ["test"], { CUSTOM_VAR: "tuned" });
  assert.equal(calls[0].env.CUSTOM_VAR, "tuned");
  assert.equal(calls[0].env.PATH, process.env.PATH, "must still inherit the rest of the real environment");
});

test("stdout/stderr are captured into a bounded log ring", () => {
  let child;
  const spawn = () => { child = fakeChild(); return child; };
  const group = new SupervisedProcessGroup({ spawn, logRingSize: 3 });
  group.start("udid-1", "bin", []);
  for (const line of ["a", "b", "c", "d"]) child.stdout.emit("data", Buffer.from(line));
  assert.deepEqual(group.getLog("udid-1"), ["b", "c", "d"]);
});

test("an unexpected exit restarts after the configured backoff, not instantly", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, restartBackoffMs: [10] });
  const exits = [];
  group.on("exit", (event) => exits.push(event));
  group.start("udid-1", "bin", ["x"]);
  children[0].emit("exit", 1, null);
  assert.equal(exits.length, 1);
  assert.equal(children.length, 1); // not yet restarted
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(children.length, 2); // restarted after backoff
});

test("a spawn error without an exit event still retries and reaches the restart limit", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, restartBackoffMs: [5] });
  let limitEvent = null;
  group.on("restart-limit-exceeded", event => { limitEvent = event; });
  group.start("udid-1", "missing-binary", []);

  // Node emits `error` but no `exit` when the executable cannot be found.
  children[0].emit("error", Object.assign(new Error("spawn missing-binary ENOENT"), { code: "ENOENT" }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(children.length, 2, "the missing executable is retried after backoff");
  children[1].emit("error", Object.assign(new Error("spawn missing-binary ENOENT"), { code: "ENOENT" }));

  assert.ok(limitEvent, "the permanent failure is surfaced after retries are exhausted");
  assert.equal(group.isRunning("udid-1"), false);
  assert.match(group.getLog("udid-1").join("\n"), /ENOENT/);
});

test("an exit listener can stop supervision before retry or restart-limit handling", () => {
  let child;
  const group = new SupervisedProcessGroup({
    spawn: () => { child = fakeChild(); return child; },
    restartBackoffMs: [],
  });
  let limitEvents = 0;
  group.on("exit", ({ key }) => group.stop(key));
  group.on("restart-limit-exceeded", () => { limitEvents += 1; });
  group.start("udid-1", "bin", []);

  child.emit("exit", 1, null);

  assert.equal(group.isRunning("udid-1"), false);
  assert.equal(limitEvents, 0, "a classified/manual stop must not be overwritten by the generic limit state");
});

test("stop() is terminal — no restart follows a deliberate stop", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, restartBackoffMs: [5] });
  group.start("udid-1", "bin", []);
  group.stop("udid-1");
  assert.equal(children[0].killed, true);
  assert.equal(group.isRunning("udid-1"), false);
  children[0].emit("exit", 0, null); // a late exit event from the killed process
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(children.length, 1); // still no restart
});

test("a replacement waits for the old process to exit before reusing its ports", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, stopGraceMs: 1000 });
  group.start("udid-1", "iproxy", ["8101:8100"]);

  group.stop("udid-1");
  group.start("udid-1", "iproxy", ["8101:8100"]);
  assert.equal(children.length, 1, "replacement must not race the old process's port cleanup");

  children[0].emit("exit", 0, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 2);
});

test("a detach cancels a replacement that was waiting for the old process to exit", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, stopGraceMs: 1000 });
  group.start("udid-1", "iproxy", ["8101:8100"]);

  group.stop("udid-1");
  group.start("udid-1", "iproxy", ["8101:8100"]);
  group.stop("udid-1");
  children[0].emit("exit", 0, null);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(children.length, 1, "a detached phone must not gain an orphaned deferred tunnel");
  assert.equal(group.isRunning("udid-1"), false);
});

test("restart-limit-exceeded fires once the backoff schedule is exhausted", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, restartBackoffMs: [5, 5] });
  let limitEvent = null;
  group.on("restart-limit-exceeded", (event) => { limitEvent = event; });
  group.start("udid-1", "bin", []);
  children[0].emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  children[1].emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  children[2].emit("exit", 1, null); // third failure — backoff schedule (length 2) is exhausted
  assert.ok(limitEvent);
  assert.equal(limitEvent.key, "udid-1");
  assert.equal(children.length, 3);
  // A caller like a health-check loop depends on this to detect a
  // permanently-dead process, not just "between restarts".
  assert.equal(group.isRunning("udid-1"), false);
});

test("getLog() still works after restart-limit-exceeded, for post-mortem diagnostics", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, restartBackoffMs: [5] });
  group.start("udid-1", "bin", []);
  children[0].emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  children[1].stderr.emit("data", Buffer.from("fatal error"));
  children[1].emit("exit", 1, null); // exhausts the backoff schedule (length 1)
  assert.equal(group.isRunning("udid-1"), false);
  assert.deepEqual(group.getLog("udid-1"), ["fatal error"]);
});

test("exit classification receives only the current launch log while getLog keeps bounded history", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, restartBackoffMs: [5], logRingSize: 10 });
  const exitLogs = [];
  group.on("exit", event => exitLogs.push(event.log));
  group.start("udid-1", "xcodebuild", []);

  children[0].stderr.emit("data", Buffer.from("Signing requires a development team"));
  children[0].emit("exit", 1, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  children[1].stderr.emit("data", Buffer.from("Lost connection to the phone"));
  children[1].emit("exit", 1, null);

  assert.deepEqual(exitLogs, [
    ["Signing requires a development team"],
    ["Lost connection to the phone"],
  ]);
  assert.deepEqual(group.getLog("udid-1"), [
    "Signing requires a development team",
    "Lost connection to the phone",
  ]);
});

test("indefinite supervision keeps retrying at the capped delay instead of requiring a manual click", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({
    spawn,
    restartBackoffMs: [5],
    retryIndefinitely: true,
  });
  let limitEvents = 0;
  const persistentFailures = [];
  group.on("restart-limit-exceeded", () => { limitEvents += 1; });
  group.on("persistent-failure", event => persistentFailures.push(event));
  group.start("udid-1", "xcodebuild", []);

  children[0].emit("exit", 1, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  children[1].emit("exit", 1, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  children[2].emit("exit", 1, null);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(children.length, 4);
  assert.equal(limitEvents, 0);
  assert.equal(persistentFailures.length, 1, "the capped retry loop must be visible without stopping recovery");
  assert.equal(persistentFailures[0].key, "udid-1");
  assert.equal(group.getStatus("udid-1").state, "running");
});

test("a stable run resets old restart failures before a later crash", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, restartBackoffMs: [5], stableRunMs: 15 });
  let limitEvents = 0;
  group.on("restart-limit-exceeded", () => { limitEvents += 1; });
  group.start("udid-1", "bin", []);
  children[0].emit("exit", 1, null);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(children.length, 2);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(group.getStatus("udid-1").restartCount, 0);
  children[1].emit("exit", 1, null);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(children.length, 3, "a crash after stability receives a fresh retry budget");
  assert.equal(limitEvents, 0);
});
