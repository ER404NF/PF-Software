import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// Persisted result of the guide's §4.4/§4.5 human-paced enrollment steps —
// which USB bridge member and which private IPv4 belong to a given device.
// Same atomic write-temp-then-rename shape as deviceProvisioningStore.js,
// deliberately a separate file/concern: that store is Phase A's WDA
// port/derived-data assignment, this one is Phase B's network identity.
// Keyed by logical device id (not UDID) — routes and clients here only
// ever handle the logical id, same reasoning as deviceProvisioner.js's
// retryDevice().

function readRaw(storePath) {
  if (!fs.existsSync(storePath)) return { devices: {} };
  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || typeof parsed.devices !== "object"
    || parsed.devices === null || Array.isArray(parsed.devices)) {
    throw new Error("USB network store is corrupt: expected { devices: {} }");
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

export function getUsbNetworkRecord(storePath, deviceId) {
  return readRaw(storePath).devices[deviceId] ?? null;
}

// For callers that want to cache the whole store in memory (index.js's
// summary() would otherwise do a synchronous disk read per device per
// connected client on every device_list broadcast — the same reasoning
// proxyPoolCache already exists for) rather than calling
// getUsbNetworkRecord() repeatedly.
export function loadUsbNetworkRecords(storePath) {
  return readRaw(storePath).devices;
}

export function setUsbIface(storePath, deviceId, usbIface) {
  const raw = readRaw(storePath);
  const now = new Date().toISOString();
  const existing = raw.devices[deviceId];
  raw.devices[deviceId] = { usbIface, usbIp: null, createdAt: existing?.createdAt ?? now, updatedAt: now };
  writeRaw(storePath, raw);
  return raw.devices[deviceId];
}

export function setUsbIp(storePath, deviceId, usbIp) {
  const raw = readRaw(storePath);
  const existing = raw.devices[deviceId];
  if (!existing) throw new Error("network enrollment must complete before recording a discovered IP");
  raw.devices[deviceId] = { ...existing, usbIp, updatedAt: new Date().toISOString() };
  writeRaw(storePath, raw);
  return raw.devices[deviceId];
}

export function clearUsbNetworkRecord(storePath, deviceId) {
  const raw = readRaw(storePath);
  if (!(deviceId in raw.devices)) return false;
  delete raw.devices[deviceId];
  writeRaw(storePath, raw);
  return true;
}
