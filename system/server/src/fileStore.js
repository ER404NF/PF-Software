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
