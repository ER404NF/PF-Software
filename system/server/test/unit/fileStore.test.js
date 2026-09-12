import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFilename, safeDeviceId, deviceDir, MEDIA_ROOT, assertMediaStorageIsolated } from "../../src/fileStore.js";

test("safeFilename accepts a plain filename", () => {
  assert.equal(safeFilename("clip.mp4"), "clip.mp4");
  assert.equal(safeFilename("photo 1.jpg"), "photo 1.jpg");
});

test("safeFilename rejects path traversal", () => {
  assert.equal(safeFilename("../secrets.txt"), null);
  assert.equal(safeFilename("..\\secrets.txt"), null);
  assert.equal(safeFilename("a/../../b"), null);
});

test("safeFilename rejects a leading dot", () => {
  assert.equal(safeFilename(".env"), null);
  assert.equal(safeFilename(".hidden"), null);
});

test("safeFilename rejects path separators", () => {
  assert.equal(safeFilename("a/b.txt"), null);
  assert.equal(safeFilename("a\\b.txt"), null);
});

test("safeFilename rejects header-unsafe and control characters", () => {
  assert.equal(safeFilename('quote"name.txt'), null);
  assert.equal(safeFilename("cr\rlf\nname.txt"), null);
  assert.equal(safeFilename("null\x00byte.txt"), null);
  assert.equal(safeFilename("wild*card?.txt"), null);
  assert.equal(safeFilename("colon:name.txt"), null);
});

test("safeFilename rejects empty, non-string, and oversized names", () => {
  assert.equal(safeFilename(""), null);
  assert.equal(safeFilename(undefined), null);
  assert.equal(safeFilename(123), null);
  assert.equal(safeFilename("a".repeat(256)), null);
  assert.equal(safeFilename("a".repeat(255)), "a".repeat(255));
});

test("safeDeviceId accepts alphanumeric/dash/underscore ids", () => {
  assert.equal(safeDeviceId("mock-1"), "mock-1");
  assert.equal(safeDeviceId("iphone_2"), "iphone_2");
});

test("safeDeviceId rejects traversal and unsafe characters", () => {
  assert.equal(safeDeviceId("../etc"), null);
  assert.equal(safeDeviceId("mock 1"), null);
  assert.equal(safeDeviceId("mock/1"), null);
  assert.equal(safeDeviceId(""), null);
  assert.equal(safeDeviceId(undefined), null);
});

test("media namespace rejects internal device names and overlapping storage", () => {
  for (const id of ["sessions", "Sessions", "queue", "research", "audit", "models"]) {
    assert.equal(safeDeviceId(id), null);
    assert.equal(deviceDir(id), null);
  }
  assert.ok(deviceDir("phone").startsWith(MEDIA_ROOT));
  assert.throws(() => assertMediaStorageIsolated([MEDIA_ROOT]), /overlaps/);
  assert.throws(() => assertMediaStorageIsolated([deviceDir("phone")]), /overlaps/);
});
