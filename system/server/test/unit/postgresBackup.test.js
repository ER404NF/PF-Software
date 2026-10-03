import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEncryptedPostgresBackup,
  restoreEncryptedPostgresBackup,
  RESTORE_CONFIRMATION,
} from "../../src/postgresBackup.js";
import { parseArguments } from "../../scripts/postgres-backup.js";

test("PostgreSQL backup CLI requires explicit bounded arguments and restore confirmation", () => {
  assert.throws(() => parseArguments([]), /Usage:/);
  assert.throws(() => parseArguments(["create", "--output", "one"]), /Usage:/);
  assert.throws(() => parseArguments(["restore", "--backup", "one", "--key-file", "key"]), /Usage:/);
  assert.deepEqual(parseArguments(["create", "--output", "backup", "--key-file", "key", "--required-secret", "SESSION_SECRET"]), {
    command: "create", output: "backup", keyFile: "key", requiredSecretNames: ["SESSION_SECRET"],
  });
});

test("PostgreSQL dump is encrypted, credentials stay in env, and disposable restore is explicitly gated", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-postgres-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backupDir = path.join(root, "backup");
  const key = crypto.randomBytes(32);
  const calls = [];
  const env = { PGDATABASE: "phone_farm_restore_test", PGPASSWORD: "private-database-password" };
  const runTool = async (binary, args, options) => {
    calls.push({ binary, args: [...args], env: options.env });
    if (binary === "pg_dump") {
      const output = args.find(arg => arg.startsWith("--file=")).slice("--file=".length);
      fs.writeFileSync(output, "private PostgreSQL dump bytes", { mode: 0o600 });
    }
  };

  const created = await createEncryptedPostgresBackup({ backupDir, key, env, runTool });
  assert.equal(created.files, 1);
  assert.equal(fs.readFileSync(path.join(backupDir, "manifest.enc"), "utf8").includes("private PostgreSQL"), false);
  assert.equal(JSON.stringify(calls[0].args).includes(env.PGPASSWORD), false);
  assert.equal(calls[0].env.PGPASSWORD, env.PGPASSWORD);

  await assert.rejects(() => restoreEncryptedPostgresBackup({ backupDir, key, env, runTool }), /requires confirmation/);
  await restoreEncryptedPostgresBackup({ backupDir, key, env, confirmation: RESTORE_CONFIRMATION, runTool });
  assert.equal(calls[1].binary, "pg_restore");
  assert.equal(JSON.stringify(calls[1].args).includes(env.PGPASSWORD), false);
  assert.equal(calls[1].args.includes("--dbname=phone_farm_restore_test"), true);
});

test("database backup fails closed on missing database identity and missing or empty dumps", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-postgres-backup-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  await assert.rejects(() => createEncryptedPostgresBackup({
    backupDir: path.join(root, "missing-db"), key, env: {}, runTool: async () => {},
  }), /PGDATABASE/);
  await assert.rejects(() => createEncryptedPostgresBackup({
    backupDir: path.join(root, "empty-dump"), key, env: { PGDATABASE: "test" }, runTool: async () => {},
  }), /dump was not/);
  assert.equal(fs.existsSync(path.join(root, "empty-dump")), false);
});
