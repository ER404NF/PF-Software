import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { createProcessOwnershipStore } from "../../src/processOwnershipStore.js";
import { SupervisedProcessGroup } from "../../src/processSupervisor.js";
import { IProxyManager } from "../../src/iproxyManager.js";

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ownership-"));
  return { directory, filePath: path.join(directory, "process-ownership.json"), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function fakeInspector(table = new Map()) {
  return {
    supported: true,
    describe: async pid => table.get(pid) ?? null,
    table,
  };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {};
  return child;
}

const noWait = () => Promise.resolve();

test("a started process is written with its pid, start time, command, ports and owner server", async () => {
  const file = tempFile();
  try {
    const inspector = fakeInspector(new Map([[4121, { pid: 4121, startTime: "Tue Oct 6 20:20:28 2026", command: "/bin/iproxy -u UDID-1 8101:8100" }]]));
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector, owner: { pid: 900, startTime: "Tue Oct 6 20:00:00 2026" }, sleep: noWait });
    const record = await store.record({ kind: "iproxy", udid: "UDID-1", pid: 4121, bin: "iproxy", args: ["-u", "UDID-1", "8101:8100"], ports: [8101] });
    assert.equal(record.unverified, false);
    assert.equal(record.startTime, "Tue Oct 6 20:20:28 2026");
    assert.equal(record.command, "/bin/iproxy -u UDID-1 8101:8100");
    assert.equal(record.ownerServerPid, 900);
    const onDisk = JSON.parse(fs.readFileSync(file.filePath, "utf8"));
    assert.equal(onDisk.processes["iproxy:UDID-1"].pid, 4121);
  } finally { file.cleanup(); }
});

test("without a readable start time the record is unverified (never usable to authorise a signal)", async () => {
  const file = tempFile();
  try {
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector: fakeInspector(), sleep: noWait });
    const record = await store.record({ kind: "wda", udid: "UDID-1", pid: 77, bin: "xcodebuild", args: ["test"] });
    assert.equal(record.unverified, true);
    assert.equal(record.startTime, null);
  } finally { file.cleanup(); }
});

test("release removes the record, but only for the pid it describes", async () => {
  const file = tempFile();
  try {
    const inspector = fakeInspector(new Map([[10, { startTime: "t1", command: "c" }], [11, { startTime: "t2", command: "c" }]]));
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector, sleep: noWait });
    await store.record({ kind: "iproxy", udid: "U", pid: 10, bin: "iproxy", args: [] });
    await store.record({ kind: "iproxy", udid: "U", pid: 11, bin: "iproxy", args: [] }); // restart: new pid replaces the record
    assert.equal(await store.release({ kind: "iproxy", udid: "U", pid: 10 }), false, "a late exit event for the old pid must not delete the new record");
    assert.equal(store.get("iproxy", "U").pid, 11);
    assert.equal(await store.release({ kind: "iproxy", udid: "U", pid: 11 }), true);
    assert.equal(store.get("iproxy", "U"), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file.filePath, "utf8")).processes, {});
  } finally { file.cleanup(); }
});

test("a process that exits while its start time is still being read is never recorded", async () => {
  const file = tempFile();
  try {
    let releaseLookup;
    const inspector = { supported: true, describe: () => new Promise(resolve => { releaseLookup = () => resolve({ startTime: "t", command: "c" }); }) };
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector, sleep: noWait });
    const pending = store.record({ kind: "iproxy", udid: "U", pid: 5, bin: "iproxy", args: [] });
    await store.release({ kind: "iproxy", udid: "U", pid: 5 });
    releaseLookup();
    assert.equal(await pending, null);
    assert.equal(store.get("iproxy", "U"), null);
  } finally { file.cleanup(); }
});

test("a missing ownership file is an empty first run", () => {
  const file = tempFile();
  try {
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector: fakeInspector(), sleep: noWait });
    assert.deepEqual(store.list(), []);
  } finally { file.cleanup(); }
});

