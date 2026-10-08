const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChildrenStore } = require("../childrenStore.js");
const { recoverOrphans, STILL_CLOSING } = require("../orphanRecovery.js");
const { createProcessInfo, parseStat } = require("../processInfo.js");

const noSleep = () => Promise.resolve();

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "children-"));
  return { filePath: path.join(directory, "desktop-children.json"), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

const SERVER = { pid: 4100, startTime: "Tue Oct 6 19:00:00 2026", command: "/App/Bodun --server-entry /App/system/server/src/index.js", pgid: 4100 };

// A fake operating system for the recovery tests: a table of processes and a recorder for signals.
function fakeWorld(initial = []) {
  const processes = new Map(initial.map(item => [item.pid, { ppid: 1, program: "Bodun", ...item }]));
  const signals = [];
  return {
    processes, signals,
    describe: async pid => processes.get(pid) ?? null,
    kill: (pid, signal) => { signals.push(["pid", pid, signal]); if (world.obey) processes.delete(pid); },
    killGroup: (pid, signal) => { signals.push(["group", pid, signal]); processes.delete(pid); },
    obey: true,
  };
}
let world;

async function storeWith(file, records) {
  const store = createChildrenStore({ filePath: file.filePath, describe: async pid => records.find(item => item.pid === pid), sleep: noSleep });
  for (const record of records) await store.record({ kind: record.kind, pid: record.pid });
  return store;
}

test("records are written at spawn with the start time and exact command, and removed on exit", async () => {
  const file = tempFile();
  try {
    const store = await storeWith(file, [{ ...SERVER, kind: "host-server" }]);
    const [record] = store.list();
    assert.equal(record.pid, 4100);
    assert.equal(record.startTime, SERVER.startTime);
    assert.equal(record.command, SERVER.command);
    assert.equal(record.unverified, false);
    assert.equal(store.remove({ kind: "host-server", pid: 9999 }), false, "another pid's exit does not delete it");
    assert.equal(store.remove({ kind: "host-server", pid: 4100 }), true);
    assert.deepEqual(store.list(), []);
  } finally { file.cleanup(); }
});

test("without a readable start time the record is unverified", async () => {
  const file = tempFile();
  try {
    const store = createChildrenStore({ filePath: file.filePath, describe: async () => null, sleep: noSleep });
    const record = await store.record({ kind: "site-agent", pid: 77 });
    assert.equal(record.unverified, true);
  } finally { file.cleanup(); }
});

test("a missing child ownership file is an empty first run", () => {
  const file = tempFile();
  try {
    const store = createChildrenStore({ filePath: file.filePath, describe: async () => null, sleep: noSleep });
    assert.deepEqual(store.list(), []);
  } finally { file.cleanup(); }
});

test("a malformed child ownership file is preserved and blocks orphan recovery", async () => {
  const file = tempFile();
  try {
    const damaged = "{ not json\nPRIVATE-DATA";
    fs.writeFileSync(file.filePath, damaged);
    const store = createChildrenStore({ filePath: file.filePath, describe: async () => null, sleep: noSleep });
    assert.throws(() => store.list(), error => error.code === "CHILD_OWNERSHIP_STORE_UNAVAILABLE" && !error.message.includes(file.filePath));
    await assert.rejects(
      () => recoverOrphans({ store, describe: async () => null, sleep: noSleep }),
      error => error.code === "CHILD_OWNERSHIP_STORE_UNAVAILABLE",
    );
    assert.equal(fs.readFileSync(file.filePath, "utf8"), damaged);
  } finally { file.cleanup(); }
});

test("an unreadable child ownership path is distinct from a missing file", () => {
  const file = tempFile();
  try {
    fs.mkdirSync(file.filePath);
    const store = createChildrenStore({ filePath: file.filePath, describe: async () => null, sleep: noSleep });
    assert.throws(() => store.list(), error => error.code === "CHILD_OWNERSHIP_STORE_UNAVAILABLE");
    assert.equal(fs.statSync(file.filePath).isDirectory(), true);
  } finally { file.cleanup(); }
});

test("a child that exits while its start time is being read is never recorded", async () => {
  const file = tempFile();
  try {
    let release;
    const store = createChildrenStore({ filePath: file.filePath, describe: () => new Promise(resolve => { release = () => resolve({ startTime: "t", command: "c" }); }), sleep: noSleep });
    const pending = store.record({ kind: "host-server", pid: 5 });
    store.remove({ kind: "host-server", pid: 5 });
    release();
    assert.equal(await pending, null);
    assert.deepEqual(store.list(), []);
  } finally { file.cleanup(); }
});

test("an orphan that is provably Bodun's own is stopped with SIGTERM and its record dropped", async () => {
  const file = tempFile();
  try {
    world = fakeWorld([SERVER]);
    const store = await storeWith(file, [{ ...SERVER, kind: "host-server" }]);
    const summary = await recoverOrphans({ store, describe: world.describe, kill: world.kill, killGroup: world.killGroup, sleep: noSleep, timeoutMs: 1000, pollMs: 250 });
    assert.deepEqual(world.signals, [["pid", 4100, "SIGTERM"]]);
    assert.deepEqual(summary, { terminated: 1, dropped: 1 });
    assert.deepEqual(store.list(), []);
  } finally { file.cleanup(); }
});

test("an orphan that ignores SIGTERM gets a group SIGKILL, after being described again", async () => {
  const file = tempFile();
  try {
    world = fakeWorld([SERVER]);
    world.obey = false;
    const store = await storeWith(file, [{ ...SERVER, kind: "host-server" }]);
    const summary = await recoverOrphans({ store, describe: world.describe, kill: world.kill, killGroup: world.killGroup, sleep: noSleep, timeoutMs: 500, pollMs: 250 });
    assert.deepEqual(world.signals, [["pid", 4100, "SIGTERM"], ["group", 4100, "SIGKILL"]]);
    assert.equal(summary.terminated, 1);
  } finally { file.cleanup(); }
});

test("a pid reused by another process (start time or command differs) is forgotten, never signalled", async () => {
  const file = tempFile();
  try {
    for (const change of [{ startTime: "Wed Oct 7 08:00:00 2026" }, { command: "/usr/bin/some-other-program" }]) {
      world = fakeWorld([{ ...SERVER, ...change }]);
      const store = await storeWith(file, [{ ...SERVER, kind: "host-server" }]);
      const summary = await recoverOrphans({ store, describe: world.describe, kill: world.kill, killGroup: world.killGroup, sleep: noSleep });
      assert.deepEqual(world.signals, []);
      assert.deepEqual(summary, { terminated: 0, dropped: 1 });
    }
  } finally { file.cleanup(); }
});

test("a process that does not lead its own group (pgid differs) is not touched", async () => {
  const file = tempFile();
  try {
    world = fakeWorld([{ ...SERVER, pgid: 1 }]);
    const store = await storeWith(file, [{ ...SERVER, kind: "host-server" }]);
    await recoverOrphans({ store, describe: world.describe, kill: world.kill, killGroup: world.killGroup, sleep: noSleep });
    assert.deepEqual(world.signals, []);
  } finally { file.cleanup(); }
});

test("a live unverified record is preserved and blocks replacement without being signalled", async () => {
  const file = tempFile();
  try {
    world = fakeWorld([SERVER]);
    const store = createChildrenStore({ filePath: file.filePath, describe: async () => null, sleep: noSleep });
    await store.record({ kind: "host-server", pid: 4100 });
    await assert.rejects(
      () => recoverOrphans({ store, describe: world.describe, kill: world.kill, killGroup: world.killGroup, sleep: noSleep }),
      error => error.message === STILL_CLOSING,
    );
    assert.deepEqual(world.signals, []);
    assert.equal(store.list().length, 1);
  } finally { file.cleanup(); }
});

test("an unverified record is dropped only after the pid is confirmed gone", async () => {
  const file = tempFile();
  try {
    const store = createChildrenStore({ filePath: file.filePath, describe: async () => null, sleep: noSleep });
    await store.record({ kind: "host-server", pid: 4100 });
    const summary = await recoverOrphans({ store, describe: async () => null, sleep: noSleep });
    assert.deepEqual(summary, { terminated: 0, dropped: 1 });
    assert.deepEqual(store.list(), []);
  } finally { file.cleanup(); }
});

test("a process that cannot be stopped blocks the launch with a plain message", async () => {
  const file = tempFile();
  try {
    world = fakeWorld([SERVER]);
    world.kill = (pid, signal) => { world.signals.push(["pid", pid, signal]); };
    world.killGroup = (pid, signal) => { world.signals.push(["group", pid, signal]); };
    const store = await storeWith(file, [{ ...SERVER, kind: "host-server" }]);
    await assert.rejects(() => recoverOrphans({ store, describe: world.describe, kill: world.kill, killGroup: world.killGroup, sleep: noSleep, timeoutMs: 250, pollMs: 250 }), error => error.message === STILL_CLOSING);
    assert.equal(store.list().length, 1, "the record stays so the next launch tries again");
    assert.match(STILL_CLOSING, /Wait a minute/);
    assert.doesNotMatch(STILL_CLOSING, /\.js|\/|PF-Software/);
  } finally { file.cleanup(); }
});

test("an unavailable process inspection preserves the ownership record and blocks replacement", async () => {
  const file = tempFile();
  try {
    const store = await storeWith(file, [{ ...SERVER, kind: "host-server" }]);
    await assert.rejects(
      () => recoverOrphans({ store, describe: async () => undefined, sleep: noSleep }),
      error => error.message === STILL_CLOSING,
    );
    assert.equal(store.list().length, 1, "inspection failure proves neither exit nor pid reuse");
  } finally { file.cleanup(); }
});

test("if the leader dies before the group kill, no group signal is sent", async () => {
  const file = tempFile();
  try {
    world = fakeWorld([SERVER]);
    world.obey = false;
    let looks = 0;
    const describe = async pid => { looks += 1; return looks > 2 ? null : world.describe(pid); };
    const store = await storeWith(file, [{ ...SERVER, kind: "host-server" }]);
    await recoverOrphans({ store, describe, kill: world.kill, killGroup: world.killGroup, sleep: noSleep, timeoutMs: 250, pollMs: 250 });
    assert.equal(world.signals.some(signal => signal[0] === "group"), false);
  } finally { file.cleanup(); }
});

test("both the host server and the site agent are handled", async () => {
  const file = tempFile();
  try {
    const agent = { pid: 4200, startTime: "Tue Oct 6 19:05:00 2026", command: "/App/Bodun --agent /App/system/server/src/agentMain.js", pgid: 4200 };
    world = fakeWorld([SERVER, agent]);
    const store = await storeWith(file, [{ ...SERVER, kind: "host-server" }, { ...agent, kind: "site-agent" }]);
    const summary = await recoverOrphans({ store, describe: world.describe, kill: world.kill, killGroup: world.killGroup, sleep: noSleep });
    assert.equal(summary.terminated, 2);
  } finally { file.cleanup(); }
});

test("process info: parsing, three separate ps calls, unsupported platforms", async () => {
  assert.deepEqual(parseStat("    1  742 Tue Oct  6 20:20:28 2026\n"), { ppid: 1, pgid: 742, startTime: "Tue Oct 6 20:20:28 2026" });
  const calls = [];
  const execFile = (bin, args, _options, callback) => {
    calls.push(args.join(" "));
    if (args.includes("ppid=,pgid=,lstart=")) return callback(null, "    1  742 Tue Oct  6 20:20:28 2026\n");
    if (args.includes("comm=")) return callback(null, "/Applications/My App.app/Contents/MacOS/My App\n");
    return callback(null, "/Applications/My App.app/Contents/MacOS/My App --flag\n");
  };
  const info = createProcessInfo({ execFile, platform: "darwin" });
  assert.deepEqual(await info.describe(742), {
    pid: 742, ppid: 1, pgid: 742, startTime: "Tue Oct 6 20:20:28 2026", program: "My App", command: "/Applications/My App.app/Contents/MacOS/My App --flag",
  });
  assert.equal(calls.length, 3);
  assert.equal(await createProcessInfo({ execFile, platform: "win32" }).describe(742), undefined);
  assert.equal(await info.describe(-1), null);
});

test("process info distinguishes a missing process from an unavailable ps inspection", async () => {
  const missing = createProcessInfo({
    platform: "darwin",
    execFile: (_bin, _args, _options, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), ""),
  });
  assert.equal(await missing.describe(742), null);

  const unavailable = createProcessInfo({
    platform: "darwin",
    execFile: (_bin, _args, _options, callback) => callback(Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true }), ""),
  });
  assert.equal(await unavailable.describe(742), undefined);

  const permissionDenied = createProcessInfo({
    platform: "darwin",
    execFile: (_bin, _args, _options, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "permission denied"),
  });
  assert.equal(await permissionDenied.describe(742), undefined);
});
