import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  loadProvisioningRecords, getProvisioningRecord, upsertProvisioningRecord, removeProvisioningRecord,
  repairProvisioningStore,
} from "../../src/deviceProvisioningStore.js";

function tempStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-provisioning-")), "device-provisioning.json");
}

test("loadProvisioningRecords returns an empty map when the store does not exist yet", () => {
  assert.deepEqual(loadProvisioningRecords(tempStorePath()), {});
});

test("upsertProvisioningRecord creates a record and persists it atomically", () => {
  const storePath = tempStorePath();
  const record = upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", {
    logicalId: "ios-abc123",
    displayName: "Studio iPhone",
    wdaLocalPort: 8101,
    derivedDataPath: "/tmp/derived/ios-abc123",
  });
  assert.equal(record.udid, "00008110-ABCDEF1234567890");
  assert.equal(record.wdaLocalPort, 8101);
  assert.ok(fs.existsSync(storePath));
  assert.equal(getProvisioningRecord(storePath, "00008110-ABCDEF1234567890").logicalId, "ios-abc123");
});

test("the provisioning registry is written with owner-only permissions", () => {
  const storePath = tempStorePath();
  upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", { logicalId: "ios-abc123" });
  if (process.platform === "win32") {
    const source = fs.readFileSync(new URL("../../src/deviceProvisioningStore.js", import.meta.url), "utf8");
    assert.match(source, /writeFileSync\(temporary,[\s\S]*?mode: 0o600/);
  } else {
    assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
  }
});

test("upsertProvisioningRecord merges a partial patch into the existing record", () => {
  const storePath = tempStorePath();
  upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", {
    logicalId: "ios-abc123", wdaLocalPort: 8101, derivedDataPath: "/tmp/derived/ios-abc123",
  });
  const updated = upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", { displayName: "Renamed iPhone" });
  assert.equal(updated.wdaLocalPort, 8101);
  assert.equal(updated.displayName, "Renamed iPhone");
  assert.equal(updated.createdAt, getProvisioningRecord(storePath, "00008110-ABCDEF1234567890").createdAt);
});

test("upsertProvisioningRecord rejects an invalid UDID", () => {
  assert.throws(() => upsertProvisioningRecord(tempStorePath(), "bad udid!", { logicalId: "x" }), /invalid UDID/);
});

test("upsertProvisioningRecord requires a logicalId on first creation", () => {
  assert.throws(
    () => upsertProvisioningRecord(tempStorePath(), "00008110-ABCDEF1234567890", { wdaLocalPort: 8101 }),
    /requires a logicalId/
  );
});

test("removeProvisioningRecord deletes an existing record and reports absence otherwise", () => {
  const storePath = tempStorePath();
  upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", { logicalId: "ios-abc123" });
  assert.equal(removeProvisioningRecord(storePath, "00008110-ABCDEF1234567890"), true);
  assert.equal(getProvisioningRecord(storePath, "00008110-ABCDEF1234567890"), null);
  assert.equal(removeProvisioningRecord(storePath, "00008110-ABCDEF1234567890"), false);
});

test("a corrupt store surfaces an explicit error instead of silently resetting", () => {
  const storePath = tempStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({ devices: ["not-an-object"] }));
  assert.throws(() => loadProvisioningRecords(storePath), /corrupt/);
});

test("structurally unreadable state requires explicit destructive confirmation and never returns a local path", () => {
  const storePath = tempStorePath();
  const original = "{not-json";
  fs.writeFileSync(storePath, original);
  const refused = repairProvisioningStore(storePath);
  assert.equal(refused.repaired, false);
  assert.equal(refused.manualRepairRequired, true);
  assert.equal(fs.readFileSync(storePath, "utf8"), original);
  const result = repairProvisioningStore(storePath, { destructiveReset: true });
  assert.equal(result.repaired, true);
  assert.equal("backupPath" in result, false);
  assert.deepEqual(loadProvisioningRecords(storePath), {});
  assert.equal(repairProvisioningStore(storePath).reason, "not_corrupt");
  assert.ok(fs.readdirSync(path.dirname(storePath)).some(name => name.includes(result.repairId) && name.endsWith(".bak")));
});