test("a malformed ownership file is preserved and blocks use of the store", async () => {
  const file = tempFile();
  try {
    const damaged = "{ not json\nPRIVATE-DATA";
    fs.writeFileSync(file.filePath, damaged);
    const logs = [];
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector: fakeInspector(), sleep: noWait, log: line => logs.push(line) });
    assert.throws(() => store.list(), error => error.code === "PROCESS_OWNERSHIP_STORE_UNAVAILABLE" && !error.message.includes(file.filePath));
    await assert.rejects(
      () => store.record({ kind: "iproxy", udid: "U", pid: 5, bin: "iproxy", args: [] }),
      error => error.code === "PROCESS_OWNERSHIP_STORE_UNAVAILABLE",
    );
    assert.equal(fs.readFileSync(file.filePath, "utf8"), damaged, "the damaged evidence is not overwritten or deleted");
    assert.ok(logs.every(line => !line.includes(file.filePath) && !line.includes("PRIVATE-DATA")));
  } finally { file.cleanup(); }
});

test("an unreadable ownership path is distinct from a missing file", () => {
  const file = tempFile();
  try {
    fs.mkdirSync(file.filePath);
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector: fakeInspector(), sleep: noWait });
    assert.throws(() => store.list(), error => error.code === "PROCESS_OWNERSHIP_STORE_UNAVAILABLE");
    assert.equal(fs.statSync(file.filePath).isDirectory(), true, "the unreadable entry is preserved");
  } finally { file.cleanup(); }
});

test("confirmGone: no record, dead pid and reused pid are proof; a live matching process or 'cannot tell' are not", async () => {
  const file = tempFile();
  try {
    const table = new Map([[10, { startTime: "t1", command: "c" }]]);
    const inspector = fakeInspector(table);
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector, sleep: noWait });
    assert.equal(await store.confirmGone({ kind: "iproxy", udid: "none" }), true);
    await store.record({ kind: "iproxy", udid: "U", pid: 10, bin: "iproxy", args: [] });
    assert.equal(await store.confirmGone({ kind: "iproxy", udid: "U" }), false, "still alive with the same start time");
    table.set(10, { startTime: "t-other", command: "other" });
    assert.equal(await store.confirmGone({ kind: "iproxy", udid: "U" }), true, "pid reused by another process");
    table.delete(10);
    assert.equal(await store.confirmGone({ kind: "iproxy", udid: "U" }), true, "pid no longer exists");
    const unsupported = createProcessOwnershipStore({ filePath: file.filePath, inspector: { supported: false, describe: async () => null }, sleep: noWait });
    assert.equal(await unsupported.confirmGone({ kind: "iproxy", udid: "U" }), false, "an inspector that cannot look proves nothing");
    const unavailable = createProcessOwnershipStore({ filePath: file.filePath, inspector: { supported: true, describe: async () => undefined }, sleep: noWait });
    assert.equal(await unavailable.confirmGone({ kind: "iproxy", udid: "U" }), false, "a failed live inspection preserves the record");
  } finally { file.cleanup(); }
});

// ---- supervisor + manager integration ------------------------------------------------

test("the supervisor records a spawned process and releases it on a confirmed exit", async () => {
  const events = [];
  const children = [];
  const spawn = () => { const child = fakeChild(1000 + children.length); children.push(child); return child; };
  const group = new SupervisedProcessGroup({
    spawn, restartBackoffMs: [5],
    ownership: { onSpawn: info => events.push(["spawn", info.key, info.pid]), onRelease: info => events.push(["release", info.key, info.pid]) },
  });
  assert.equal(group.start("U", "iproxy", ["-u", "U", "8101:8100"]), "started");
  assert.deepEqual(events, [["spawn", "U", 1000]]);
  children[0].emit("exit", 1, null); // crashed: the process is gone, a restart follows
  assert.deepEqual(events[1], ["release", "U", 1000]);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(events[2], ["spawn", "U", 1001], "the restart records its own new pid");
});

test("a deliberate stop releases ownership once the exit is confirmed", async () => {
  const events = [];
  const children = [];
  const spawn = () => { const child = fakeChild(2000); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, ownership: { onSpawn: () => {}, onRelease: info => events.push(info) } });
  group.start("U", "iproxy", []);
  const stopped = group.stop("U");
  children[0].emit("exit", 0, null);
  assert.deepEqual(await stopped, { ok: true });
  assert.ok(events.length >= 1 && events.every(event => event.key === "U" && event.pid === 2000));
});

