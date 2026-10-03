import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ACTIVE_STATES = new Set(["awaiting_identity_verification", "awaiting_account_lock", "account_locked", "processing", "retryable_failed"]);
const REQUEST_STATES = new Set([...ACTIVE_STATES, "failed", "completed"]);
const PROCESSING_STATES = new Set(["account_locked", "processing", "retryable_failed"]);
const MAX_REQUESTS = 10_000;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const TOMBSTONE_PATTERN = /^deleted-[a-f0-9]{24}$/;

function validateDigest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("privacy request lookup digest is invalid");
  }
  return value;
}

function validateUsername(value, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== "string" || !USERNAME_PATTERN.test(value)) {
    throw new Error("privacy request username is invalid");
  }
  return value;
}

function validateTombstone(value, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== "string" || !TOMBSTONE_PATTERN.test(value)) {
    throw new Error("privacy request tombstone is invalid");
  }
  return value;
}

function safeRequest(request) {
  return {
    id: request.id,
    source: request.source,
    status: request.status,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    identityVerifiedAt: request.identityVerifiedAt ?? null,
    failureCode: request.failureCode ?? null,
    attempt: request.attempt ?? 0,
    completedAt: request.completedAt ?? null,
  };
}

function validDate(value, { optional = false } = {}) {
  return optional && value == null ? true : typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validProgress(progress) {
  if (progress === undefined) return true;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return false;
  return Object.entries(progress).every(([category, summary]) => /^[a-z][a-z0-9_]{0,63}$/.test(category)
    && summary && typeof summary === "object" && !Array.isArray(summary)
    && Object.entries(summary).every(([key, count]) => /^[a-z][a-z0-9_]{0,63}$/.test(key)
      && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000));
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || typeof request.id !== "string" || !/^[a-f0-9-]{36}$/.test(request.id)
    || !REQUEST_STATES.has(request.status)
    || (request.source !== "public" && request.source !== "self_service")
    || !validDate(request.createdAt) || !validDate(request.updatedAt)
    || !validDate(request.identityVerifiedAt, { optional: true })
    || (request.failureCode !== undefined && request.failureCode !== null && (typeof request.failureCode !== "string" || !/^[a-z0-9_]{1,64}$/.test(request.failureCode)))
    || (request.attempt !== undefined && (!Number.isSafeInteger(request.attempt) || request.attempt < 0))
    || !validDate(request.completedAt, { optional: true })
    || (request.processingToken !== undefined && request.processingToken !== null
      && (typeof request.processingToken !== "string" || !/^[a-f0-9-]{36}$/.test(request.processingToken)))
    || !validProgress(request.progress)) {
    throw new Error("privacy request store contains an invalid record");
  }
  if (request.status === "completed") {
    validateTombstone(request.tombstone);
    if (Object.hasOwn(request, "lookupDigest") || Object.hasOwn(request, "accountUsername")) {
      throw new Error("completed privacy request retains account identity");
    }
  } else {
    validateDigest(request.lookupDigest);
    validateUsername(request.accountUsername, { optional: true });
  }
  if (request.source === "self_service" && request.status !== "completed"
    && (!request.accountUsername || !request.identityVerifiedAt)) {
    throw new Error("privacy request store contains an invalid verified record");
  }
  return request;
}

