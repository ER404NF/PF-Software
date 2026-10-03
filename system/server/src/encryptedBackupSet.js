import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createEncryptedFileBackup, restoreEncryptedFileBackup } from "./encryptedFileBackup.js";
import { createEncryptedPostgresBackup, restoreEncryptedPostgresBackup, RESTORE_CONFIRMATION } from "./postgresBackup.js";

const SET_ID = /^[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const SECRET = /^[A-Z][A-Z0-9_]{0,127}$/;
const COMPONENTS = Object.freeze(["files", "postgres"]);

function assertDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symbolic link`);
}

function hashRegularFile(file) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function componentHash(directory) {
  assertDirectory(directory, "backup component");
  const entries = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("backup component contains a symbolic link");
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        const relative = path.relative(directory, absolute).split(path.sep).join("/");
        const hash = hashRegularFile(absolute);
        entries.push(`${relative}\0${stat.size}\0${hash}\n`);
      } else throw new Error("backup component contains an unsupported filesystem entry");
    }
  }
  visit(directory);
  return { sha256: crypto.createHash("sha256").update(entries.join("")).digest("hex"), files: entries.length };
}

function normalizedSecrets(names) {
  if (!Array.isArray(names)) throw new Error("required secret names must be an array");
  const unique = [...new Set(names)].sort();
  if (unique.length > 128 || unique.some(name => !SECRET.test(name))) throw new Error("required secret names are invalid");
  return unique;
}

function readManifest(setDir) {
  assertDirectory(setDir, "backup set");
  const manifestPath = path.join(setDir, "backup-set.json");
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("backup-set manifest is invalid");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.version !== 1 || !SET_ID.test(manifest.id ?? "")
    || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.requiredSecretNames)
    || !manifest.components || typeof manifest.components !== "object") throw new Error("backup-set manifest is invalid");
  normalizedSecrets(manifest.requiredSecretNames);
  for (const name of COMPONENTS) {
    const component = manifest.components[name];
    if (!component || component.path !== name || component.version !== 1 || !HASH.test(component.sha256 ?? "")
      || !Number.isSafeInteger(component.files) || component.files < 1) throw new Error("backup-set manifest is invalid");
  }
  return manifest;
}

export function verifyEncryptedBackupSet({ backupSetDir }) {
  const root = path.resolve(backupSetDir ?? "");
  const manifest = readManifest(root);
  const expected = new Set(["backup-set.json", ...COMPONENTS]);
  for (const entry of fs.readdirSync(root)) if (!expected.has(entry)) throw new Error("backup set contains an unexpected member");
  for (const name of COMPONENTS) {
    const actual = componentHash(path.join(root, name));
    if (actual.sha256 !== manifest.components[name].sha256 || actual.files !== manifest.components[name].files) {
      throw new Error(`backup-set component integrity failed: ${name}`);
    }
  }
  return { id: manifest.id, createdAt: manifest.createdAt, requiredSecretNames: [...manifest.requiredSecretNames],
    components: structuredClone(manifest.components) };
}

export async function createEncryptedBackupSet({ sourceDir, backupSetDir, key, env = process.env,
  requiredSecretNames = [], now = () => new Date(), createFiles = createEncryptedFileBackup,
  createPostgres = createEncryptedPostgresBackup } = {}) {
  const destination = path.resolve(backupSetDir ?? "");
  if (fs.existsSync(destination)) throw new Error("backup-set destination already exists");
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("backup-set parent must be a real directory");
  const staging = path.join(parent, `.${path.basename(destination)}.staging-${crypto.randomUUID()}`);
  const id = crypto.randomUUID();
  const createdAt = now().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("backup-set clock is invalid");
  const secrets = normalizedSecrets(["PGDATABASE", ...requiredSecretNames]);
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    await createFiles({ sourceDir, backupDir: path.join(staging, "files"), key, requiredSecretNames: secrets });
    await createPostgres({ backupDir: path.join(staging, "postgres"), key, env, requiredSecretNames: secrets });
    const components = Object.fromEntries(COMPONENTS.map(name => [name, {
      version: 1, path: name, ...componentHash(path.join(staging, name)),
    }]));
    const manifest = { version: 1, id, createdAt, requiredSecretNames: secrets, components };
    fs.writeFileSync(path.join(staging, "backup-set.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    verifyEncryptedBackupSet({ backupSetDir: staging });
    fs.renameSync(staging, destination);
    return { id, createdAt, backupSetDir: destination, components };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreEncryptedBackupSet({ backupSetDir, targetDir, key, env = process.env,
  confirmation, disposableDatabase, restoreFiles = restoreEncryptedFileBackup,
  restorePostgres = restoreEncryptedPostgresBackup } = {}) {
  if (confirmation !== RESTORE_CONFIRMATION) throw new Error(`backup-set restore requires confirmation: ${RESTORE_CONFIRMATION}`);
  if (typeof disposableDatabase !== "string" || disposableDatabase !== env.PGDATABASE) {
    throw new Error("backup-set restore requires the exact disposable PGDATABASE name");
  }
  const root = path.resolve(backupSetDir ?? "");
  const target = path.resolve(targetDir ?? "");
  if (fs.existsSync(target)) throw new Error("backup-set restore target already exists");
  const manifest = verifyEncryptedBackupSet({ backupSetDir: root });
  const missing = manifest.requiredSecretNames.filter(name => typeof env[name] !== "string" || !env[name]);
  if (missing.length) throw new Error(`restore requires secret rebinding: ${missing.join(", ")}`);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(target)}.staging-${crypto.randomUUID()}`);
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    await restoreFiles({ backupDir: path.join(root, "files"), targetDir: path.join(staging, "files"), key, env });
    await restorePostgres({ backupDir: path.join(root, "postgres"), key, env, confirmation, });
    fs.writeFileSync(path.join(staging, "restored-backup-set.json"), `${JSON.stringify({ version: 1, id: manifest.id })}\n`,
      { flag: "wx", mode: 0o600 });
    fs.renameSync(staging, target);
    return { restored: true, id: manifest.id, targetDir: target, database: disposableDatabase };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export { RESTORE_CONFIRMATION as BACKUP_SET_RESTORE_CONFIRMATION };
