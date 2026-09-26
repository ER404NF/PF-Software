import test from "node:test";
import assert from "node:assert/strict";
import { createSyncCache, SyncCacheError } from "../../src/syncCache.js";

test("createSyncCache() requires load() and persist()", async () => {
  await assert.rejects(() => createSyncCache({ persist: async () => {} }), SyncCacheError);
  await assert.rejects(() => createSyncCache({ load: async () => ({}) }), SyncCacheError);
});

test("createSyncCache() loads its initial snapshot from a Map, an entries array, or a plain object", async () => {
  const fromMap = await createSyncCache({ load: async () => new Map([["a", 1]]), persist: async () => {} });
  assert.equal(fromMap.get("a"), 1);

  const fromArray = await createSyncCache({ load: async () => [["b", 2]], persist: async () => {} });
  assert.equal(fromArray.get("b"), 2);

  const fromObject = await createSyncCache({ load: async () => ({ c: 3 }), persist: async () => {} });
  assert.equal(fromObject.get("c"), 3);
});

test("get() returns null for a missing key, not undefined", async () => {
  const cache = await createSyncCache({ load: async () => ({}), persist: async () => {} });
  assert.equal(cache.get("missing"), null);
  assert.equal(cache.has("missing"), false);
});

test("set() updates the synchronous read surface immediately, before the durable write settles", async () => {
  let resolvePersist;
  const persisted = new Promise((resolve) => { resolvePersist = resolve; });
  const cache = await createSyncCache({
    load: async () => ({}),
    persist: async (key, value) => { await persisted; return { key, value }; },
  });

  const writeDone = cache.set("x", 42);
  // The synchronous read already reflects the write, even though persist()
  // has not resolved yet — this is the whole point of the cache.
  assert.equal(cache.get("x"), 42);
  resolvePersist();
  await writeDone;
});

test("a persist() rejection is reported via onPersistError, not thrown back into set()", async () => {
  const errors = [];
  const cache = await createSyncCache({
    load: async () => ({}),
    persist: async () => { throw new Error("backend unreachable"); },
    onPersistError: (error) => errors.push(error.message),
  });
  await cache.set("x", 1);
  assert.equal(cache.get("x"), 1, "the in-memory value must stand even though the durable write failed");
  assert.deepEqual(errors, ["backend unreachable"]);
});

test("delete() removes the key locally and persists undefined", async () => {
  const persistedCalls = [];
  const cache = await createSyncCache({
    load: async () => ({ a: 1 }),
    persist: async (key, value) => persistedCalls.push([key, value]),
  });
  await cache.delete("a");
  assert.equal(cache.get("a"), null);
  assert.deepEqual(persistedCalls, [["a", undefined]]);
});

test("entries() reflects the current in-memory state", async () => {
  const cache = await createSyncCache({ load: async () => ({ a: 1, b: 2 }), persist: async () => {} });
  assert.deepEqual(new Map(cache.entries()), new Map([["a", 1], ["b", 2]]));
});

test("refresh() re-loads the full snapshot, picking up a write made by another process", async () => {
  let generation = 0;
  const cache = await createSyncCache({
    load: async () => (generation === 0 ? { a: 1 } : { a: 1, b: 2 }),
    persist: async () => {},
  });
  assert.equal(cache.get("b"), null);
  generation = 1;
  await cache.refresh();
  assert.equal(cache.get("b"), 2);
});

test("a refresh() failure is reported via onRefreshError and keeps the last-known-good snapshot", async () => {
  const errors = [];
  let shouldFail = false;
  const cache = await createSyncCache({
    load: async () => { if (shouldFail) throw new Error("backend unreachable"); return { a: 1 }; },
    persist: async () => {},
    onRefreshError: (error) => errors.push(error.message),
  });
  shouldFail = true;
  await cache.refresh();
  assert.equal(cache.get("a"), 1, "a failed refresh must not wipe the previously-loaded snapshot");
  assert.deepEqual(errors, ["backend unreachable"]);
});

test("stop() cancels a periodic refresh timer", async () => {
  const cache = await createSyncCache({ load: async () => ({}), persist: async () => {}, refreshIntervalMs: 50 });
  cache.stop();
  // No assertion beyond "this does not throw and the process can exit" —
  // an uncleared interval would otherwise keep the test process alive.
});
