import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createFilePushLinkStore } from "../../src/filePushLinkStore.js";

function freshStore(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-file-push-link-"));
  const storePath = path.join(root, "links.json");
  return { root, storePath, ...createFilePushLinkStore({ storePath, ...overrides }) };
}

test("issue() returns a token that consume() accepts exactly once", t => {
  const store = freshStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  const { token } = store.issue({ deviceId: "mock-1", filename: "clip.mp4" });
  assert.match(token, /^pfl_/);
  const first = store.consume(token);
  assert.deepEqual(first, { deviceId: "mock-1", filename: "clip.mp4" });
  const replay = store.consume(token);
  assert.equal(replay, null, "a consumed token must never be usable again — this is the replay-rejection guarantee");
});

test("consume() rejects an expired token, even if otherwise valid and unused", t => {
  const store = freshStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  const { token } = store.issue({ deviceId: "mock-1", filename: "clip.mp4", ttlMs: -1000 });
  assert.equal(store.consume(token), null);
});

test("consume() rejects an unknown token, a malformed token, and a non-string token", t => {
  const store = freshStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  store.issue({ deviceId: "mock-1", filename: "clip.mp4" });
  assert.equal(store.consume("pfl_not-a-real-token-at-all"), null);
  assert.equal(store.consume("no-prefix-token"), null);
  assert.equal(store.consume(""), null);
  assert.equal(store.consume(null), null);
  assert.equal(store.consume(undefined), null);
  assert.equal(store.consume(12345), null);
});

test("two tokens issued for different device/filename pairs never cross-resolve", t => {
  const store = freshStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  const a = store.issue({ deviceId: "mock-1", filename: "a.mp4" });
  const b = store.issue({ deviceId: "mock-2", filename: "b.mp4" });
  assert.deepEqual(store.consume(a.token), { deviceId: "mock-1", filename: "a.mp4" });
  assert.deepEqual(store.consume(b.token), { deviceId: "mock-2", filename: "b.mp4" });
});

test("issue() requires deviceId and filename", t => {
  const store = freshStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  assert.throws(() => store.issue({ filename: "a.mp4" }), /deviceId/);
  assert.throws(() => store.issue({ deviceId: "mock-1" }), /filename/);
});

test("expired and consumed entries are pruned on the next issue(), keeping the store from growing forever", t => {
  const store = freshStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  const dead = store.issue({ deviceId: "mock-1", filename: "old.mp4", ttlMs: -1000 });
  const alsoDead = store.issue({ deviceId: "mock-1", filename: "used.mp4" });
  store.consume(alsoDead.token);
  const fresh = store.issue({ deviceId: "mock-1", filename: "new.mp4" });
  // The pruned-away tokens must still correctly fail (they're gone or already
  // consumed either way) and the fresh one must still work normally.
  assert.equal(store.consume(dead.token), null);
  assert.equal(store.consume(alsoDead.token), null);
  assert.deepEqual(store.consume(fresh.token), { deviceId: "mock-1", filename: "new.mp4" });
});

test("issue() default TTL is short-lived (minutes, not hours) like a password-reset link, not a session", t => {
  const store = freshStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  const before = Date.now();
  const { expiresAt } = store.issue({ deviceId: "mock-1", filename: "clip.mp4" });
  const ttlMs = Date.parse(expiresAt) - before;
  assert.ok(ttlMs > 0 && ttlMs <= 15 * 60_000, `expected a short default TTL, got ${ttlMs}ms`);
});

test("oversized and malformed persisted stores fail closed before token processing", t => {
  const store = freshStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  fs.writeFileSync(store.storePath, "x".repeat(1024 * 1024 + 1));
  assert.throws(() => store.consume("pfl_unknown"), /no larger than 1 MiB/);

  fs.writeFileSync(store.storePath, JSON.stringify({ version: 1, links: [{ tokenHash: "bad" }] }));
  assert.throws(() => store.consume("pfl_unknown"), /invalid record/);
});

test("issuance bounds identifiers and token lifetime", t => {
  const store = freshStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  assert.throws(() => store.issue({ deviceId: "d".repeat(257), filename: "a.mp4" }), /256 characters/);
  assert.throws(() => store.issue({ deviceId: "mock-1", filename: "f".repeat(1025) }), /1024 characters/);
  assert.throws(() => store.issue({ deviceId: "mock-1", filename: "a.mp4", ttlMs: Infinity }), /ttlMs/);
});
