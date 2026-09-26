import test from "node:test";
import assert from "node:assert/strict";
import { assertDeviceMediaRepository } from "../../src/persistence/deviceMediaRepository.js";
import { createFileDeviceMediaRepository } from "../../src/persistence/fileDeviceMediaRepository.js";
import * as fileStore from "../../src/fileStore.js";

test("device media repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertDeviceMediaRepository(null), /must be an object/);
  assert.throws(() => assertDeviceMediaRepository({}), /requires ensureDeviceDir/);
  assert.throws(
    () => assertDeviceMediaRepository({ ensureDeviceDir() {}, listFiles() {}, resolveFile() {} }),
    /requires deleteFile/,
  );
});

test("file device media adapter delegates to the real fileStore.js functions by default", () => {
  const repository = createFileDeviceMediaRepository();
  assertDeviceMediaRepository(repository);
  assert.equal(repository.ensureDeviceDir, fileStore.ensureDeviceDir);
  assert.equal(repository.listFiles, fileStore.listFiles);
  assert.equal(repository.resolveFile, fileStore.resolveFile);
  assert.equal(repository.deleteFile, fileStore.deleteFile);
});

test("file device media adapter accepts injected overrides for tests", () => {
  const calls = [];
  const repository = createFileDeviceMediaRepository({
    listFiles: (deviceId) => { calls.push(["listFiles", deviceId]); return [{ name: "clip.mp4" }]; },
  });
  assert.deepEqual(repository.listFiles("device-1"), [{ name: "clip.mp4" }]);
  assert.deepEqual(calls, [["listFiles", "device-1"]]);
  // Non-overridden methods still fall through to the real implementation.
  assert.equal(repository.deleteFile, fileStore.deleteFile);
});
