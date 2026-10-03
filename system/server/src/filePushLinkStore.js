// P4 build (docs/productionization/P4_DEVICE_PUSH_BUILD.md): short-lived,
// single-use, cryptographically random tokens that let a device's own
// on-device Safari download one specific already-staged file — without ever
// putting a real operator session cookie on a phone. Mirrors this project's
// existing token conventions exactly (siteStore.js's site tokens,
// emailActionService.js's action tokens): a prefixed, base64url random
// token; only its SHA-256 hash is ever persisted; constant-time comparison
// at verification time; consumption is atomic with validation so a network
// retry can never replay it.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const TOKEN_PREFIX = "pfl_"; // "Phone Farm link" — distinct from this project's other token prefixes (site/action/invitation/session).
const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes — a device-facing one-time download link, not a session.
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_ACTIVE_LINKS = 10_000;
const TOKEN_HASH = /^[a-f0-9]{64}$/;

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateLink(link) {
  if (!link || typeof link !== "object" || Array.isArray(link)
    || !TOKEN_HASH.test(link.tokenHash)
    || typeof link.deviceId !== "string" || !link.deviceId || link.deviceId.length > 256
    || typeof link.filename !== "string" || !link.filename || link.filename.length > 1024
    || (link.issuedBy !== null && (typeof link.issuedBy !== "string" || link.issuedBy.length > 256))
    || !validDate(link.issuedAt) || !validDate(link.expiresAt)
    || (link.consumedAt !== null && !validDate(link.consumedAt))) {
    throw new Error("file push link store contains an invalid record");
  }
  return link;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function verifyHash(token, storedHex) {
  const presented = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(storedHex, "hex");
  return presented.length === stored.length && crypto.timingSafeEqual(presented, stored);
}

export function createFilePushLinkStore({ storePath } = {}) {
  if (typeof storePath !== "string" || !storePath) throw new Error("file push link store path is required");

  function read() {
    if (!fs.existsSync(storePath)) return [];
    const linkStat = fs.lstatSync(storePath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size > MAX_STORE_BYTES) {
      throw new Error("file push link store must be a regular file no larger than 1 MiB");
    }
    let contents;
    const handle = fs.openSync(storePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino || stat.size > MAX_STORE_BYTES) {
        throw new Error("file push link store changed while opening");
      }
      contents = fs.readFileSync(handle, "utf8");
    } finally {
      fs.closeSync(handle);
    }
    const value = JSON.parse(contents);
    if (value?.version !== 1 || !Array.isArray(value.links) || value.links.length > MAX_ACTIVE_LINKS) {
      throw new Error("file push link store is invalid");
    }
    return value.links.map(validateLink);
  }

  function write(links) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
    try {
      const serialized = `${JSON.stringify({ version: 1, links }, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("file push link store exceeds 1 MiB");
      fs.writeFileSync(temporary, serialized, {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, storePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  // Bound to exactly one (deviceId, filename) pair. The consuming route
  // never takes deviceId/filename as separate input at all (see
  // index.js's GET /d/:token) — they come only from the token itself, which
  // is a stronger property than accepting them separately and cross-checking
  // for a match: there is no "claim a different device" input to reject in
  // the first place. "Wrong device"/"wrong filename" rejection instead
  // happens at issuance time, via the exact same canAccessDevice/
  // resolveFile checks the existing download route already makes.
  function issue({ deviceId, filename, issuedBy = null, ttlMs = DEFAULT_TTL_MS }) {
    if (typeof deviceId !== "string" || !deviceId || deviceId.length > 256) throw new Error("deviceId is required and must be at most 256 characters");
    if (typeof filename !== "string" || !filename || filename.length > 1024) throw new Error("filename is required and must be at most 1024 characters");
    if (issuedBy !== null && (typeof issuedBy !== "string" || issuedBy.length > 256)) throw new Error("issuedBy must be null or at most 256 characters");
    if (!Number.isFinite(ttlMs) || Math.abs(ttlMs) > 24 * 60 * 60_000) throw new Error("ttlMs must be finite and within 24 hours");
    // Opportunistic pruning of dead entries on every issue, same convention
    // as prunePendingSignupAccounts — keeps the file from growing forever
    // without needing a separate cleanup job for what's a low-volume store.
    const links = read().filter(link => !link.consumedAt && Date.parse(link.expiresAt) > Date.now());
    if (links.length >= MAX_ACTIVE_LINKS) throw new Error("file push link store is at capacity");
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const link = {
      tokenHash: hashToken(token),
      deviceId,
      filename,
      issuedBy,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      consumedAt: null,
    };
    links.push(link);
    write(links);
    return { token, expiresAt: link.expiresAt };
  }

  // Validates and consumes in one step. Returns { deviceId, filename } on
  // success, null otherwise (unknown token, already consumed, or expired) —
  // deliberately one flat outcome shape so a caller can't accidentally
  // branch on "expired" vs "already used" and leak which one it was to an
  // unauthenticated caller (the phone's own Safari has no session to trust).
  function consume(token) {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const links = read();
    const index = links.findIndex(link => verifyHash(token, link.tokenHash));
    if (index < 0) return null;
    const link = links[index];
    if (link.consumedAt || Date.parse(link.expiresAt) <= Date.now()) return null;
    links[index] = { ...link, consumedAt: new Date().toISOString() };
    write(links);
    return { deviceId: link.deviceId, filename: link.filename };
  }

  return { issue, consume };
}
