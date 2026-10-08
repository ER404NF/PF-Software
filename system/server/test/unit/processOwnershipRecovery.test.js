import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProcessOwnershipStore } from "../../src/processOwnershipStore.js";
import { BOOT_MARGIN_MS } from "../../src/damagedRecordRecovery.js";

// The process-ownership record must (a) reach the disk in a crash-safe order, (b) tell a damaged file from an unreadable one,
// (c) be re-readable from disk on demand, and (d) be moved aside automatically only when that is provably safe.

const fixtures = JSON.parse(fs.readFileSync(new URL("../fixtures/damagedRecordCases.json", import.meta.url), "utf8"));
const BOOT = Date.UTC(2026, 9, 7, 8, 0, 0);
const MINUTE = 60_000;
const STORE_UNAVAILABLE = "PROCESS_OWNERSHIP_STORE_UNAVAILABLE";

function tempFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ownership-recovery-"));
}

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

const noInspector = { supported: true, describe: async () => null };

// ---- (a) durable write order -------------------------------------------------------------------------

function recordingFs() {
  const ops = [];
  const files = new Map();
  const handles = new Map();
  let nextHandle = 50;
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const fake = {
    ops, files,
    constants: fs.constants,
    mkdirSync: () => { ops.push("mkdir"); },
    statSync: file => {
      if (!files.has(file)) throw missing();
      return { isFile: () => true, isDirectory: () => false, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0 };
    },
    readFileSync: file => { if (!files.has(file)) throw missing(); return files.get(file); },
    openSync: (target, flags) => {
      const handle = nextHandle++;
      const isFolder = flags === "r";
      handles.set(handle, { target, isFolder });
      ops.push(isFolder ? "open folder" : "open temp");
      return handle;
    },
    writeFileSync: (handle, data) => { handles.get(handle).data = data; ops.push("write"); },
    fsyncSync: handle => { ops.push(handles.get(handle).isFolder ? "flush folder" : "flush file"); },
    closeSync: handle => { ops.push("close"); handles.delete(handle); },
    renameSync: (from, to) => {
      const entry = [...handles.values()].find(item => item.target === from);
      files.set(to, entry?.data ?? fake._pending.get(from));
      ops.push("rename");
    },
    rmSync: () => {},
    _pending: new Map(),
  };
  const open = fake.openSync;
  fake.openSync = (target, flags) => {
    const handle = open(target, flags);
    return handle;
  };
  // the data written to the temporary file is what the rename publishes
  const write = fake.writeFileSync;
  fake.writeFileSync = (handle, data) => { fake._pending.set(handles.get(handle).target, data); write(handle, data); };
  return fake;
}

test("a record is written, flushed, renamed into place, and then the folder is flushed - in that order", async () => {
  const fake = recordingFs();
  const store = createProcessOwnershipStore({ filePath: "/store/process-ownership.json", inspector: { supported: true, describe: async () => ({ startTime: "t", command: "c" }) }, fsImpl: fake, sleep: async () => {} });
  await store.record({ kind: "iproxy", udid: "U", pid: 5, bin: "iproxy", args: ["-u", "U"] });
  await store.flush();
  const order = fake.ops.filter(op => ["write", "flush file", "rename", "flush folder"].includes(op));
  assert.deepEqual(order, ["write", "flush file", "rename", "flush folder"]);
  assert.ok(fake.ops.indexOf("write") < fake.ops.indexOf("flush file"));
  assert.ok(fake.ops.indexOf("flush file") < fake.ops.indexOf("rename"), "the data is on disk before the name is published");
  assert.ok(fake.ops.indexOf("rename") < fake.ops.indexOf("flush folder"));
  assert.match(fake.files.get("/store/process-ownership.json"), /"udid": "U"/);
});

test("a folder that cannot be flushed (some systems cannot open one) does not undo or fail the write", async () => {
  const fake = recordingFs();
  const open = fake.openSync;
  fake.openSync = (target, flags) => { if (flags === "r") throw Object.assign(new Error("cannot open a folder"), { code: "EISDIR" }); return open(target, flags); };
  const logs = [];
  const store = createProcessOwnershipStore({ filePath: "/store/p.json", inspector: { supported: true, describe: async () => ({ startTime: "t", command: "c" }) }, fsImpl: fake, sleep: async () => {}, log: line => logs.push(line) });
  await store.record({ kind: "iproxy", udid: "U", pid: 5, bin: "iproxy", args: [] });
  await store.flush();
  assert.ok(fake.ops.includes("rename"));
  assert.deepEqual(logs, [], "no failure is reported for a best-effort folder flush");
});

