import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ROUTING_HOST_STATES,
  RoutingQuarantineStoreError,
  clearRoutingQuarantineState,
  readRoutingQuarantineState,
  repairRoutingQuarantineState,
  verifyRoutingQuarantineStorage,
  writeRoutingQuarantineState,
} from "../../src/routingQuarantineStore.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-routing-quarantine-"));
  return path.join(root, "routing-quarantine.json");
}

function quarantine() {
  return {
    version: 1,
    state: ROUTING_HOST_STATES.QUARANTINING,
    bridgeIface: "bridge0",
    reasonCode: "F202",
    timestamp: new Date().toISOString(),
    manualInterventionRequired: true,
    affectedDeviceIds: ["mock-1", "mock-1"],
    affectedDeviceInventoryComplete: true,
  };
}

test("quarantine state is atomically persisted without sensitive extra fields", () => {
  const storePath = fixture();
  writeRoutingQuarantineState(storePath, { ...quarantine(), password: "must-not-persist" }, "bridge0");
  const raw = fs.readFileSync(storePath, "utf8");
  assert.doesNotMatch(raw, /password|must-not-persist/);
  assert.deepEqual(readRoutingQuarantineState(storePath, "bridge0").affectedDeviceIds, ["mock-1"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
});

test("malformed or bridge-mismatched state fails closed and is never replaced", () => {
  const storePath = fixture();
  fs.writeFileSync(storePath, "{broken", { mode: 0o600 });
  assert.throws(() => readRoutingQuarantineState(storePath, "bridge0"), RoutingQuarantineStoreError);
  assert.throws(() => writeRoutingQuarantineState(storePath, quarantine(), "bridge0"), RoutingQuarantineStoreError);
  assert.equal(fs.readFileSync(storePath, "utf8"), "{broken");
  fs.writeFileSync(storePath, JSON.stringify(quarantine()), { mode: 0o600 });
  assert.throws(() => readRoutingQuarantineState(storePath, "bridge9"), RoutingQuarantineStoreError);
});

test("explicit clear is idempotent", () => {
  const storePath = fixture();
  writeRoutingQuarantineState(storePath, quarantine(), "bridge0");
  clearRoutingQuarantineState(storePath);
  clearRoutingQuarantineState(storePath);
  assert.equal(fs.existsSync(storePath), false);
});

test("explicit repair preserves malformed bytes in an owner-only backup and writes bounded recovery state", () => {
  const storePath = fixture();
  const original = Buffer.from("{malformed-private-bytes");
  fs.writeFileSync(storePath, original, { mode: 0o600 });
  const next = { ...quarantine(), state: ROUTING_HOST_STATES.RECOVERY_REQUIRED,
    reasonCode: "ROUTING_STATE_REPAIRED" };
  const repaired = repairRoutingQuarantineState(storePath, next, "bridge0");
  assert.equal(repaired.state.state, ROUTING_HOST_STATES.RECOVERY_REQUIRED);
  assert.ok(repaired.backupId);
  const backup = `${storePath}.invalid-${repaired.backupId}.bak`;
  assert.deepEqual(fs.readFileSync(backup), original);
  if (process.platform !== "win32") assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(readRoutingQuarantineState(storePath, "bridge0").reasonCode, "ROUTING_STATE_REPAIRED");
});

test("wrong bridge, missing fields, directories, and storage failures remain fail closed", () => {
  const wrongBridge = fixture();
  fs.writeFileSync(wrongBridge, JSON.stringify({ ...quarantine(), bridgeIface: "bridge9" }), { mode: 0o600 });
  assert.throws(() => readRoutingQuarantineState(wrongBridge, "bridge0"), RoutingQuarantineStoreError);

  const missing = fixture();
  fs.writeFileSync(missing, JSON.stringify({ state: "quarantined" }), { mode: 0o600 });
  assert.throws(() => readRoutingQuarantineState(missing, "bridge0"), RoutingQuarantineStoreError);

  const directory = fixture();
  fs.mkdirSync(directory);
  assert.throws(() => readRoutingQuarantineState(directory, "bridge0"), RoutingQuarantineStoreError);
  assert.throws(() => repairRoutingQuarantineState(directory, quarantine(), "bridge0"), RoutingQuarantineStoreError);

  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pf-routing-quarantine-blocked-"));
  const blockedParent = path.join(blockedRoot, "not-a-directory");
  fs.writeFileSync(blockedParent, "not-a-directory");
  const blockedStore = path.join(blockedParent, "routing-quarantine.json");
  assert.throws(() => verifyRoutingQuarantineStorage(blockedStore), RoutingQuarantineStoreError);
});

test("a primary atomic-write failure leaves a bounded durable failure marker for the next process", () => {
  const storePath = fixture();
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === storePath) throw Object.assign(new Error("injected private failure secret=value"), { code: "EACCES" });
    return originalRename(from, to);
  };
  try {
    assert.throws(() => writeRoutingQuarantineState(storePath, quarantine(), "bridge0"), /injected/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.existsSync(storePath), false);
  const restarted = readRoutingQuarantineState(storePath, "bridge0");
  assert.equal(restarted.state, ROUTING_HOST_STATES.RECOVERY_REQUIRED);
  assert.deepEqual(restarted.affectedDeviceIds, ["mock-1"]);
  assert.equal(restarted.affectedDeviceInventoryComplete, true);
  const markerPath = `${storePath}.failure`;
  const marker = fs.readFileSync(markerPath, "utf8");
  assert.match(marker, /ROUTING_QUARANTINE_PERSIST_FAILED/);
  assert.doesNotMatch(marker, /private|secret|value|EACCES/i);
  assert.deepEqual(fs.readdirSync(path.dirname(storePath)).filter(name => name.endsWith(".tmp")), []);
  if (process.platform !== "win32") assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600);
});

test("a repair failure after preserving the original still leaves restart-safe blocking evidence", () => {
  const storePath = fixture();
  fs.writeFileSync(storePath, "{broken", { mode: 0o600 });
  const originalChmod = fs.chmodSync;
  fs.chmodSync = () => { throw Object.assign(new Error("permission denied private/path"), { code: "EACCES" }); };
  try {
    assert.throws(() => repairRoutingQuarantineState(storePath, quarantine(), "bridge0"), RoutingQuarantineStoreError);
  } finally {
    fs.chmodSync = originalChmod;
  }
  const restarted = readRoutingQuarantineState(storePath, "bridge0");
  assert.equal(restarted.state, ROUTING_HOST_STATES.RECOVERY_REQUIRED);
  assert.equal(restarted.stateUnreadable, true);
  const names = fs.readdirSync(path.dirname(storePath));
  assert.equal(names.some(name => name.includes(".invalid-") && name.endsWith(".bak")), true);
  const marker = fs.readFileSync(`${storePath}.failure`, "utf8");
  assert.doesNotMatch(marker, /permission|private|path|EACCES/i);
});

test("a malformed failure marker remains fail closed and cannot supply a guessed inventory", () => {
  const storePath = fixture();
  fs.writeFileSync(`${storePath}.failure`, "{broken-marker", { mode: 0o600 });
  assert.throws(
    () => readRoutingQuarantineState(storePath, "bridge0"),
    error => error instanceof RoutingQuarantineStoreError && error.failureMarkerInvalid === true,
  );
  assert.equal(fs.readFileSync(`${storePath}.failure`, "utf8"), "{broken-marker");
});
