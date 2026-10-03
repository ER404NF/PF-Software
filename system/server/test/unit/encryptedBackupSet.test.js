import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEncryptedFileBackup, restoreEncryptedFileBackup } from "../../src/encryptedFileBackup.js";
import { createEncryptedBackupSet, restoreEncryptedBackupSet, verifyEncryptedBackupSet,
  BACKUP_SET_RESTORE_CONFIRMATION } from "../../src/encryptedBackupSet.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-backup-set-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "state.json"), "private file state");
  return { root, source, set: path.join(root, "set"), target: path.join(root, "restore"), key: crypto.randomBytes(32),
    env: { PGDATABASE: "phone_farm_disposable", SESSION_SECRET: "must-not-be-recorded" } };
}

async function fakePostgresCreate({ backupDir, key, requiredSecretNames }) {
  const source = path.join(path.dirname(backupDir), `pg-source-${crypto.randomUUID()}`);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "database.dump"), "private database dump");
  try { return await createEncryptedFileBackup({ sourceDir: source, backupDir, key, requiredSecretNames }); }
  finally { fs.rmSync(source, { recursive: true, force: true }); }
}

test("backup set atomically links encrypted file and database components without secret values", async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const created = await createEncryptedBackupSet({ sourceDir: f.source, backupSetDir: f.set, key: f.key,
    env: f.env, requiredSecretNames: ["SESSION_SECRET"], createPostgres: fakePostgresCreate,
    now: () => new Date("2026-10-02T10:00:00.000Z") });
  assert.match(created.id, /^[a-f0-9-]{36}$/);
  const verified = verifyEncryptedBackupSet({ backupSetDir: f.set });
  assert.equal(verified.id, created.id);
  assert.deepEqual(Object.keys(verified.components), ["files", "postgres"]);
  const serialized = fs.readFileSync(path.join(f.set, "backup-set.json"), "utf8");
  assert.equal(serialized.includes(f.env.SESSION_SECRET), false);
  assert.match(serialized, /SESSION_SECRET/);
  assert.equal(fs.readdirSync(f.root).some(name => name.includes("staging-")), false);
});

test("component failure removes the entire unpublished staging set", async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await assert.rejects(() => createEncryptedBackupSet({ sourceDir: f.source, backupSetDir: f.set, key: f.key,
    env: f.env, createPostgres: async () => { throw new Error("pg_dump failed"); } }), /pg_dump failed/);
  assert.equal(fs.existsSync(f.set), false);
  assert.equal(fs.readdirSync(f.root).some(name => name.includes("staging-")), false);

  await assert.rejects(() => createEncryptedBackupSet({ sourceDir: f.source, backupSetDir: f.set, key: f.key,
    env: f.env, createFiles: async () => { throw new Error("file copy failed"); }, createPostgres: fakePostgresCreate }), /file copy failed/);
  assert.equal(fs.existsSync(f.set), false);
});

test("verification rejects tampering, unexpected members, symbolic links, and wrong-set components", async t => {
  const f = fixture();
  const other = fixture();
  t.after(() => { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(other.root, { recursive: true, force: true }); });
  for (const item of [f, other]) await createEncryptedBackupSet({ sourceDir: item.source, backupSetDir: item.set,
    key: item.key, env: item.env, createPostgres: fakePostgresCreate });
  fs.rmSync(path.join(f.set, "postgres"), { recursive: true });
  fs.cpSync(path.join(other.set, "postgres"), path.join(f.set, "postgres"), { recursive: true });
  assert.throws(() => verifyEncryptedBackupSet({ backupSetDir: f.set }), /component integrity failed/);

  fs.writeFileSync(path.join(other.set, "unexpected.txt"), "x");
  assert.throws(() => verifyEncryptedBackupSet({ backupSetDir: other.set }), /unexpected member/);
});

test("restore requires a new target, exact disposable database and confirmation; failures clean file staging", async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await createEncryptedBackupSet({ sourceDir: f.source, backupSetDir: f.set, key: f.key, env: f.env,
    requiredSecretNames: ["SESSION_SECRET"], createPostgres: fakePostgresCreate });
  const options = { backupSetDir: f.set, targetDir: f.target, key: f.key, env: f.env,
    confirmation: BACKUP_SET_RESTORE_CONFIRMATION, disposableDatabase: f.env.PGDATABASE,
    restoreFiles: restoreEncryptedFileBackup };
  await assert.rejects(() => restoreEncryptedBackupSet({ ...options, confirmation: "yes" }), /requires confirmation/);
  await assert.rejects(() => restoreEncryptedBackupSet({ ...options, disposableDatabase: "wrong" }), /exact disposable/);
  await assert.rejects(() => restoreEncryptedBackupSet({ ...options,
    restorePostgres: async () => { throw new Error("pg_restore failed"); } }), /pg_restore failed/);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.readdirSync(f.root).some(name => name.includes("staging-")), false);

  const restored = await restoreEncryptedBackupSet({ ...options, restorePostgres: async () => ({ restored: true }) });
  assert.equal(restored.restored, true);
  assert.equal(fs.readFileSync(path.join(f.target, "files", "state.json"), "utf8"), "private file state");
  await assert.rejects(() => restoreEncryptedBackupSet({ ...options,
    restorePostgres: async () => ({ restored: true }) }), /target already exists/);
});