test("selective repair preserves valid records and quarantines only invalid records", () => {
  const storePath = tempStorePath();
  fs.writeFileSync(storePath, JSON.stringify({ devices: {
    "00008110-ABCDEF1234567890": { logicalId: "ios-valid", wdaLocalPort: 8101 },
    "00008110-ABCDEF1234567891": { logicalId: 42 },
  } }));
  const result = repairProvisioningStore(storePath);
  assert.equal(result.repaired, true);
  assert.equal(result.preservedCount, 1);
  assert.equal(result.quarantinedCount, 1);
  assert.equal("backupPath" in result, false);
  assert.equal(getProvisioningRecord(storePath, "00008110-ABCDEF1234567890").logicalId, "ios-valid");
  assert.equal(getProvisioningRecord(storePath, "00008110-ABCDEF1234567891"), null);
});

test("an invalid device record shape fails closed", () => {
  const storePath = tempStorePath();
  fs.writeFileSync(storePath, JSON.stringify({ devices: { "00008110-ABCDEF1234567890": { logicalId: 42 } } }));
  assert.throws(() => loadProvisioningRecords(storePath), error => error.code === "provisioning_state_corrupt");
});

test("an unreadable store path is typed and never replaced automatically", () => {
  const storePath = tempStorePath();
  fs.mkdirSync(storePath);
  assert.throws(() => loadProvisioningRecords(storePath), error => error.code === "provisioning_state_corrupt");
  assert.equal(fs.statSync(storePath).isDirectory(), true);
  assert.throws(() => repairProvisioningStore(storePath), error => error.code === "provisioning_state_corrupt");
  assert.equal(fs.statSync(storePath).isDirectory(), true);
});

test("the MJPEG video port is stored and survives a later partial update", () => {
  const storePath = tempStorePath();
  upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", {
    logicalId: "ios-abc123", wdaLocalPort: 8101, mjpegLocalPort: 9101, derivedDataPath: "/tmp/derived/ios-abc123",
  });
  const updated = upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", { displayName: "Renamed" });
  assert.equal(updated.mjpegLocalPort, 9101);
});

test("the operator WDA enablement choice persists through partial updates", () => {
  const storePath = tempStorePath();
  upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", {
    logicalId: "ios-abc123", wdaEnabled: false,
  });
  const updated = upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", { displayName: "Renamed" });
  assert.equal(updated.wdaEnabled, false);
});

test("new and legacy records without an explicit lifecycle choice migrate fail closed", () => {
  const storePath = tempStorePath();
  const created = upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", { logicalId: "ios-safe" });
  assert.equal(created.lifecycleIntent, "stopped");
  assert.equal(created.wdaEnabled, false);

  fs.writeFileSync(storePath, JSON.stringify({ devices: {
    "00008110-ABCDEF1234567890": { udid: "00008110-ABCDEF1234567890", logicalId: "ios-safe" },
  } }));
  const migrated = getProvisioningRecord(storePath, "00008110-ABCDEF1234567890");
  assert.equal(migrated.lifecycleIntent, "stopped");
  assert.equal(migrated.wdaEnabled, false);
});

test("explicit legacy lifecycle choices migrate without changing operator intent", () => {
  const storePath = tempStorePath();
  fs.writeFileSync(storePath, JSON.stringify({ devices: {
    "00008110-ABCDEF1234567890": { udid: "00008110-ABCDEF1234567890", logicalId: "ios-on", wdaEnabled: true },
    "00008110-ABCDEF1234567891": { udid: "00008110-ABCDEF1234567891", logicalId: "ios-off", wdaEnabled: false },
  } }));
  const records = loadProvisioningRecords(storePath);
  assert.equal(records["00008110-ABCDEF1234567890"].lifecycleIntent, "running");
  assert.equal(records["00008110-ABCDEF1234567891"].lifecycleIntent, "stopped");
});
