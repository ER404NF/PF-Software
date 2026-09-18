import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { encryptTotpSecret, decryptTotpSecret } from "./twoFactor.js";

// A shared pool of proxy credentials an Admin configures once — Phase B of
// Phone_Farm_Automation_Architecture.md §4.6/§13. Entering credentials here
// is the "ask for information" half of the "ask once, then automate"
// tunnel flow; actually starting the tunnel (TUN/PF) is a later Phase B
// step and does not exist yet — this module only owns the pool and the
// exclusive per-device lease, matching the architecture guide's
// AVAILABLE -> LEASED(deviceId) -> RELEASED -> AVAILABLE state machine.
//
// Passwords are encrypted at rest with the same AES-256-GCM helpers
// twoFactor.js already uses for TOTP secrets (same master-key convention:
// PROXY_CREDENTIAL_ENCRYPTION_KEY, defaulting to TWO_FACTOR_MASTER_KEY —
// mirrors accountNotificationStore.js's ACCOUNT_NOTIFICATION_ENCRYPTION_KEY
// pattern). Never call the internal (with-credentials) accessors from a
// route that returns JSON to the browser — use publicProxy()/publicProxies().

const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
const PROTOCOLS = new Set(["http", "https", "socks5"]);
const ID_PREFIX = "px_";

function readRaw(storePath) {
  if (!fs.existsSync(storePath)) return { proxies: {} };
  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || typeof parsed.proxies !== "object"
    || parsed.proxies === null || Array.isArray(parsed.proxies)) {
    throw new Error("proxy pool store is corrupt: expected { proxies: {} }");
  }
  return parsed;
}

function writeRaw(storePath, raw) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporary = path.join(path.dirname(storePath), `.${path.basename(storePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, storePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function poolError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Regional-indicator flag emoji derived from the stored 2-letter code —
// never persisted, so it can't go stale relative to `country`.
export function flagForCountry(countryCode) {
  if (!COUNTRY_CODE_RE.test(countryCode || "")) return null;
  return String.fromCodePoint(...[...countryCode].map(char => 127397 + char.charCodeAt(0)));
}

function validateFields({ provider, protocol, host, port, username, country, label }) {
  if (typeof provider !== "string" || !provider.trim() || provider.length > 100) {
    throw poolError("provider is required (max 100 characters)", 400);
  }
  if (!PROTOCOLS.has(protocol)) throw poolError(`protocol must be one of ${[...PROTOCOLS].join(", ")}`, 400);
  if (typeof host !== "string" || !host.trim() || host.length > 255) throw poolError("host is required", 400);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw poolError("port must be an integer from 1 to 65535", 400);
  if (typeof username !== "string" || !username.trim() || username.length > 200) throw poolError("username is required", 400);
  if (typeof country !== "string" || !COUNTRY_CODE_RE.test(country.toUpperCase())) {
    throw poolError("country must be a 2-letter ISO code", 400);
  }
  if (label !== undefined && label !== null && (typeof label !== "string" || label.length > 100)) {
    throw poolError("label must be at most 100 characters", 400);
  }
}

// Internal — includes host/port/username/passwordEncrypted. Never returned
// from an HTTP route; only the TUN-automation step (not built yet) and
// publicProxy() may read these fields.
export function loadProxyRecords(storePath) {
  return readRaw(storePath).proxies;
}

export function getProxyRecord(storePath, proxyId) {
  return readRaw(storePath).proxies[proxyId] ?? null;
}

// Decrypts and returns the plaintext password for one proxy. Only ever call
// this server-side, immediately before using the credential (e.g. building
// a tun2proxy proxy URL) — never log or return the result.
export function decryptProxyPassword(record, masterKey) {
  return decryptTotpSecret(record.passwordEncrypted, masterKey);
}

export function createProxy(storePath, fields, masterKey) {
  validateFields(fields);
  const raw = readRaw(storePath);
  const now = new Date().toISOString();
  const id = `${ID_PREFIX}${randomUUID()}`;
  const record = {
    id,
    provider: fields.provider.trim(),
    protocol: fields.protocol,
    host: fields.host.trim(),
    port: fields.port,
    username: fields.username.trim(),
    passwordEncrypted: encryptTotpSecret(fields.password, masterKey),
    country: fields.country.toUpperCase(),
    label: fields.label?.trim() || `${fields.provider.trim()} ${fields.country.toUpperCase()}`,
    leasedToDeviceId: null,
    createdAt: now,
    updatedAt: now,
  };
  raw.proxies[id] = record;
  writeRaw(storePath, raw);
  return record;
}

export function deleteProxy(storePath, proxyId) {
  const raw = readRaw(storePath);
  const record = raw.proxies[proxyId];
  if (!record) return false;
  if (record.leasedToDeviceId) throw poolError("release this proxy from its assigned device before deleting it", 409);
  delete raw.proxies[proxyId];
  writeRaw(storePath, raw);
  return true;
}

// Exclusive lease: a proxy already leased to a different device is refused
// (Architecture guide §4.6 — "a proxy assigned to Device A must not appear
// as selectable for Device B"). Re-leasing the same proxy to the device
// that already holds it is a no-op success. Passing `proxyId: null`
// releases whatever this device currently holds.
export function assignProxyToDevice(storePath, { deviceId, proxyId }) {
  if (typeof deviceId !== "string" || !deviceId) throw poolError("deviceId is required", 400);
  const raw = readRaw(storePath);
  const now = new Date().toISOString();

  const current = Object.values(raw.proxies).find(record => record.leasedToDeviceId === deviceId);
  if (proxyId === null) {
    if (!current) return null;
    raw.proxies[current.id] = { ...current, leasedToDeviceId: null, updatedAt: now };
    writeRaw(storePath, raw);
    return null;
  }

  const target = raw.proxies[proxyId];
  if (!target) throw poolError("unknown proxy", 404);
  if (target.leasedToDeviceId && target.leasedToDeviceId !== deviceId) {
    throw poolError("this proxy is already assigned to another device", 409);
  }
  if (current && current.id !== proxyId) {
    raw.proxies[current.id] = { ...current, leasedToDeviceId: null, updatedAt: now };
  }
  raw.proxies[proxyId] = { ...target, leasedToDeviceId: deviceId, updatedAt: now };
  writeRaw(storePath, raw);
  return raw.proxies[proxyId];
}

export function proxyForDevice(storePath, deviceId) {
  return Object.values(loadProxyRecords(storePath)).find(record => record.leasedToDeviceId === deviceId) ?? null;
}

// Safe shape for any HTTP response: no host, port, username, or password —
// "the UI should never use proxy credentials as a unique ID" and "do not
// display passwords" (Architecture guide §2.3, §13).
export function publicProxy(record) {
  if (!record) return null;
  return {
    id: record.id,
    provider: record.provider,
    protocol: record.protocol,
    country: record.country,
    flag: flagForCountry(record.country),
    label: record.label,
    leasedToDeviceId: record.leasedToDeviceId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function publicProxies(storePath) {
  return Object.values(loadProxyRecords(storePath)).map(publicProxy)
    .sort((a, b) => a.label.localeCompare(b.label));
}