test("a write that fails halfway leaves no temporary file behind and the failure is logged without a path", async () => {
  const folder = tempFolder();
  const file = path.join(folder, "process-ownership.json");
  const failing = { ...fs, fsyncSync: () => { throw Object.assign(new Error("disk"), { code: "EIO" }); } };
  const logs = [];
  const store = createProcessOwnershipStore({ filePath: file, inspector: { supported: true, describe: async () => ({ startTime: "t", command: "c" }) }, fsImpl: failing, sleep: async () => {}, log: line => logs.push(line) });
  await store.record({ kind: "iproxy", udid: "U", pid: 5, bin: "iproxy", args: [] });
  await store.flush();
  assert.deepEqual(fs.readdirSync(folder), [], "neither the record nor a temporary file");
  assert.ok(logs.some(line => /could not be written/.test(line)));
  for (const line of logs) assert.ok(!line.includes(folder), "no path in a log line");
  fs.rmSync(folder, { recursive: true, force: true });
});

// ---- (b) strict reads: typed errors, untouched bytes, no leak ----------------------------------------------

test("every damaged shape blocks with the typed error, says it is damaged, and leaves the bytes exactly as they were", () => {
  for (const item of fixtures.cases.filter(entry => entry.verdict === "damaged")) {
    const folder = tempFolder();
    const file = path.join(folder, "process-ownership.json");
    const text = item.text.replaceAll("$KEY", "processes");
    fs.writeFileSync(file, text);
    const logs = [];
    const store = createProcessOwnershipStore({ filePath: file, inspector: noInspector, log: line => logs.push(line) });
    assert.throws(() => store.list(), error => error.code === STORE_UNAVAILABLE && error.reason === "damaged" && !error.message.includes(folder), item.name);
    assert.equal(fs.readFileSync(file, "utf8"), text, `${item.name}: bytes untouched`);
    for (const line of logs) assert.ok(!line.includes(folder) && !line.includes("PRIVATE"), `${item.name}: no leak`);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("a folder in the record's place is damaged (needs a person) and an unreadable file is unreadable (may fix itself)", () => {
  const folder = tempFolder();
  const file = path.join(folder, "process-ownership.json");
  fs.mkdirSync(file);
  assert.throws(() => createProcessOwnershipStore({ filePath: file, inspector: noInspector }).list(), error => error.reason === "damaged");
  const denied = { ...fs, readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, statSync: () => ({ isFile: () => true }) };
  assert.throws(() => createProcessOwnershipStore({ filePath: path.join(folder, "x.json"), inspector: noInspector, fsImpl: denied }).list(), error => error.code === STORE_UNAVAILABLE && error.reason === "unreadable");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("the error message says what to do and carries no path", () => {
  const folder = tempFolder();
  const file = path.join(folder, "process-ownership.json");
  fs.writeFileSync(file, "{");
  try {
    createProcessOwnershipStore({ filePath: file, inspector: noInspector }).list();
    assert.fail("expected the store to refuse");
  } catch (error) {
    assert.match(error.message, /Quit Bodun and open it again/);
    assert.match(error.message, /move the damaged record aside/);
    assert.ok(!error.message.includes(folder));
  }
  fs.rmSync(folder, { recursive: true, force: true });
});

// ---- (c) reload --------------------------------------------------------------------------------------------

test("reload re-reads the file, so a record another session wrote is seen and a stale snapshot is never kept", async () => {
  const folder = tempFolder();
  const file = path.join(folder, "process-ownership.json");
  const store = createProcessOwnershipStore({ filePath: file, inspector: noInspector });
  assert.deepEqual(store.list(), []);
  fs.writeFileSync(file, JSON.stringify({ version: 1, processes: { "iproxy:U": { kind: "iproxy", udid: "U", pid: 9 } } }));
  assert.deepEqual(store.list(), [], "the cache still holds the old answer");
  store.reload();
  assert.equal(store.list().length, 1);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a reload that finds damage throws the typed error", () => {
  const folder = tempFolder();
  const file = path.join(folder, "process-ownership.json");
  const store = createProcessOwnershipStore({ filePath: file, inspector: noInspector });
  store.list();
  fs.writeFileSync(file, "{");
  assert.throws(() => store.reload(), error => error.code === STORE_UNAVAILABLE && error.reason === "damaged");
  fs.rmSync(folder, { recursive: true, force: true });
});

// ---- (d) automatic recovery --------------------------------------------------------------------------------

function damagedStore(text, times, options = {}) {
  const folder = tempFolder();
  const file = path.join(folder, "process-ownership.json");
  fs.writeFileSync(file, text);
  const logs = [];
  const store = createProcessOwnershipStore({
    filePath: file, inspector: noInspector, fsImpl: timed(file, times), bootTime: () => BOOT, clock: () => BOOT + 60 * MINUTE,
    randomSuffix: () => "z", log: line => logs.push(line), ...options,
  });
  return { folder, file, store, logs };
}

test("reload with recovery moves a damaged record that is older than the last start aside and then reads clean", () => {
  const { folder, file, store, logs } = damagedStore("{\"version\":1,\"processes\":{\"iproxy:U\":", { mtimeMs: BOOT - 30 * MINUTE });
  const result = store.reload({ recover: true });
  assert.equal(result.recovered, true);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(file), false);
  const copies = fs.readdirSync(folder).filter(name => name.includes(".damaged-"));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(folder, copies[0]), "utf8"), "{\"version\":1,\"processes\":{\"iproxy:U\":");
  for (const line of logs) assert.ok(!line.includes(folder) && !line.includes("process-ownership.json"));
  fs.rmSync(folder, { recursive: true, force: true });
});

test("the same record can be written again after recovery", async () => {
  const { folder, file, store } = damagedStore("{", { mtimeMs: BOOT - 30 * MINUTE }, { inspector: { supported: true, describe: async () => ({ startTime: "t", command: "c" }) }, sleep: async () => {} });
  store.reload({ recover: true });
  await store.record({ kind: "iproxy", udid: "U", pid: 5, bin: "iproxy", args: [] });
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).processes["iproxy:U"].pid, 5);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("newer than the last start, inside the margin, exactly on the margin: no recovery, bytes untouched, still blocked", () => {
  for (const mtimeMs of [BOOT + 5 * MINUTE, BOOT - 2 * MINUTE, BOOT - BOOT_MARGIN_MS]) {
    const { folder, file, store } = damagedStore("{\"broken", { mtimeMs });
    assert.throws(() => store.reload({ recover: true }), error => error.code === STORE_UNAVAILABLE && error.reason === "damaged");
    assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("one millisecond past the margin is recovered", () => {
  const { folder, store } = damagedStore("{\"broken", { mtimeMs: BOOT - BOOT_MARGIN_MS - 1 });
  assert.equal(store.reload({ recover: true }).recovered, true);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("start time unknown, or the file's time unknown: no recovery", () => {
  for (const options of [{ bootTime: () => null }, { bootTime: () => { throw new Error("no clock"); } }]) {
    const { folder, file, store } = damagedStore("{\"broken", { mtimeMs: BOOT - 30 * MINUTE }, options);
    assert.throws(() => store.reload({ recover: true }), error => error.code === STORE_UNAVAILABLE);
    assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
    fs.rmSync(folder, { recursive: true, force: true });
  }
  const { folder, file, store } = damagedStore("{\"broken", { mtimeMs: Number.NaN });
  assert.throws(() => store.reload({ recover: true }), error => error.code === STORE_UNAVAILABLE);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a valid file is never moved, even when it is old", () => {
  const { folder, file, store } = damagedStore(JSON.stringify({ version: 1, processes: { "iproxy:U": { kind: "iproxy", udid: "U", pid: 3 } } }), { mtimeMs: BOOT - 30 * MINUTE });
  const result = store.reload({ recover: true });
  assert.equal(result.recovered, false);
  assert.equal(store.list().length, 1);
  assert.equal(fs.existsSync(file), true);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("recovery happens only in reload with recovery asked for: ordinary reads and writes never move a file", async () => {
  const { folder, file, store } = damagedStore("{\"broken", { mtimeMs: BOOT - 30 * MINUTE });
  assert.throws(() => store.list(), error => error.code === STORE_UNAVAILABLE);
  await assert.rejects(() => store.record({ kind: "iproxy", udid: "U", pid: 5, bin: "iproxy", args: [] }), error => error.code === STORE_UNAVAILABLE);
  assert.throws(() => store.reload(), error => error.code === STORE_UNAVAILABLE);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
  fs.rmSync(folder, { recursive: true, force: true });
});
