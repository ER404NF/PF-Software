import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export const ROUTING_HOST_STATES = Object.freeze({
  HEALTHY: "healthy",
  QUARANTINING: "quarantining",
  QUARANTINED: "quarantined",
  RECOVERY_REQUIRED: "recovery_required",
});

const BLOCKING_STATES = new Set([
  ROUTING_HOST_STATES.QUARANTINING,
  ROUTING_HOST_STATES.QUARANTINED,
  ROUTING_HOST_STATES.RECOVERY_REQUIRED,
]);

const MAX_STATE_BYTES = 64 * 1024;

function failureMarkerPath(storePath) {
  return `${storePath}.failure`;
}

export class RoutingQuarantineStoreError extends Error {
  constructor(message = "routing quarantine state is corrupt or unreadable and requires explicit repair") {
    super(message);
    this.name = "RoutingQuarantineStoreError";
    this.code = "ROUTING_QUARANTINE_STATE_INVALID";
    this.status = 503;
    this.expose = true;
  }
}

export function isRoutingHostBlocked(state) {
  return BLOCKING_STATES.has(state?.state);
}

function validate(raw, bridgeIface) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RoutingQuarantineStoreError();
  if (!BLOCKING_STATES.has(raw.state)) throw new RoutingQuarantineStoreError();
  if (raw.bridgeIface !== bridgeIface) throw new RoutingQuarantineStoreError();
  if (typeof raw.reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(raw.reasonCode)) throw new RoutingQuarantineStoreError();
  if (typeof raw.timestamp !== "string" || !Number.isFinite(Date.parse(raw.timestamp))) throw new RoutingQuarantineStoreError();
  if (raw.manualInterventionRequired !== true) throw new RoutingQuarantineStoreError();
  if (!Array.isArray(raw.affectedDeviceIds)
    || raw.affectedDeviceIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id))) {
    throw new RoutingQuarantineStoreError();
  }
  return {
    version: 1,
    state: raw.state,
    bridgeIface,
    reasonCode: raw.reasonCode,
    timestamp: raw.timestamp,
    manualInterventionRequired: true,
    affectedDeviceIds: [...new Set(raw.affectedDeviceIds)],
    affectedDeviceInventoryComplete: raw.affectedDeviceInventoryComplete === true,
    ...(raw.primaryStateInvalid === true ? { primaryStateInvalid: true, stateUnreadable: true } : {}),
  };
}

function readBoundedJsonFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    throw new RoutingQuarantineStoreError();
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readRoutingQuarantineState(storePath, bridgeIface) {
  if (!storePath) return null;
  const markerPath = failureMarkerPath(storePath);
  if (fs.existsSync(markerPath)) {
    try { return validate(readBoundedJsonFile(markerPath), bridgeIface); }
    catch {
      const error = new RoutingQuarantineStoreError(
        "routing quarantine persistence previously failed and requires explicit repair",
      );
      error.failureMarkerInvalid = true;
      throw error;
    }
  }
  if (!fs.existsSync(storePath)) return null;
  try {
    return validate(readBoundedJsonFile(storePath), bridgeIface);
  } catch (error) {
    if (error instanceof RoutingQuarantineStoreError) throw error;
    throw new RoutingQuarantineStoreError();
  }
}

function writeFailureMarker(storePath, bridgeIface, state = null, { primaryStateInvalid = false } = {}) {
  if (!storePath) return;
  const markerPath = failureMarkerPath(storePath);
  const temporary = `${markerPath}.${randomUUID()}.tmp`;
  const marker = {
    version: 1,
    state: ROUTING_HOST_STATES.RECOVERY_REQUIRED,
    bridgeIface,
    reasonCode: "ROUTING_QUARANTINE_PERSIST_FAILED",
    timestamp: new Date().toISOString(),
    manualInterventionRequired: true,
    affectedDeviceIds: Array.isArray(state?.affectedDeviceIds) ? state.affectedDeviceIds : [],
    affectedDeviceInventoryComplete: state?.affectedDeviceInventoryComplete === true,
    ...(primaryStateInvalid ? { primaryStateInvalid: true } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    fs.renameSync(temporary, markerPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function verifyRoutingQuarantineStorage(storePath) {
  if (!storePath) return true;
  const directory = path.dirname(storePath);
  const probe = path.join(directory, `.${path.basename(storePath)}.${randomUUID()}.probe`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    throw new RoutingQuarantineStoreError(
      "routing quarantine storage is unavailable and requires host repair",
    );
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch { /* fail closed on the next probe */ }
  }
}

export function writeRoutingQuarantineState(storePath, state, bridgeIface) {
  if (!storePath) return validate(state, bridgeIface);
  const safe = validate(state, bridgeIface);
  // A damaged authority file is evidence that host safety is unknown. Never
  // overwrite it with a new apparently-valid record during automatic work.
  if (fs.existsSync(storePath)) readRoutingQuarantineState(storePath, bridgeIface);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporary = path.join(path.dirname(storePath), `.${path.basename(storePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    fs.renameSync(temporary, storePath);
  } catch (error) {
    try { writeFailureMarker(storePath, bridgeIface, safe); } catch { /* the startup storage probe remains fail closed */ }
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return safe;
}

export function clearRoutingQuarantineState(storePath) {
  if (!storePath) return;
  if (fs.existsSync(storePath)) fs.rmSync(storePath);
  const markerPath = failureMarkerPath(storePath);
  if (fs.existsSync(markerPath)) fs.rmSync(markerPath);
}

export function repairRoutingQuarantineState(storePath, state, bridgeIface) {
  if (!storePath) throw new RoutingQuarantineStoreError();
  const safe = validate(state, bridgeIface);
  const markerPath = failureMarkerPath(storePath);
  let backupId = null;
  try {
    if (fs.existsSync(storePath)) {
      let stat;
      try { stat = fs.lstatSync(storePath); } catch { throw new RoutingQuarantineStoreError(); }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
        throw new RoutingQuarantineStoreError();
      }
      // Prove that the original can be read before moving it. The bytes are
      // never parsed into a response or log.
      try { fs.readFileSync(storePath); } catch { throw new RoutingQuarantineStoreError(); }
      backupId = randomUUID();
      const backupPath = `${storePath}.invalid-${backupId}.bak`;
      fs.renameSync(storePath, backupPath);
      try { fs.chmodSync(backupPath, 0o600); } catch { throw new RoutingQuarantineStoreError(); }
    }
    if (fs.existsSync(markerPath)) fs.rmSync(markerPath);
    const persisted = writeRoutingQuarantineState(storePath, safe, bridgeIface);
    return { state: persisted, backupId };
  } catch (error) {
    try { writeFailureMarker(storePath, bridgeIface, safe, { primaryStateInvalid: true }); } catch { /* startup storage probe remains fail closed */ }
    throw error;
  }
}
