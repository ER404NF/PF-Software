import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBackupKey } from "../src/encryptedFileBackup.js";
import { createEncryptedBackupSet, restoreEncryptedBackupSet, verifyEncryptedBackupSet,
  BACKUP_SET_RESTORE_CONFIRMATION } from "../src/encryptedBackupSet.js";

function usage() {
  return ["Usage:",
    "  node server/scripts/backup-set.js create --source <dir> --output <new-dir> --key-file <file> [--required-secret NAME ...]",
    `  node server/scripts/backup-set.js restore --backup <dir> --target <new-dir> --database <new-db> --key-file <file> --confirm "${BACKUP_SET_RESTORE_CONFIRMATION}"`,
    "  node server/scripts/backup-set.js verify --backup <dir>",
  ].join("\n");
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["create", "restore", "verify"].includes(command)) throw new Error(usage());
  const result = { command, requiredSecretNames: [] };
  const allowed = command === "create" ? new Set(["--source", "--output", "--key-file", "--required-secret"])
    : command === "restore" ? new Set(["--backup", "--target", "--database", "--key-file", "--confirm"])
      : new Set(["--backup"]);
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
  const required = command === "create" ? ["source", "output", "keyFile"]
    : command === "restore" ? ["backup", "target", "database", "keyFile", "confirm"] : ["backup"];
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
  if (options.command === "verify") return { operation: "verify", ...verifyEncryptedBackupSet({ backupSetDir: options.backup }) };
  const key = readKey(options.keyFile);
  if (options.command === "create") return { operation: "create", ...await createEncryptedBackupSet({
    sourceDir: options.source, backupSetDir: options.output, key, env, requiredSecretNames: options.requiredSecretNames,
  }) };
  return { operation: "restore", ...await restoreEncryptedBackupSet({ backupSetDir: options.backup,
    targetDir: options.target, key, env: { ...env, PGDATABASE: options.database }, disposableDatabase: options.database,
    confirmation: options.confirm }) };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
