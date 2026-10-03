import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBackupKey } from "../src/encryptedFileBackup.js";
import {
  createEncryptedPostgresBackup,
  restoreEncryptedPostgresBackup,
  RESTORE_CONFIRMATION,
} from "../src/postgresBackup.js";

function usage() {
  return [
    "Usage:",
    "  node server/scripts/postgres-backup.js create --output <new-dir> --key-file <file> [--required-secret NAME ...]",
    `  node server/scripts/postgres-backup.js restore --backup <dir> --key-file <file> --confirm "${RESTORE_CONFIRMATION}"`,
    "PGDATABASE and any PGHOST/PGPORT/PGUSER/PGPASSWORD values are read only from the environment.",
  ].join("\n");
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["create", "restore"]).has(command)) throw new Error(usage());
  const result = { command, requiredSecretNames: [] };
  const allowed = command === "create"
    ? new Set(["--output", "--key-file", "--required-secret"])
    : new Set(["--backup", "--key-file", "--confirm"]);
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || value.startsWith("--")) throw new Error(usage());
    if (name === "--required-secret") result.requiredSecretNames.push(value);
    else {
      const key = name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      if (Object.hasOwn(result, key)) throw new Error(`duplicate argument: ${name}`);
      result[key] = value;
    }
  }
  const required = command === "create" ? ["output", "keyFile"] : ["backup", "keyFile", "confirm"];
  if (required.some(name => !result[name])) throw new Error(usage());
  return result;
}

function readKey(filename) {
  const resolved = path.resolve(filename);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("backup key file must be a regular file, not a symbolic link");
  const value = fs.readFileSync(resolved);
  return parseBackupKey(value.length === 32 ? value : value.toString("utf8"));
}

export async function run(argv, env = process.env) {
  const options = parseArguments(argv);
  const key = readKey(options.keyFile);
  const started = Date.now();
  if (options.command === "create") {
    const result = await createEncryptedPostgresBackup({
      backupDir: options.output, key, env, requiredSecretNames: options.requiredSecretNames,
    });
    return { operation: "create", files: result.files, bytes: result.bytes, elapsedMs: Date.now() - started,
      path: result.backupDir };
  }
  const result = await restoreEncryptedPostgresBackup({
    backupDir: options.backup, key, env, confirmation: options.confirm,
  });
  return { operation: "restore", restored: result.restored, database: result.database,
    elapsedMs: Date.now() - started };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
