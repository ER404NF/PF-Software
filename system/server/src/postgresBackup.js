import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createEncryptedFileBackup, restoreEncryptedFileBackup } from "./encryptedFileBackup.js";

const DATABASE_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const RESTORE_CONFIRMATION = "RESTORE INTO DISPOSABLE DATABASE";

function toolName(value, fallback) {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (candidate.length > 1024 || /[\0\r\n]/.test(candidate)) throw new Error("PostgreSQL tool path is invalid");
  return candidate;
}

function databaseEnvironment(env) {
  if (!env || typeof env !== "object" || !DATABASE_NAME.test(env.PGDATABASE ?? "")) {
    throw new Error("PGDATABASE must name the disposable PostgreSQL database without credentials");
  }
  return { ...env };
}

function runPostgresTool(binary, args, { env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ["ignore", "ignore", "ignore"], windowsHide: true, shell: false });
    child.once("error", () => reject(new Error("PostgreSQL backup tool could not be started")));
    child.once("exit", code => code === 0
      ? resolve()
      : reject(new Error(`PostgreSQL backup tool failed with exit code ${Number.isInteger(code) ? code : "unknown"}`)));
  });
}

function privateTemporaryDirectory(parent, prefix) {
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, prefix));
  try { fs.chmodSync(temporary, 0o700); } catch { /* Windows ACLs are inherited; do not weaken them. */ }
  return temporary;
}

function assertDump(pathname) {
  if (!fs.existsSync(pathname)) throw new Error("PostgreSQL dump was not a non-empty regular file");
  const stat = fs.lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error("PostgreSQL dump was not a non-empty regular file");
  }
  try { fs.chmodSync(pathname, 0o600); } catch { /* Best effort on Windows. */ }
}

export async function createEncryptedPostgresBackup({
  backupDir,
  key,
  env = process.env,
  requiredSecretNames = [],
  runTool = runPostgresTool,
} = {}) {
  const destination = path.resolve(backupDir ?? "");
  if (fs.existsSync(destination)) throw new Error("backup destination already exists");
  const databaseEnv = databaseEnvironment(env);
  const temporary = privateTemporaryDirectory(path.dirname(destination), ".phone-farm-postgres-dump-");
  const dumpPath = path.join(temporary, "database.dump");
  try {
    await runTool(toolName(env.PG_DUMP_BIN, "pg_dump"), [
      "--format=custom", "--no-owner", "--no-privileges", `--file=${dumpPath}`,
    ], { env: databaseEnv });
    assertDump(dumpPath);
    return await createEncryptedFileBackup({
      sourceDir: temporary,
      backupDir: destination,
      key,
      requiredSecretNames: [...new Set(["PGDATABASE", ...requiredSecretNames])],
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export async function restoreEncryptedPostgresBackup({
  backupDir,
  key,
  env = process.env,
  confirmation,
  runTool = runPostgresTool,
} = {}) {
  if (confirmation !== RESTORE_CONFIRMATION) {
    throw new Error(`database restore requires confirmation: ${RESTORE_CONFIRMATION}`);
  }
  const databaseEnv = databaseEnvironment(env);
  const temporary = privateTemporaryDirectory(os.tmpdir(), "phone-farm-postgres-restore-");
  const restored = path.join(temporary, "payload");
  try {
    await restoreEncryptedFileBackup({ backupDir, targetDir: restored, key, env: databaseEnv });
    const dumpPath = path.join(restored, "database.dump");
    assertDump(dumpPath);
    await runTool(toolName(env.PG_RESTORE_BIN, "pg_restore"), [
      "--exit-on-error", "--no-owner", "--no-privileges", `--dbname=${databaseEnv.PGDATABASE}`, dumpPath,
    ], { env: databaseEnv });
    return { restored: true, database: databaseEnv.PGDATABASE };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export { RESTORE_CONFIRMATION };
