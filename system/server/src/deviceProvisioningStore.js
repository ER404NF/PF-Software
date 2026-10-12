import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";

// Persisted "what did we already assign this physical phone last time"
// registry — separate from devices.config.json, which stays for explicit,
// hand-pinned entries (mock devices, a manually configured hardware-
// validation phone). Keyed by UDID so a replug or relay restart reuses the
// same logical id, WDA local port, and derived-data path instead of
// drifting (Automation Architecture guide §3, §6 step 5c: "reserve/restore
// WDA local port").

export class ProvisioningStoreError extends Error {
  constructor() {
    super("device provisioning state is corrupt or unreadable and requires explicit repair");
    this.name = "ProvisioningStoreError";
    this.code = "provisioning_state_corrupt";
    this.status = 409;
  }
}

function corrupt() {
  return new ProvisioningStoreError();
}

function validateRecord(udid, record) {
  if (!/^[A-Za-z0-9-]{8,100}$/.test(udid) || !record || typeof record !== "object" || Array.isArray(record)) throw corrupt();
  if (record.udid != null && record.udid !== udid) throw corrupt();
  if (typeof record.logicalId !== "string" || !record.logicalId) throw corrupt();
  for (const field of ["wdaLocalPort", "mjpegLocalPort"]) {
    if (record[field] != null && (!Number.isSafeInteger(record[field]) || record[field] < 1 || record[field] > 65535)) throw corrupt();
  }
  for (const field of ["displayName", "derivedDataPath", "createdAt", "updatedAt"]) {
    if (record[field] != null && typeof record[field] !== "string") throw corrupt();
  }
  if (record.lifecycleIntent != null && !["running", "stopped"].includes(record.lifecycleIntent)) throw corrupt();
  if (record.wdaEnabled != null && typeof record.wdaEnabled !== "boolean") throw corrupt();
}

function readRaw(storePath) {
  if (!fs.existsSync(storePath)) return { devices: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    throw corrupt();
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.devices !== "object"
    || parsed.devices === null || Array.isArray(parsed.devices)) {
    throw corrupt();
  }
  parsed.devices = Object.fromEntries(Object.entries(parsed.devices).map(([udid, record]) => {
    validateRecord(udid, record);
    const lifecycleIntent = record.lifecycleIntent === "running" || record.lifecycleIntent === "stopped"
      ? record.lifecycleIntent
      : record.wdaEnabled === true ? "running" : "stopped";
    return [udid, { ...record, lifecycleIntent, wdaEnabled: lifecycleIntent === "running" }];
  }));
  return parsed;
}

// Explicit, operator-initiated repair. The original bytes are preserved beside
// the store as evidence; automatic startup never invokes this operation.
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function planProvisioningStoreRepair(storePath) {
  if (!fs.existsSync(storePath)) return { kind: "not_found", repairId: randomUUID(), digest: null,
    validDevices: {}, invalidDevices: {}, preservedCount: 0, quarantinedCount: 0 };
  let bytes;
  try { bytes = fs.readFileSync(storePath); }
  catch { throw corrupt(); }
  const repairId = randomUUID();
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch {
    return { kind: "structurally_unreadable", repairId, digest: digest(bytes), originalBytes: bytes,
      validDevices: {}, invalidDevices: {}, preservedCount: 0, quarantinedCount: 0, unrecoverableCount: 1 };
  }
  if (!parsed || typeof parsed !== "object" || !parsed.devices || typeof parsed.devices !== "object"
    || Array.isArray(parsed.devices)) {
    return { kind: "structurally_unreadable", repairId, digest: digest(bytes), originalBytes: bytes,
      validDevices: {}, invalidDevices: {}, preservedCount: 0, quarantinedCount: 0, unrecoverableCount: 1 };
  }
  const validDevices = {};
  const invalidDevices = {};
  for (const [udid, record] of Object.entries(parsed.devices)) {
    try {
      validateRecord(udid, record);
      const lifecycleIntent = record.lifecycleIntent === "running" || record.lifecycleIntent === "stopped"
        ? record.lifecycleIntent : record.wdaEnabled === true ? "running" : "stopped";
      validDevices[udid] = { ...record, lifecycleIntent, wdaEnabled: lifecycleIntent === "running" };
    } catch (error) {
      if (!(error instanceof ProvisioningStoreError)) throw error;
      invalidDevices[udid] = record;
    }
  }
  return {
    kind: Object.keys(invalidDevices).length ? "selective" : "not_corrupt",
    repairId,
    digest: digest(bytes),
    originalBytes: bytes,
    validDevices,
    invalidDevices,
    preservedCount: Object.keys(validDevices).length,
    quarantinedCount: Object.keys(invalidDevices).length,
    unrecoverableCount: Object.keys(invalidDevices).length,
  };
}

