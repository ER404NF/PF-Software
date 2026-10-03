// Per-device file storage for content moving on/off a phone (source clips in,
// finished exports out). Isolated by device id so one client's files are
// never reachable through another client's device — see
// "Client Account Separation" in source-material for why that boundary matters.
//
// NOTE: this only isolates the *storage*. It does not by itself stop a VA
// from requesting a different deviceId than the one they're assigned —
// that requires real VA authentication, which doesn't exist yet (see
// README "Known gap"). Don't treat this as access control on its own.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_ROOT = process.env.FILE_STORE_DIR
  ? path.resolve(process.env.FILE_STORE_DIR)
  : path.join(__dirname, "../../storage");
export const MEDIA_ROOT = path.join(STORAGE_ROOT, "devices");
const RESERVED_IDS = new Set(["sessions", "audit", "queue", "models", "research", "research-evidence", "devices"]);

// Reject anything that isn't a plain filename: no path separators, no "..",
// no leading dot (prevents path traversal), and no control characters or
// header-unsafe punctuation. That last part matters on its own: testing
// showed multer/busboy's own strict multipart parsing incidentally rejects
// quotes and CR/LF in filenames (they break its header-value parsing before
// this function ever runs) — which meant this function's actual safety
// margin against those characters depended on a third-party parser's
// internal strictness, not on anything this function itself checked.
// Rejecting them explicitly here removes that hidden dependency.
function safeFilename(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return null;
  if (name.startsWith(".") || name.includes("..")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f<>:"/\\|?*]/.test(name)) return null;
  return name;
}

function safeDeviceId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  return RESERVED_IDS.has(id.toLowerCase()) ? null : id;
}

// Production-readiness audit §3: multer previously had no fileFilter at all
// — any extension, any content, was accepted and stored as-is (mitigated,
// not eliminated, by every download going through res.download(), which
// forces "Save As" and never renders inline). This is the allowlist: the
// video/image/audio types this app's own use case (source clips in,
// finished exports out) actually needs, checked against BOTH the declared
// extension and the declared MIME type so one can't silently override the
// other. The completed staging file is also checked against the signatures
// below before its same-directory rename commits it.
const ALLOWED_MEDIA_MIME_TYPES_BY_EXTENSION = {
  ".mp4": new Set(["video/mp4"]),
  ".m4v": new Set(["video/x-m4v", "video/mp4"]),
  ".mov": new Set(["video/quicktime"]),
  ".webm": new Set(["video/webm"]),
  ".jpg": new Set(["image/jpeg"]),
  ".jpeg": new Set(["image/jpeg"]),
  ".png": new Set(["image/png"]),
  ".gif": new Set(["image/gif"]),
  ".webp": new Set(["image/webp"]),
  ".heic": new Set(["image/heic", "image/heif"]),
  ".heif": new Set(["image/heic", "image/heif"]),
  ".mp3": new Set(["audio/mpeg"]),
  ".m4a": new Set(["audio/mp4", "audio/x-m4a", "audio/m4a"]),
  ".wav": new Set(["audio/wav", "audio/x-wav", "audio/wave"]),
  ".aac": new Set(["audio/aac", "audio/x-aac"]),
};

// Returns null when allowed, or a short human-readable reason when not —
// callers turn that into a clean 4xx rather than silently rejecting.
export function rejectedMediaUploadReason(originalname, mimetype) {
  if (typeof originalname !== "string") return "missing filename";
  const extension = path.extname(originalname).toLowerCase();
  const allowedMimeTypes = ALLOWED_MEDIA_MIME_TYPES_BY_EXTENSION[extension];
  if (!allowedMimeTypes) return `file type "${extension || "(none)"}" is not allowed`;
  if (!allowedMimeTypes.has(mimetype)) return `MIME type "${mimetype}" does not match the file's extension`;
  return null;
}

