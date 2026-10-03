import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MANIFEST_AAD = Buffer.from("phone-farm-file-backup-manifest-v1");
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_BACKUP_FILES = 100_000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_REQUIRED_SECRET_NAMES = 128;
const MAX_RELATIVE_PATH_LENGTH = 1_024;

export function parseBackupKey(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim())) return Buffer.from(value.trim(), "hex");
  throw new Error("backup encryption key must be exactly 32 bytes or 64 hexadecimal characters");
}

function encryptedBuffer(buffer, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function decryptedBuffer(envelope, key, aad) {
  if (!envelope || typeof envelope !== "object") throw new Error("backup manifest envelope is invalid");
  const iv = Buffer.from(envelope.iv ?? "", "base64");
  const tag = Buffer.from(envelope.tag ?? "", "base64");
  const ciphertext = Buffer.from(envelope.ciphertext ?? "", "base64");
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error("backup manifest envelope is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function normalizedSecretNames(names) {
  if (!Array.isArray(names)) throw new TypeError("requiredSecretNames must be an array");
  const unique = [...new Set(names)];
  if (unique.length > MAX_REQUIRED_SECRET_NAMES) {
    throw new Error(`backup requires at most ${MAX_REQUIRED_SECRET_NAMES} secret names`);
  }
  for (const name of unique) if (!SECRET_NAME.test(name)) throw new Error(`invalid required secret name: ${name}`);
  return unique.sort();
}

function assertSeparateOutput(sourceDir, outputDir) {
  const relative = path.relative(sourceDir, outputDir);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("backup output must be outside the source directory");
  }
}

function safeTemporaryPath(finalPath, label) {
  const parent = path.dirname(finalPath);
  return path.join(parent, `.${path.basename(finalPath)}.${label}-${crypto.randomUUID()}`);
}

function removeTemporary(tempPath, parent) {
  if (path.dirname(path.resolve(tempPath)) !== path.resolve(parent)) throw new Error("refusing to remove an unsafe temporary path");
  fs.rmSync(tempPath, { recursive: true, force: true });
}

function listFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`backup source contains a symbolic link: ${path.relative(root, absolute)}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        if (files.length >= MAX_BACKUP_FILES) throw new Error(`backup source exceeds ${MAX_BACKUP_FILES} files`);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        validatingRelativePath(relative);
        files.push({ absolute, relative });
      }
      else throw new Error(`backup source contains an unsupported filesystem entry: ${path.relative(root, absolute)}`);
    }
  }
  visit(root);
  return files;
}

function validatingRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > MAX_RELATIVE_PATH_LENGTH
    || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new Error("backup manifest contains an unsafe file path");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith("../") || value.includes("\0")) {
    throw new Error("backup manifest contains an unsafe file path");
  }
  return value;
}

function meter() {
  const hash = crypto.createHash("sha256");
  let size = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  return { stream, result: () => ({ size, sha256: hash.digest("hex") }) };
}

function openRegularReadStream(filePath, label, expectedSize = null) {
  const linkStat = fs.lstatSync(filePath);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a symbolic link`);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino
      || (expectedSize !== null && stat.size !== expectedSize)) {
      throw new Error(`${label} changed while opening`);
    }
    return fs.createReadStream(filePath, { fd, autoClose: true });
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

async function encryptFile(input, output, key, objectId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`phone-farm-file-backup-v1:${objectId}`));
  const measured = meter();
  await pipeline(openRegularReadStream(input, "backup source file"), measured.stream, cipher,
    fs.createWriteStream(output, { flags: "wx", mode: 0o600 }));
  return { ...measured.result(), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

async function decryptFile(input, output, key, file) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
  decipher.setAAD(Buffer.from(`phone-farm-file-backup-v1:${file.object}`));
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  const measured = meter();
  await pipeline(openRegularReadStream(input, "encrypted backup object", file.size), decipher, measured.stream,
    fs.createWriteStream(output, { flags: "wx", mode: 0o600 }));
  const result = measured.result();
  if (result.size !== file.size || result.sha256 !== file.sha256) throw new Error(`restored file integrity check failed: ${file.path}`);
  return result.size;
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Number.isFinite(Date.parse(manifest.createdAt))
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.requiredSecretNames)) {
    throw new Error("backup manifest is invalid");
  }
  if (manifest.files.length > MAX_BACKUP_FILES) throw new Error(`backup manifest exceeds ${MAX_BACKUP_FILES} files`);
  normalizedSecretNames(manifest.requiredSecretNames);
  const paths = new Set();
  const objects = new Set();
  for (const file of manifest.files) {
    validatingRelativePath(file?.path);
    if (paths.has(file.path)) throw new Error("backup manifest contains a duplicate file path");
    paths.add(file.path);
    if (typeof file.object !== "string" || !/^[a-f0-9-]{36}$/.test(file.object) || objects.has(file.object)) {
      throw new Error("backup manifest contains an invalid object id");
    }
    objects.add(file.object);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)
      || Buffer.from(file.iv ?? "", "base64").length !== 12 || Buffer.from(file.tag ?? "", "base64").length !== 16) {
      throw new Error("backup manifest contains invalid file metadata");
    }
  }
  return manifest;
}