export function applyProvisioningStoreRepair(storePath, plan, { destructiveReset = false } = {}) {
  if (plan.kind === "not_found") return { repaired: false, reason: "not_found", repairId: plan.repairId,
    preservedCount: 0, quarantinedCount: 0, unrecoverableCount: 0, manualRepairRequired: false };
  const current = fs.readFileSync(storePath);
  if (digest(current) !== plan.digest) {
    const error = new ProvisioningStoreError();
    error.code = "provisioning_state_changed";
    throw error;
  }
  if (plan.kind === "not_corrupt") return { repaired: false, reason: "not_corrupt", repairId: plan.repairId,
    preservedCount: plan.preservedCount, quarantinedCount: 0, unrecoverableCount: 0, manualRepairRequired: false };
  if (plan.kind === "structurally_unreadable" && !destructiveReset) {
    return { repaired: false, reason: "destructive_reset_required", repairId: plan.repairId,
      preservedCount: 0, quarantinedCount: 0, unrecoverableCount: plan.unrecoverableCount,
      manualRepairRequired: true };
  }

  const backupPath = `${storePath}.corrupt-${plan.repairId}.bak`;
  const quarantinePath = `${storePath}.quarantine-${plan.repairId}.json`;
  if (fs.existsSync(backupPath) || fs.existsSync(quarantinePath)) throw corrupt();
  fs.writeFileSync(backupPath, current, { flag: "wx", mode: 0o600 });
  try {
    if (plan.kind === "selective" && plan.quarantinedCount > 0) {
      fs.writeFileSync(quarantinePath, `${JSON.stringify({ devices: plan.invalidDevices }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    writeRaw(storePath, { devices: plan.kind === "selective" ? plan.validDevices : {} });
  } catch (error) {
    try { fs.writeFileSync(storePath, current, { mode: 0o600 }); } catch { /* backup remains authoritative */ }
    throw error;
  }
  return {
    repaired: true,
    reason: plan.kind === "selective" ? "selective_repair" : "destructive_reset",
    repairId: plan.repairId,
    preservedCount: plan.preservedCount,
    quarantinedCount: plan.quarantinedCount,
    unrecoverableCount: plan.unrecoverableCount,
    manualRepairRequired: false,
  };
}

export function repairProvisioningStore(storePath, options = {}) {
  const plan = planProvisioningStoreRepair(storePath);
  return applyProvisioningStoreRepair(storePath, plan, options);
}

function writeRaw(storePath, raw) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporary = path.join(path.dirname(storePath), `.${path.basename(storePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
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
  const requestedIntent = patch.lifecycleIntent === "running" || patch.lifecycleIntent === "stopped"
    ? patch.lifecycleIntent
    : typeof patch.wdaEnabled === "boolean" ? (patch.wdaEnabled ? "running" : "stopped")
      : existing?.lifecycleIntent ?? "stopped";
  const record = {
    udid,
    logicalId: patch.logicalId ?? existing?.logicalId,
    displayName: patch.displayName ?? existing?.displayName ?? null,
    wdaLocalPort: patch.wdaLocalPort ?? existing?.wdaLocalPort ?? null,
    mjpegLocalPort: patch.mjpegLocalPort ?? existing?.mjpegLocalPort ?? null,
    derivedDataPath: patch.derivedDataPath ?? existing?.derivedDataPath ?? null,
    lifecycleIntent: requestedIntent,
    wdaEnabled: requestedIntent === "running",
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