const EXPECTED_MAGIC_FORMATS_BY_EXTENSION = Object.freeze({
  ".mp4": new Set(["mp4"]),
  ".m4v": new Set(["mp4"]),
  ".mov": new Set(["quicktime"]),
  ".webm": new Set(["webm"]),
  ".jpg": new Set(["jpeg"]),
  ".jpeg": new Set(["jpeg"]),
  ".png": new Set(["png"]),
  ".gif": new Set(["gif"]),
  ".webp": new Set(["webp"]),
  ".heic": new Set(["heif"]),
  ".heif": new Set(["heif"]),
  ".mp3": new Set(["mp3"]),
  ".m4a": new Set(["m4a"]),
  ".wav": new Set(["wav"]),
  ".aac": new Set(["aac"]),
});

function ascii(buffer, start, end) {
  return buffer.length >= end ? buffer.subarray(start, end).toString("ascii") : "";
}

function isoBmffFormat(buffer) {
  if (ascii(buffer, 4, 8) !== "ftyp" || buffer.length < 12) return null;
  const brands = [ascii(buffer, 8, 12)];
  for (let offset = 16; offset + 4 <= buffer.length && offset < 128; offset += 4) {
    brands.push(ascii(buffer, offset, offset + 4));
  }
  if (brands.some(brand => ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand))) return "heif";
  if (brands.includes("qt  ")) return "quicktime";
  if (brands.some(brand => ["M4A ", "M4B ", "M4P "].includes(brand))) return "m4a";
  return "mp4";
}

export function detectMediaMagic(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (["GIF87a", "GIF89a"].includes(ascii(buffer, 0, 6))) return "gif";
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WEBP") return "webp";
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  const bmff = isoBmffFormat(buffer);
  if (bmff) return bmff;
  if (ascii(buffer, 0, 3) === "ID3"
    || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe6) === 0xe2)) return "mp3";
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WAVE") return "wav";
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return "aac";
  return null;
}

export function rejectedMediaContentReason(originalname, header) {
  const extension = path.extname(String(originalname ?? "")).toLowerCase();
  const expected = EXPECTED_MAGIC_FORMATS_BY_EXTENSION[extension];
  const detected = detectMediaMagic(header);
  if (!detected) return "file contents do not match a supported media format";
  if (!expected?.has(detected)) return `file contents (${detected}) do not match the file's extension`;
  return null;
}

export function stagedMediaContentReason(filePath, originalname, maxBytes = 4096) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    return rejectedMediaContentReason(originalname, header.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
}

export function deviceDir(deviceId) {
  const safe = safeDeviceId(deviceId);
  if (!safe) return null;
  return path.join(MEDIA_ROOT, safe);
}

export function ensureDeviceDir(deviceId) {
  const dir = deviceDir(deviceId);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listFiles(deviceId) {
  const dir = deviceDir(deviceId);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => safeFilename(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, uploadedAt: stat.mtime.toISOString() };
    });
}

export function resolveFile(deviceId, filename) {
  const dir = deviceDir(deviceId);
  const safeName = safeFilename(filename);
  if (!dir || !safeName) return null;
  const full = path.join(dir, safeName);
  if (!fs.existsSync(full)) return null;
  return full;
}

export function deleteFile(deviceId, filename) {
  const full = resolveFile(deviceId, filename);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}

export { safeFilename, safeDeviceId };

function canonicalPath(value) {
  const full = path.resolve(value);
  if (fs.existsSync(full)) return fs.realpathSync(full);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(canonicalPath(parent), path.basename(full));
}
export function assertMediaStorageIsolated(internalPaths, mediaRoot = MEDIA_ROOT) {
  const inside = (a, b) => {
    const relative = path.relative(a, b);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  const media = canonicalPath(mediaRoot);
  for (const internal of internalPaths.map(canonicalPath)) {
    if (inside(media, internal) || inside(internal, media)) throw new Error("Device media overlaps internal storage");
  }
}