export async function createEncryptedFileBackup({ sourceDir, backupDir, key, requiredSecretNames = [], now = () => new Date() }) {
  const source = path.resolve(sourceDir ?? "");
  const destination = path.resolve(backupDir ?? "");
  const encryptionKey = parseBackupKey(key);
  const secrets = normalizedSecretNames(requiredSecretNames);
  if (!fs.existsSync(source)) throw new Error("backup source directory does not exist");
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("backup source must be a real directory, not a symbolic link");
  }
  if (fs.existsSync(destination)) throw new Error("backup destination already exists");
  assertSeparateOutput(source, destination);
  const createdAt = now().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("backup clock returned an invalid date");
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = safeTemporaryPath(destination, "backup");
  try {
    fs.mkdirSync(path.join(temporary, "objects"), { recursive: true });
    const entries = [];
    for (const file of listFiles(source)) {
      const object = crypto.randomUUID();
      const encrypted = await encryptFile(file.absolute, path.join(temporary, "objects", object), encryptionKey, object);
      entries.push({ path: file.relative, object, ...encrypted });
    }
    const manifest = { version: 1, createdAt, requiredSecretNames: secrets, files: entries };
    const envelope = encryptedBuffer(Buffer.from(JSON.stringify(manifest)), encryptionKey, MANIFEST_AAD);
    fs.writeFileSync(path.join(temporary, "manifest.enc"), `${JSON.stringify(envelope)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
    return { createdAt, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), backupDir: destination };
  } catch (error) {
    removeTemporary(temporary, parent);
    throw error;
  }
}

export async function restoreEncryptedFileBackup({ backupDir, targetDir, key, env = process.env }) {
  const backup = path.resolve(backupDir ?? "");
  const target = path.resolve(targetDir ?? "");
  const encryptionKey = parseBackupKey(key);
  if (!fs.existsSync(backup)) throw new Error("backup directory does not exist");
  const backupStat = fs.lstatSync(backup);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    throw new Error("backup directory must be a real directory, not a symbolic link");
  }
  if (fs.existsSync(target)) throw new Error("restore target already exists");
  assertSeparateOutput(backup, target);
  const manifestPath = path.join(backup, "manifest.enc");
  const manifestLinkStat = fs.lstatSync(manifestPath);
  if (manifestLinkStat.isSymbolicLink()) throw new Error("encrypted backup manifest must not be a symbolic link");
  let manifestContents;
  const manifestHandle = fs.openSync(manifestPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const manifestStat = fs.fstatSync(manifestHandle);
    if (!manifestStat.isFile() || manifestStat.dev !== manifestLinkStat.dev || manifestStat.ino !== manifestLinkStat.ino
      || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error(`encrypted backup manifest must be a regular file no larger than ${MAX_MANIFEST_BYTES} bytes`);
    }
    manifestContents = fs.readFileSync(manifestHandle, "utf8");
  } finally {
    fs.closeSync(manifestHandle);
  }
  const envelope = JSON.parse(manifestContents);
  const manifest = validateManifest(JSON.parse(decryptedBuffer(envelope, encryptionKey, MANIFEST_AAD).toString("utf8")));
  const missingSecrets = manifest.requiredSecretNames.filter(name => typeof env[name] !== "string" || !env[name]);
  if (missingSecrets.length) throw new Error(`restore requires secret rebinding: ${missingSecrets.join(", ")}`);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = safeTemporaryPath(target, "restore");
  let bytes = 0;
  try {
    fs.mkdirSync(temporary, { recursive: true });
    for (const file of manifest.files) {
      const destination = path.join(temporary, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      bytes += await decryptFile(path.join(backup, "objects", file.object), destination, encryptionKey, file);
    }
    fs.renameSync(temporary, target);
    return { createdAt: manifest.createdAt, files: manifest.files.length, bytes, targetDir: target };
  } catch (error) {
    removeTemporary(temporary, parent);
    throw error;
  }
}
