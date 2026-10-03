import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEncryptedFileBackup, parseBackupKey, restoreEncryptedFileBackup } from "../../src/encryptedFileBackup.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-backup-"));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "nested"), { recursive: true });
  fs.writeFileSync(path.join(source, "account.json"), "private account bytes");
  fs.writeFileSync(path.join(source, "nested", "media.bin"), crypto.randomBytes(256 * 1024));
  return { root, source, backup: path.join(root, "backup"), target: path.join(root, "restored"), key: crypto.randomBytes(32) };
}

test("encrypted file backup restores byte-identical data after explicit secret rebinding", async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const made = await createEncryptedFileBackup({
    sourceDir: item.source,
    backupDir: item.backup,
    key: item.key,
    requiredSecretNames: ["SESSION_SECRET"],
    now: () => new Date("2026-09-30T12:00:00.000Z"),
  });
  assert.deepEqual({ files: made.files, bytes: made.bytes }, { files: 2, bytes: 256 * 1024 + 21 });
  const onDisk = fs.readFileSync(path.join(item.backup, "manifest.enc"), "utf8");
  for (const plaintext of ["account.json", "media.bin", "private account bytes", "SESSION_SECRET"]) {
    assert.equal(onDisk.includes(plaintext), false, `${plaintext} must not appear in the encrypted manifest`);
  }
  await assert.rejects(() => restoreEncryptedFileBackup({
    backupDir: item.backup, targetDir: item.target, key: item.key, env: {},
  }), /secret rebinding: SESSION_SECRET/);
  assert.equal(fs.existsSync(item.target), false);

  const restored = await restoreEncryptedFileBackup({
    backupDir: item.backup, targetDir: item.target, key: item.key, env: { SESSION_SECRET: "rebound-outside-backup" },
  });
  assert.equal(restored.files, 2);
  assert.equal(fs.readFileSync(path.join(item.target, "account.json"), "utf8"), "private account bytes");
  assert.deepEqual(fs.readFileSync(path.join(item.target, "nested", "media.bin")),
    fs.readFileSync(path.join(item.source, "nested", "media.bin")));
});

test("tampered encrypted objects fail closed and leave no partial restore", async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  await createEncryptedFileBackup({ sourceDir: item.source, backupDir: item.backup, key: item.key });
  const objectPath = path.join(item.backup, "objects", fs.readdirSync(path.join(item.backup, "objects"))[0]);
  const bytes = fs.readFileSync(objectPath);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(objectPath, bytes);
  await assert.rejects(() => restoreEncryptedFileBackup({
    backupDir: item.backup, targetDir: item.target, key: item.key,
  }), /authenticate data|integrity check/i);
  assert.equal(fs.existsSync(item.target), false);
});

test("backup and restore refuse unsafe destinations and weak keys", async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  assert.throws(() => parseBackupKey("short"), /exactly 32 bytes/);
  await assert.rejects(() => createEncryptedFileBackup({
    sourceDir: item.source, backupDir: path.join(item.source, "inside"), key: item.key,
  }), /outside the source/);
  await createEncryptedFileBackup({ sourceDir: item.source, backupDir: item.backup, key: item.key });
  await assert.rejects(() => createEncryptedFileBackup({ sourceDir: item.source, backupDir: item.backup, key: item.key }), /already exists/);
  fs.mkdirSync(item.target);
  await assert.rejects(() => restoreEncryptedFileBackup({ backupDir: item.backup, targetDir: item.target, key: item.key }), /already exists/);
});

test("backup rejects an unbounded secret-name manifest before creating output", async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const requiredSecretNames = Array.from({ length: 129 }, (_, index) => `SECRET_${index}`);
  await assert.rejects(() => createEncryptedFileBackup({
    sourceDir: item.source, backupDir: item.backup, key: item.key, requiredSecretNames,
  }), /at most 128 secret names/);
  assert.equal(fs.existsSync(item.backup), false);
});

test("restore rejects an oversized encrypted manifest before allocating or creating output", async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.mkdirSync(item.backup);
  const handle = fs.openSync(path.join(item.backup, "manifest.enc"), "w");
  try {
    fs.ftruncateSync(handle, 64 * 1024 * 1024 + 1);
  } finally {
    fs.closeSync(handle);
  }
  await assert.rejects(() => restoreEncryptedFileBackup({
    backupDir: item.backup, targetDir: item.target, key: item.key,
  }), /regular file no larger than 67108864 bytes/);
  assert.equal(fs.existsSync(item.target), false);
});

test("restore refuses an encrypted object replaced by a symbolic link", async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  await createEncryptedFileBackup({ sourceDir: item.source, backupDir: item.backup, key: item.key });
  const objectPath = path.join(item.backup, "objects", fs.readdirSync(path.join(item.backup, "objects"))[0]);
  const outside = path.join(item.root, "outside-object");
  fs.writeFileSync(outside, "not an encrypted backup object");
  fs.rmSync(objectPath);
  try {
    fs.symlinkSync(outside, objectPath);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    const outsideDirectory = path.join(item.root, "outside-object-directory");
    fs.mkdirSync(outsideDirectory);
    fs.symlinkSync(outsideDirectory, objectPath, "junction");
  }
  await assert.rejects(() => restoreEncryptedFileBackup({
    backupDir: item.backup, targetDir: item.target, key: item.key,
  }), /regular file, not a symbolic link/);
  assert.equal(fs.existsSync(item.target), false);
});
