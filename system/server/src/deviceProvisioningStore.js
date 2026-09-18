import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// Persisted "what did we already assign this physical phone last time"
// registry — separate from devices.config.json, which stays for explicit,
// hand-pinned entries (mock devices, a manually configured hardware-
// validation phone). Keyed by UDID so a replug or relay restart reuses the
// same logical id, WDA local port, and derived-data path instead of
// drifting (Automation Architecture guide §3, §6 step 5c: "reserve/restore
// WDA local port").

function readRaw(storePath) {
  if (!fs.existsSync(storePath)) return { devices: {} };
  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || typeof parsed.devices !== "object"
    || parsed.devices === null || Array.isArray(parsed.devices)) {
    throw new Error("device-provisioning store is corrupt: expected { devices: {} }");
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

export function loadProvisioningRecords(storePath) {
  return readRaw(storePath).devices;
}

export function getProvisioningRecord(storePath, udid) {
  return readRaw(storePath).devices[udid] ?? null;
}

// Merges `patch` into the existing record for `udid` (or creates one) and
// persists atomically (write-temp-then-rename, matching deviceNetworkStore.js).
export function upsertProvisioningRecord(storePath, udid, patch = {}) {
  if (typeof udid !== "string" || !/^[A-Za-z0-9-]{8,100}$/.test(udid)) throw new Error("invalid UDID");
  const raw = readRaw(storePath);
  const now = new Date().toISOString();
  const existing = raw.devices[udid];
  const record = {
    udid,
    logicalId: patch.logicalId ?? existing?.logicalId,
    displayName: patch.displayName ?? existing?.displayName ?? null,
    wdaLocalPort: patch.wdaLocalPort ?? existing?.wdaLocalPort ?? null,
    derivedDataPath: patch.derivedDataPath ?? existing?.derivedDataPath ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (!record.logicalId) throw new Error("provisioning record requires a logicalId");
  raw.devices[udid] = record;
  writeRaw(storePath, raw);
  return record;
}

// Not called on ordinary detach (the architecture guide is explicit: "keep
// the stable registry entry keyed by UDID" so a replug doesn't re-enroll).
// This is for an explicit future "forget this device" admin action.
export function removeProvisioningRecord(storePath, udid) {
  const raw = readRaw(storePath);
  if (!(udid in raw.devices)) return false;
  delete raw.devices[udid];
  writeRaw(storePath, raw);
  return true;
}
