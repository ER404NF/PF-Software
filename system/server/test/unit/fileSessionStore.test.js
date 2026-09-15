import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { FileSessionStore } from "../../src/fileSessionStore.js";

let dir;
let store;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-sessions-"));
  store = new FileSessionStore(dir);
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function set(sid, data) {
  return new Promise((resolve, reject) => store.set(sid, data, (err) => (err ? reject(err) : resolve())));
}
function get(sid) {
  return new Promise((resolve, reject) => store.get(sid, (err, data) => (err ? reject(err) : resolve(data))));
}
function destroy(sid) {
  return new Promise((resolve, reject) => store.destroy(sid, (err) => (err ? reject(err) : resolve())));
}

test("set then get round-trips the session data", async () => {
  await set("sid-abc123", { operator: { username: "va1" }, cookie: {} });
  const data = await get("sid-abc123");
  assert.deepEqual(data, { operator: { username: "va1" }, cookie: {} });
});

test("get on an unknown session id returns null, not an error", async () => {
  const data = await get("sid-never-existed");
  assert.equal(data, null);
});

test("destroy removes the session; a later get returns null", async () => {
  await set("sid-to-destroy", { cookie: {} });
  await destroy("sid-to-destroy");
  assert.equal(await get("sid-to-destroy"), null);
});

test("destroying an already-gone session does not error", async () => {
  await assert.doesNotReject(() => destroy("sid-was-never-set"));
});

test("an expired session (cookie.expires in the past) is treated as gone", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  await set("sid-expired", { cookie: { expires: past } });
  assert.equal(await get("sid-expired"), null);
});

test("a session with a future expiry is still returned", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  await set("sid-future", { cookie: { expires: future }, operator: { username: "va1" } });
  const data = await get("sid-future");
  assert.equal(data.operator.username, "va1");
});

test("an unsafe session id is rejected rather than used as a file path", async () => {
  await assert.rejects(() => set("../../escape", { cookie: {} }));
  assert.equal(await get("../../escape"), null);
  await assert.doesNotReject(() => destroy("../../escape"));
});

test("a get() racing a concurrent set() on the same session never sees a torn/corrupted file", async () => {
  // Regression guard for a real bug: fs.writeFile is not atomic (truncate,
  // then write), so a get() landing mid-write used to be able to read a
  // torn/empty file, fail JSON.parse, and come back as null — indistinguish-
  // able from "not logged in" for a perfectly valid session. This went
  // unnoticed until client/app.js's MS6.3 status pane became the first code
  // path to fire concurrent authenticated requests for the same session
  // (Promise.all against /api/queue and /api/audit). Fixed via a temp-file
  // + rename in fileSessionStore.js's set(). A single round rarely hits the
  // (very small) old race window, so this repeats many rounds — under the
  // old implementation this failed intermittently across runs; it must
  // never fail now.
  const sid = "sid-race";
  await set(sid, { operator: { username: "va1" }, cookie: {}, n: -1 });

  for (let round = 0; round < 100; round++) {
    const writer = set(sid, { operator: { username: "va1" }, cookie: {}, n: round });
    const readers = Array.from({ length: 8 }, () => get(sid));
    const [, ...results] = await Promise.all([writer, ...readers]);
    for (const data of results) {
      assert.notEqual(data, null, `round ${round}: a concurrent get() returned null for a session that was never destroyed`);
      assert.equal(data.operator.username, "va1", `round ${round}: session data was corrupted, not just stale`);
    }
  }
});

test("session data survives across a fresh FileSessionStore instance pointed at the same directory", async () => {
  await set("sid-persist", { operator: { username: "va2" }, cookie: {} });
  const reopened = new FileSessionStore(dir);
  const data = await new Promise((resolve, reject) =>
    reopened.get("sid-persist", (err, d) => (err ? reject(err) : resolve(d)))
  );
  assert.equal(data.operator.username, "va2");
});

test("delayed and post-logout writes cannot revive a revoked session", async () => {
  const local = new FileSessionStore(dir);
  const call = (method, ...args) => new Promise((resolve, reject) => local[method](...args, (error, value) => error ? reject(error) : resolve(value)));
  const data = { operator: { username: "fixture" }, cookie: {} };
  await call("set", "revocation-race", data);
  const realRename = local._renameWithRetry.bind(local);
  let reached, release;
  const paused = new Promise(resolve => { reached = resolve; });
  local._renameWithRetry = (...args) => { release = () => realRename(...args); reached(); };
  const touch = call("touch", "revocation-race", data);
  await paused;
  await call("destroy", "revocation-race");
  release(); await touch;
  await call("set", "revocation-race", data);
  assert.equal(await call("get", "revocation-race"), null);
  const reopened = new FileSessionStore(dir);
  await new Promise((resolve, reject) => reopened.touch("revocation-race", data, error => error ? reject(error) : resolve()));
  assert.equal(await new Promise(resolve => reopened.get("revocation-race", (_, value) => resolve(value))), null);
});

test("corrupt and unreadable session records surface errors instead of looking logged out", async () => {
  const corrupt = path.join(dir, "sid-corrupt.json");
  fs.writeFileSync(corrupt, "{not-json");
  await assert.rejects(() => get("sid-corrupt"), /JSON/);

  const realRead = fs.readFile.bind(fs);
  const read = mock.method(fs, "readFile", (file, ...args) => {
    if (path.resolve(file) === path.resolve(path.join(dir, "sid-unreadable.json"))) {
      const callback = args.at(-1);
      const error = new Error("injected session read failure");
      error.code = "EACCES";
      callback(error);
      return;
    }
    return realRead(file, ...args);
  });
  try { await assert.rejects(() => get("sid-unreadable"), /injected session read failure/); }
  finally { read.mock.restore(); }
});

test("session sweep removes expired records and tombstones while bounding memory", async () => {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-session-sweep-"));
  let timestamp = 10_000;
  const local = new FileSessionStore(localDir, { now: () => timestamp, tombstoneTtlMs: 100,
    sweepIntervalMs: 10, maxMemoryRevocations: 2 });
  const call = (method, ...args) => new Promise((resolve, reject) => local[method](...args,
    (error, value) => error ? reject(error) : resolve(value)));
  try {
    await call("set", "expired-file", { cookie: { expires: new Date(timestamp - 1).toISOString() } });
    await call("destroy", "revoked-one");
    await call("destroy", "revoked-two");
    await call("destroy", "revoked-three");
    assert.ok(local.revoked.size <= 2);
    timestamp += 101;
    local.sweep();
    assert.equal(fs.existsSync(path.join(localDir, "expired-file.json")), false);
    assert.equal(fs.readdirSync(localDir).some(name => name.endsWith(".revoked")), false);
    assert.equal(local.revoked.size, 0);
  } finally { fs.rmSync(localDir, { recursive: true, force: true }); }
});
