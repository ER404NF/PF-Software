import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createMediaQuotaManager, mediaByteSetting } from "../../src/mediaUploadQuota.js";

function tempMediaRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-media-quota-"));
}

function fakeStatfs(freeBytes) {
  return () => ({ bsize: 1n, bavail: BigInt(freeBytes) });
}

test("media quota rejects malformed byte settings at startup", () => {
  assert.equal(mediaByteSetting("LIMIT", 12, {}), 12);
  assert.equal(mediaByteSetting("LIMIT", 12, { LIMIT: "0" }), 0);
  assert.throws(() => mediaByteSetting("LIMIT", 12, { LIMIT: "1.5" }), /non-negative integer/);
  assert.throws(() => mediaByteSetting("LIMIT", 12, { LIMIT: "-1" }), /non-negative integer/);
});

test("media quota enforces device and global logical limits", () => {
  const root = tempMediaRoot();
  fs.mkdirSync(path.join(root, "one"));
  fs.writeFileSync(path.join(root, "one", "existing.txt"), "12345");
  const quota = createMediaQuotaManager({ mediaRoot: root, perDeviceBytes: 8, globalBytes: 12,
    minFreeBytes: 0, statfs: fakeStatfs(100) });
  const first = quota.begin("one", "new.txt");
  assert.throws(() => quota.consume(first, 4), error => error.code === "MEDIA_DEVICE_QUOTA" && error.statusCode === 413);
  quota.abort(first);

  const second = quota.begin("two", "new.txt");
  assert.throws(() => quota.consume(second, 8), error => error.code === "MEDIA_GLOBAL_QUOTA" && error.statusCode === 413);
  quota.abort(second);
});

test("replacement credit permits a same-size replacement and serializes its target", () => {
  const root = tempMediaRoot();
  fs.mkdirSync(path.join(root, "one"));
  fs.writeFileSync(path.join(root, "one", "clip.txt"), "12345");
  const quota = createMediaQuotaManager({ mediaRoot: root, perDeviceBytes: 5, globalBytes: 5,
    minFreeBytes: 0, statfs: fakeStatfs(100) });
  const replacement = quota.begin("one", "clip.txt");
  quota.consume(replacement, 5);
  assert.throws(() => quota.begin("one", "clip.txt"), error => error.code === "MEDIA_UPLOAD_CONFLICT");
  quota.abort(replacement);
});

test("media quota preserves the configured free-space floor", () => {
  const root = tempMediaRoot();
  const quota = createMediaQuotaManager({ mediaRoot: root, perDeviceBytes: 100, globalBytes: 100,
    minFreeBytes: 10, statfs: fakeStatfs(12) });
  const upload = quota.begin("one", "clip.txt");
  assert.throws(() => quota.consume(upload, 3), error => error.code === "MEDIA_STORAGE_RESERVE" && error.statusCode === 507);
  quota.abort(upload);
});
