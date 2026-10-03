import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArguments, run } from "../../scripts/file-backup.js";

test("file backup CLI rejects incomplete, duplicate, and unexpected arguments", () => {
  assert.throws(() => parseArguments([]), /Usage:/);
  assert.throws(() => parseArguments(["create", "--source", "one"]), /Usage:/);
  assert.throws(() => parseArguments(["restore", "--backup", "one", "--target", "two", "--key-file", "three", "--required-secret", "NO"]), /Usage:/);
  assert.throws(() => parseArguments(["restore", "--backup", "one", "--backup", "two", "--target", "three", "--key-file", "four"]), /duplicate/);
});

test("file backup CLI performs a disposable encrypted round trip without printing secrets", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-backup-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const backup = path.join(root, "backup");
  const target = path.join(root, "target");
  const keyFile = path.join(root, "backup.key");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "state.json"), "restorable state");
  fs.writeFileSync(keyFile, crypto.randomBytes(32));

  const created = await run(["create", "--source", source, "--output", backup, "--key-file", keyFile,
    "--required-secret", "SESSION_SECRET"]);
  assert.deepEqual({ operation: created.operation, files: created.files, bytes: created.bytes },
    { operation: "create", files: 1, bytes: 16 });
  const restored = await run(["restore", "--backup", backup, "--target", target, "--key-file", keyFile],
    { SESSION_SECRET: "not-written-to-backup" });
  assert.equal(restored.operation, "restore");
  assert.equal(fs.readFileSync(path.join(target, "state.json"), "utf8"), "restorable state");
  assert.equal(JSON.stringify([created, restored]).includes("not-written-to-backup"), false);
});
