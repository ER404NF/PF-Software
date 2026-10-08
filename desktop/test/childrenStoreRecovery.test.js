"use strict";

// The desktop's record of the child processes it started (the Bodun server, the site agent): written in a crash-safe order,
// strict about what it will read, and able to move a provably stale damaged record aside (never delete it).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChildrenStore } = require("../childrenStore.js");
const { BOOT_MARGIN_MS } = require("../damagedRecordRecovery.js");

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../../system/server/test/fixtures/damagedRecordCases.json"), "utf8"));
const BOOT = Date.UTC(2026, 9, 7, 8, 0, 0);
const MINUTE = 60_000;
const STORE_UNAVAILABLE = "CHILD_OWNERSHIP_STORE_UNAVAILABLE";
const describeOk = async () => ({ startTime: "t", command: "c" });
const noSleep = () => Promise.resolve();

function tempFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "children-recovery-"));
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

// ---- durable write order ----------------------------------------------------------------------------------

function recordingFs() {
  const ops = [];
  const files = new Map();
  const handles = new Map();
  const pending = new Map();
  let next = 50;
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  return {
    ops, files, constants: fs.constants,
    mkdirSync: () => { ops.push("mkdir"); },
    statSync: file => { if (!files.has(file)) throw missing(); return { isFile: () => true, isDirectory: () => false, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0 }; },
    readFileSync: file => { if (!files.has(file)) throw missing(); return files.get(file); },
    openSync: (target, flags) => { const handle = next++; handles.set(handle, { target, isFolder: flags === "r" }); ops.push(flags === "r" ? "open folder" : "open temp"); return handle; },
    writeFileSync: (handle, data) => { pending.set(handles.get(handle).target, data); ops.push("write"); },
    fsyncSync: handle => { ops.push(handles.get(handle).isFolder ? "flush folder" : "flush file"); },
    closeSync: handle => { ops.push("close"); handles.delete(handle); },
    renameSync: (from, to) => { files.set(to, pending.get(from)); ops.push("rename"); },
    rmSync: () => {},
  };
}

test("a record is written, flushed, renamed into place, and then the folder is flushed - in that order", async () => {
  const fake = recordingFs();
  const store = createChildrenStore({ filePath: "/store/desktop-children.json", describe: describeOk, sleep: noSleep, fsImpl: fake });
  await store.record({ kind: "host-server", pid: 4100 });
  const order = fake.ops.filter(op => ["write", "flush file", "rename", "flush folder"].includes(op));
  assert.deepEqual(order, ["write", "flush file", "rename", "flush folder"]);
  assert.match(fake.files.get("/store/desktop-children.json"), /"host-server"/);
});

test("a folder that cannot be flushed does not undo or fail the write", async () => {
  const fake = recordingFs();
  const open = fake.openSync;
  fake.openSync = (target, flags) => { if (flags === "r") throw Object.assign(new Error("no"), { code: "EISDIR" }); return open(target, flags); };
  const store = createChildrenStore({ filePath: "/store/c.json", describe: describeOk, sleep: noSleep, fsImpl: fake });
  const record = await store.record({ kind: "host-server", pid: 4100 });
  assert.ok(record);
  assert.ok(fake.ops.includes("rename"));
});

