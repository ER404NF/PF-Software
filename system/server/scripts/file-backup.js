import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEncryptedFileBackup, parseBackupKey, restoreEncryptedFileBackup } from "../src/encryptedFileBackup.js";

function usage() {
  return [
    "Usage:",
    "  node server/scripts/file-backup.js create --source <dir> --output <new-dir> --key-file <file> [--required-secret NAME ...]",
    "  node server/scripts/file-backup.js restore --backup <dir> --target <new-dir> --key-file <file>",
  ].join("\n");
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["create", "restore"]).has(command)) throw new Error(usage());
  const values = { requiredSecretNames: [] };
  const allowed = command === "create"
    ? new Set(["--source", "--output", "--key-file", "--required-secret"])
    : new Set(["--backup", "--target", "--key-file"]);
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || value.startsWith("--")) throw new Error(usage());
    if (name === "--required-secret") values.requiredSecretNames.push(value);
    else {
      const key = name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      if (Object.hasOwn(values, key)) throw new Error(`duplicate argument: ${name}`);
      values[key] = value;
    }
  }
  for (const required of command === "create" ? ["source", "output", "keyFile"] : ["backup", "target", "keyFile"]) {
    if (!values[required]) throw new Error(usage());
  }
  return { command, ...values };
}

function readKey(keyFile) {
  const resolved = path.resolve(keyFile);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("backup key file must be a regular file, not a symbolic link");
  const bytes = fs.readFileSync(resolved);
  return parseBackupKey(bytes.length === 32 ? bytes : bytes.toString("utf8"));
}

export async function run(argv, env = process.env) {
  const options = parseArguments(argv);
  const key = readKey(options.keyFile);
  const started = Date.now();
  const result = options.command === "create"
    ? await createEncryptedFileBackup({
      sourceDir: options.source,
      backupDir: options.output,
      key,
      requiredSecretNames: options.requiredSecretNames,
    })
    : await restoreEncryptedFileBackup({ backupDir: options.backup, targetDir: options.target, key, env });
  return { operation: options.command, files: result.files, bytes: result.bytes, elapsedMs: Date.now() - started,
    path: options.command === "create" ? result.backupDir : result.targetDir };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