export function createPrivacyRequestStore({ storePath, now = () => new Date() } = {}) {
  if (typeof storePath !== "string" || !storePath) throw new Error("privacy request store path is required");

  function read() {
    if (!fs.existsSync(storePath)) return [];
    const linkStat = fs.lstatSync(storePath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size > MAX_STORE_BYTES) {
      throw new Error("privacy request store must be a regular file no larger than 8 MiB");
    }
    let contents;
    const handle = fs.openSync(storePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino || stat.size > MAX_STORE_BYTES) {
        throw new Error("privacy request store changed while opening");
      }
      contents = fs.readFileSync(handle, "utf8");
    } finally {
      fs.closeSync(handle);
    }
    const parsed = JSON.parse(contents);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.requests) || parsed.requests.length > MAX_REQUESTS) {
      throw new Error("privacy request store is invalid");
    }
    return parsed.requests.map(validateRequest);
  }

  function write(requests) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
    try {
      const serialized = `${JSON.stringify({ version: 1, requests }, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("privacy request store exceeds 8 MiB");
      fs.writeFileSync(temporary, serialized, {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, storePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function create({ lookupDigest, accountUsername = null, source, identityVerified = false }) {
    validateDigest(lookupDigest);
    validateUsername(accountUsername, { optional: true });
    if (source !== "public" && source !== "self_service") throw new Error("privacy request source is invalid");
    if (typeof identityVerified !== "boolean") throw new Error("identityVerified must be a boolean");
    if (source === "self_service" && (!identityVerified || !accountUsername)) {
      throw new Error("self-service privacy requests require a verified account");
    }
    const requests = read();
    const existing = requests.find(request => ACTIVE_STATES.has(request.status)
      && (request.lookupDigest === lookupDigest
        || (identityVerified && accountUsername && request.accountUsername === accountUsername)));
    if (existing) {
      if (identityVerified && existing.status === "awaiting_identity_verification") {
        const timestamp = now().toISOString();
        const upgraded = {
          ...existing,
          accountUsername,
          source: "self_service",
          status: "awaiting_account_lock",
          updatedAt: timestamp,
          identityVerifiedAt: timestamp,
        };
        requests[requests.indexOf(existing)] = upgraded;
        write(requests);
        return safeRequest(upgraded);
      }
      return safeRequest(existing);
    }
    if (requests.length >= MAX_REQUESTS) throw new Error("privacy request store is at capacity");
    const timestamp = now().toISOString();
    const request = {
      id: crypto.randomUUID(),
      lookupDigest,
      accountUsername,
      source,
      status: identityVerified ? "awaiting_account_lock" : "awaiting_identity_verification",
      createdAt: timestamp,
      updatedAt: timestamp,
      identityVerifiedAt: identityVerified ? timestamp : null,
    };
    write([...requests, request]);
    return safeRequest(request);
  }

  function transition(id, from, status, failureCode = null) {
    const requests = read();
    const index = requests.findIndex(request => request?.id === id);
    if (index < 0) return null;
    if (!from.includes(requests[index].status)) return safeRequest(requests[index]);
    const next = {
      ...requests[index],
      status,
      updatedAt: now().toISOString(),
      ...(failureCode ? { failureCode } : {}),
    };
    requests[index] = next;
    write(requests);
    return safeRequest(next);
  }

  return {
    createPublic(input) {
      return create({ ...input, source: "public", identityVerified: false });
    },
    createVerified(input) {
      return create({ ...input, source: "self_service", identityVerified: true });
    },
    markAccountLocked(id) {
      return transition(id, ["awaiting_account_lock"], "account_locked");
    },
    markFailed(id, failureCode = "account_lock_failed") {
      if (typeof failureCode !== "string" || !/^[a-z0-9_]{1,64}$/.test(failureCode)) {
        throw new Error("privacy request failure code is invalid");
      }
      return transition(id, ["awaiting_account_lock"], "failed", failureCode);
    },
    claimProcessing(id, tombstone) {
      validateTombstone(tombstone);
      const requests = read();
      const index = requests.findIndex(request => request?.id === id);
      if (index < 0 || !PROCESSING_STATES.has(requests[index].status)) return null;
      if (requests[index].status === "processing" && requests[index].processingToken) return null;
      if (requests[index].tombstone && requests[index].tombstone !== tombstone) {
        throw new Error("privacy request tombstone cannot change");
      }
      const processingToken = crypto.randomUUID();
      const next = {
        ...requests[index],
        status: "processing",
        processingToken,
        attempt: (requests[index].attempt ?? 0) + 1,
        failureCode: null,
        updatedAt: now().toISOString(),
        progress: requests[index].progress ?? {},
        tombstone,
      };
      requests[index] = next;
      write(requests);
      return { request: { ...next }, processingToken };
    },
    recoverInterrupted() {
      const requests = read();
      let changed = false;
      const recovered = requests.map(request => {
        if (request.status !== "processing") return request;
        changed = true;
        return { ...request, status: "retryable_failed", processingToken: null,
          failureCode: "processing_interrupted", updatedAt: now().toISOString() };
      });
      if (changed) write(recovered);
      return recovered.filter(request => request.status === "retryable_failed").map(safeRequest);
    },
    checkpoint(id, processingToken, category, summary) {
      if (typeof category !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(category)) throw new Error("privacy category is invalid");
      if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new Error("privacy checkpoint summary is invalid");
      const requests = read();
      const index = requests.findIndex(request => request?.id === id);
      const current = requests[index];
      if (!current || current.status !== "processing" || current.processingToken !== processingToken) return null;
      const next = { ...current, updatedAt: now().toISOString(), progress: {
        ...(current.progress ?? {}), [category]: structuredClone(summary),
      } };
      requests[index] = next;
      write(requests);
      return { ...next };
    },
    markProcessingFailed(id, processingToken, failureCode) {
      if (typeof failureCode !== "string" || !/^[a-z0-9_]{1,64}$/.test(failureCode)) throw new Error("privacy request failure code is invalid");
      const requests = read();
      const index = requests.findIndex(request => request?.id === id);
      const current = requests[index];
      if (!current || current.status !== "processing" || current.processingToken !== processingToken) return null;
      const next = { ...current, status: "retryable_failed", processingToken: null, failureCode, updatedAt: now().toISOString() };
      requests[index] = next;
      write(requests);
      return safeRequest(next);
    },
    markCompleted(id, processingToken) {
      const requests = read();
      const index = requests.findIndex(request => request?.id === id);
      const current = requests[index];
      if (!current || current.status !== "processing" || current.processingToken !== processingToken) return null;
      const timestamp = now().toISOString();
      validateTombstone(current.tombstone);
      const { accountUsername: _accountUsername, lookupDigest: _lookupDigest, ...retained } = current;
      const next = { ...retained, status: "completed", processingToken: null, failureCode: null,
        updatedAt: timestamp, completedAt: timestamp };
      requests[index] = next;
      write(requests);
      return safeRequest(next);
    },
    getForProcessing(id) {
      const request = read().find(item => item.id === id);
      return request ? { ...request, progress: structuredClone(request.progress ?? {}) } : null;
    },
    list() {
      return read().map(request => ({ ...request }));
    },
    listForAccount(accountUsername) {
      validateUsername(accountUsername);
      return read().filter(request => request.accountUsername === accountUsername).map(safeRequest);
    },
  };
}
