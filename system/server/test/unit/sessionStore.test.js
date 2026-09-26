import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSessionStore } from "../../src/persistence/sessionStore.js";
import { createFileSessionStore } from "../../src/persistence/fileSessionStore.js";

function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

test("session store contract rejects incomplete adapters", () => {
  assert.throws(() => assertSessionStore(null), /must be an object/);
  assert.throws(() => assertSessionStore({ get() {}, set() {}, destroy() {} }), /requires touch/);
});

test("file session adapter satisfies the contract and preserves callback behavior", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-session-adapter-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createFileSessionStore(directory);
  const session = { cookie: { expires: new Date(Date.now() + 60_000).toISOString() },
    operator: { username: "va1" } };

  await call(store, "set", "adapter-session", session);
  assert.deepEqual(await call(store, "get", "adapter-session"), session);
  await call(store, "touch", "adapter-session", session);
  await call(store, "destroy", "adapter-session");
  assert.equal(await call(store, "get", "adapter-session"), null);
});

test("file session adapter forwards safety options to the existing implementation", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-session-adapter-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = () => 1234;
  const store = createFileSessionStore(directory, { now, tombstoneTtlMs: 50, sweepIntervalMs: 25,
    maxMemoryRevocations: 5 });

  assert.equal(store.now, now);
  assert.equal(store.tombstoneTtlMs, 50);
  assert.equal(store.sweepIntervalMs, 25);
  assert.equal(store.maxMemoryRevocations, 5);
});