test("a write that fails halfway leaves no temporary file behind", async () => {
  const folder = tempFolder();
  const file = path.join(folder, "desktop-children.json");
  const failing = { ...fs, fsyncSync: () => { throw Object.assign(new Error("disk"), { code: "EIO" }); } };
  const store = createChildrenStore({ filePath: file, describe: describeOk, sleep: noSleep, fsImpl: failing });
  await store.record({ kind: "host-server", pid: 4100 });
  assert.deepEqual(fs.readdirSync(folder), []);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("the file is written readable by its owner only", async () => {
  if (process.platform === "win32") return;
  const folder = tempFolder();
  const file = path.join(folder, "desktop-children.json");
  await createChildrenStore({ filePath: file, describe: describeOk, sleep: noSleep }).record({ kind: "host-server", pid: 4100 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(folder, { recursive: true, force: true });
});

// ---- strict reads -------------------------------------------------------------------------------------------

test("every damaged shape blocks with the typed error, says what to do, and leaves the bytes exactly as they were", () => {
  for (const item of fixtures.cases.filter(entry => entry.verdict === "damaged")) {
    const folder = tempFolder();
    const file = path.join(folder, "desktop-children.json");
    const text = item.text.replaceAll("$KEY", "children");
    fs.writeFileSync(file, text);
    const store = createChildrenStore({ filePath: file, describe: describeOk, sleep: noSleep });
    assert.throws(() => store.list(), error => error.code === STORE_UNAVAILABLE && error.reason === "damaged" && !error.message.includes(folder)
      && /Quit Bodun and open it again/.test(error.message), item.name);
    assert.equal(fs.readFileSync(file, "utf8"), text, `${item.name}: bytes untouched`);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("every valid shape reads", () => {
  for (const item of fixtures.cases.filter(entry => entry.verdict === "ok")) {
    const folder = tempFolder();
    const file = path.join(folder, "desktop-children.json");
    fs.writeFileSync(file, item.text.replaceAll("$KEY", "children"));
    assert.doesNotThrow(() => createChildrenStore({ filePath: file, describe: describeOk, sleep: noSleep }).list(), item.name);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("a missing file is an empty first run; a folder in its place is damaged; an unreadable file is unreadable", () => {
  const folder = tempFolder();
  assert.deepEqual(createChildrenStore({ filePath: path.join(folder, "none.json"), describe: describeOk }).list(), []);
  fs.mkdirSync(path.join(folder, "dir.json"));
  assert.throws(() => createChildrenStore({ filePath: path.join(folder, "dir.json"), describe: describeOk }).list(), error => error.reason === "damaged");
  const denied = { ...fs, readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, statSync: () => ({ isFile: () => true }) };
  assert.throws(() => createChildrenStore({ filePath: path.join(folder, "x.json"), describe: describeOk, fsImpl: denied }).list(), error => error.code === STORE_UNAVAILABLE && error.reason === "unreadable");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("record and remove never move a damaged file, even an old one: bookkeeping stays silent and the bytes stay", async () => {
  const folder = tempFolder();
  const file = path.join(folder, "desktop-children.json");
  fs.writeFileSync(file, "{\"broken");
  const store = createChildrenStore({ filePath: file, describe: describeOk, sleep: noSleep, fsImpl: timed(file, { mtimeMs: BOOT - 30 * MINUTE }), bootTime: () => BOOT });
  await store.record({ kind: "host-server", pid: 4100 });
  assert.equal(store.remove({ kind: "host-server", pid: 4100 }), false);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
  fs.rmSync(folder, { recursive: true, force: true });
});

// ---- recover() ----------------------------------------------------------------------------------------------

function damaged(text, times, options = {}) {
  const folder = tempFolder();
  const file = path.join(folder, "desktop-children.json");
  fs.writeFileSync(file, text);
  const logs = [];
  const store = createChildrenStore({
    filePath: file, describe: describeOk, sleep: noSleep, fsImpl: timed(file, times), bootTime: () => BOOT,
    clock: () => BOOT + 60 * MINUTE, randomSuffix: () => "z", log: line => logs.push(line), ...options,
  });
  return { folder, file, store, logs };
}

test("recover() moves a damaged record older than the last start aside, keeps every byte, logs without a path, and the store reads clean", () => {
  const { folder, file, store, logs } = damaged("{\"version\":1,\"children\":{\"host-server\":", { mtimeMs: BOOT - 30 * MINUTE });
  const result = store.recover();
  assert.equal(result.recovered, true);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(file), false);
  const copies = fs.readdirSync(folder).filter(name => name.includes(".damaged-"));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(folder, copies[0]), "utf8"), "{\"version\":1,\"children\":{\"host-server\":");
  for (const line of logs) assert.ok(!line.includes(folder) && !line.includes("desktop-children.json"));
  fs.rmSync(folder, { recursive: true, force: true });
});

test("recover() refuses when the file is newer than the start, inside the margin, exactly on it, or either time is unknown", () => {
  for (const [times, options] of [
    [{ mtimeMs: BOOT + 5 * MINUTE }, {}], [{ mtimeMs: BOOT - 2 * MINUTE }, {}], [{ mtimeMs: BOOT - BOOT_MARGIN_MS }, {}],
    [{ mtimeMs: BOOT - 30 * MINUTE }, { bootTime: () => null }], [{ mtimeMs: BOOT - 30 * MINUTE }, { bootTime: () => { throw new Error("x"); } }],
    [{ mtimeMs: Number.NaN }, {}],
  ]) {
    const { folder, file, store } = damaged("{\"broken", times, options);
    assert.equal(store.recover().recovered, false);
    assert.equal(fs.readFileSync(file, "utf8"), "{\"broken");
    assert.throws(() => store.list(), error => error.code === STORE_UNAVAILABLE);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("recover() never touches a valid file", () => {
  const { folder, file, store } = damaged(JSON.stringify({ version: 1, children: { "host-server": { kind: "host-server", pid: 5 } } }), { mtimeMs: BOOT - 30 * MINUTE });
  assert.equal(store.recover().recovered, false);
  assert.equal(store.list().length, 1);
  assert.equal(fs.existsSync(file), true);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("health() says whether the record is intact, was moved aside, or is damaged", () => {
  const good = damaged(JSON.stringify({ version: 1, children: {} }), { mtimeMs: BOOT - 30 * MINUTE });
  assert.equal(good.store.health(), "intact");
  const moved = damaged("{", { mtimeMs: BOOT - 30 * MINUTE });
  moved.store.recover();
  assert.equal(moved.store.health(), "moved aside");
  const bad = damaged("{", { mtimeMs: BOOT + MINUTE });
  bad.store.recover();
  assert.equal(bad.store.health(), "damaged");
  for (const item of [good, moved, bad]) fs.rmSync(item.folder, { recursive: true, force: true });
});