test("an ownership hook that throws or rejects never disturbs supervision", () => {
  const spawn = () => fakeChild(3000);
  const group = new SupervisedProcessGroup({
    spawn,
    ownership: { onSpawn: () => { throw new Error("disk full"); }, onRelease: () => Promise.reject(new Error("nope")) },
  });
  assert.equal(group.start("U", "iproxy", []), "started");
  assert.equal(group.isRunning("U"), true);
});

test("start() reports what happened: started, running, queued and blocked", async () => {
  const children = [];
  const spawn = () => { const child = fakeChild(4000 + children.length); children.push(child); return child; };
  const group = new SupervisedProcessGroup({ spawn, stopGraceMs: 5, killWaitMs: 5 });
  assert.equal(group.start("U", "iproxy", []), "started");
  assert.equal(group.start("U", "iproxy", []), "running");
  const stopping = group.stop("U");
  assert.equal(group.start("U", "iproxy", []), "queued", "a replacement waits for the pending stop");
  const result = await stopping; // the child never exits → SIGKILL, then the wait times out
  assert.equal(result.ok, false);
  assert.equal(group.start("U", "iproxy", []), "blocked");
  assert.equal(group.getStatus("U").state, "stop_failed");
});

test("a second stop() on a blocked key is not reported as success", async () => {
  const group = new SupervisedProcessGroup({ spawn: () => fakeChild(5000), stopGraceMs: 5, killWaitMs: 5 });
  group.start("U", "iproxy", []);
  assert.equal((await group.stop("U")).ok, false);
  const again = await group.stop("U");
  assert.equal(again?.ok, false);
  assert.equal(group.stop("never-started"), undefined, "stopping something that never ran is still a no-op");
});

test("clearBlockedStop is refused while the old process may be alive and allowed once it is provably gone", async () => {
  const file = tempFile();
  try {
    const table = new Map([[6000, { startTime: "t1", command: "iproxy" }]]);
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector: fakeInspector(table), sleep: noWait });
    const manager = new IProxyManager({ spawn: () => fakeChild(6000), bin: "iproxy", ownershipStore: store });
    manager.group.stopGraceMs = 5;
    manager.group.killWaitMs = 5;
    assert.equal(manager.start({ udid: "UDID-12345678", localPort: 8101 }), "started");
    await new Promise(resolve => setTimeout(resolve, 10));
    await store.flush();
    assert.equal(store.get("iproxy", "UDID-12345678").pid, 6000);
    assert.equal((await manager.stop("UDID-12345678")).ok, false); // never confirms exit
    assert.equal(manager.start({ udid: "UDID-12345678", localPort: 8101 }), "blocked");

    assert.equal(await manager.clearBlockedStop("UDID-12345678"), false, "the process still looks alive");
    assert.equal(manager.getStatus("UDID-12345678").state, "stop_failed");

    table.delete(6000); // the old process is now provably gone
    assert.equal(await manager.clearBlockedStop("UDID-12345678"), true);
    assert.equal(manager.start({ udid: "UDID-12345678", localPort: 8101 }), "started", "blocked → gone → Start works");
  } finally { file.cleanup(); }
});

test("IProxyManager passes the phone, the local ports and the kind to the ownership store", async () => {
  const file = tempFile();
  try {
    const inspector = fakeInspector(new Map([[7000, { startTime: "t", command: "iproxy -u UDID-12345678 8101:8100 9101:9100" }]]));
    const store = createProcessOwnershipStore({ filePath: file.filePath, inspector, sleep: noWait });
    const manager = new IProxyManager({ spawn: () => fakeChild(7000), bin: "iproxy", ownershipStore: store });
    manager.start({ udid: "UDID-12345678", localPort: 8101, mjpegLocalPort: 9101 });
    await new Promise(resolve => setTimeout(resolve, 10));
    await store.flush();
    const record = store.get("iproxy", "UDID-12345678");
    assert.deepEqual(record.ports, [8101, 9101]);
    assert.equal(record.kind, "iproxy");
  } finally { file.cleanup(); }
});
