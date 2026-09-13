import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Transform } from "stream";
import { pipeline } from "stream/promises";

export const DEFAULT_DEVICE_MEDIA_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_GLOBAL_MEDIA_QUOTA_BYTES = 100 * 1024 * 1024 * 1024;
export const DEFAULT_MEDIA_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

export class MediaCapacityError extends Error {
  constructor(message, statusCode, code, detail = {}) {
    super(message);
    this.name = "MediaCapacityError";
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }
}

export function mediaByteSetting(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer byte count`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} exceeds the supported integer range`);
  return value;
}

function committedUsage(mediaRoot) {
  const byDevice = new Map();
  let total = 0;
  if (!fs.existsSync(mediaRoot)) return { byDevice, total };
  for (const entry of fs.readdirSync(mediaRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let deviceTotal = 0;
    const dir = path.join(mediaRoot, entry.name);
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      // Committed top-level media counts toward the logical quota. Hidden
      // staging files are represented by reservations, while the filesystem
      // free-space check still accounts for their real bytes.
      if (!file.isFile() || file.name.startsWith(".upload-")) continue;
      deviceTotal += fs.statSync(path.join(dir, file.name)).size;
    }
    byDevice.set(entry.name, deviceTotal);
    total += deviceTotal;
  }
  return { byDevice, total };
}

function availableBytes(targetPath, statfs = fs.statfsSync) {
  const stats = statfs(targetPath, { bigint: true });
  const blockSize = BigInt(stats.bsize);
  const availableBlocks = BigInt(stats.bavail ?? stats.bfree);
  const bytes = blockSize * availableBlocks;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
}

export function createMediaQuotaManager({ mediaRoot, perDeviceBytes, globalBytes, minFreeBytes,
  statfs = fs.statfsSync }) {
  fs.mkdirSync(mediaRoot, { recursive: true });
  const reservations = new Set();
  const targets = new Set();
  let usage = committedUsage(mediaRoot);

  function refresh() {
    usage = committedUsage(mediaRoot);
    return usage;
  }

  function begin(deviceId, filename) {
    refresh();
    const targetKey = `${deviceId}\0${filename}`;
    if (targets.has(targetKey)) {
      throw new MediaCapacityError("an upload for this filename is already in progress", 409, "MEDIA_UPLOAD_CONFLICT");
    }
    const target = path.join(mediaRoot, deviceId, filename);
    const replacementBytes = fs.existsSync(target) && fs.statSync(target).isFile()
      ? fs.statSync(target).size
      : 0;
    const reservation = { deviceId, filename, targetKey, replacementBytes, bytes: 0, active: true };
    reservations.add(reservation);
    targets.add(targetKey);
    return reservation;
  }

  function consume(reservation, byteCount) {
    if (!reservation?.active || !reservations.has(reservation)) throw new Error("media reservation is not active");
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) throw new Error("invalid media reservation byte count");
    const nextBytes = reservation.bytes + byteCount;
    let activeGlobal = 0;
    let activeDevice = 0;
    let globalReplacementCredit = 0;
    let deviceReplacementCredit = 0;
    for (const current of reservations) {
      const bytes = current === reservation ? nextBytes : current.bytes;
      activeGlobal += bytes;
      globalReplacementCredit += current.replacementBytes;
      if (current.deviceId === reservation.deviceId) {
        activeDevice += bytes;
        deviceReplacementCredit += current.replacementBytes;
      }
    }
    const logicalDeviceBytes = (usage.byDevice.get(reservation.deviceId) ?? 0)
      - deviceReplacementCredit + activeDevice;
    if (logicalDeviceBytes > perDeviceBytes) {
      throw new MediaCapacityError("device media quota exceeded", 413, "MEDIA_DEVICE_QUOTA",
        { currentBytes: logicalDeviceBytes, maximumBytes: perDeviceBytes });
    }
    const logicalGlobalBytes = usage.total - globalReplacementCredit + activeGlobal;
    if (logicalGlobalBytes > globalBytes) {
      throw new MediaCapacityError("global media quota exceeded", 413, "MEDIA_GLOBAL_QUOTA",
        { currentBytes: logicalGlobalBytes, maximumBytes: globalBytes });
    }
    if (availableBytes(mediaRoot, statfs) - byteCount < minFreeBytes) {
      throw new MediaCapacityError("media storage reserve would be exhausted", 507, "MEDIA_STORAGE_RESERVE",
        { availableBytes: availableBytes(mediaRoot, statfs), minimumFreeBytes: minFreeBytes });
    }
    reservation.bytes = nextBytes;
  }

  function release(reservation) {
    if (!reservation?.active) return;
    reservation.active = false;
    reservations.delete(reservation);
    targets.delete(reservation.targetKey);
  }

  function commit(reservation) {
    release(reservation);
    refresh();
  }

  function abort(reservation) {
    release(reservation);
  }

  return { begin, consume, commit, abort, refresh };
}

export function createQuotaStorage({ ensureDeviceDir, safeFilename, quotaManager }) {
  return {
    _handleFile(req, file, cb) {
      const dir = ensureDeviceDir(req.params.deviceId);
      const name = safeFilename(file.originalname);
      if (!dir) return cb(new Error("invalid device id"));
      if (!name) return cb(new Error("invalid filename"));

      let reservation;
      try {
        reservation = quotaManager.begin(req.params.deviceId, name);
      } catch (error) {
        return cb(error);
      }
      const filename = `.upload-${randomUUID()}.tmp`;
      const uploadPath = path.join(dir, filename);
      const output = fs.createWriteStream(uploadPath, { flags: "wx" });
      const gate = new Transform({
        transform(chunk, encoding, done) {
          try {
            quotaManager.consume(reservation, chunk.length);
            done(null, chunk);
          } catch (error) {
            done(error);
          }
        },
      });

      pipeline(file.stream, gate, output)
        .then(() => cb(null, { destination: dir, filename, path: uploadPath,
          size: reservation.bytes, quotaReservation: reservation }))
        .catch((error) => {
          quotaManager.abort(reservation);
          fs.rmSync(uploadPath, { force: true });
          cb(error);
        });
    },

    _removeFile(req, file, cb) {
      quotaManager.abort(file.quotaReservation);
      if (!file.path) return cb(null);
      fs.rm(file.path, { force: true }, cb);
    },
  };
}
