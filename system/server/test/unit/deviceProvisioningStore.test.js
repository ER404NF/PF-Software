import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  loadProvisioningRecords, getProvisioningRecord, upsertProvisioningRecord, removeProvisioningRecord,
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

test("the MJPEG video port is stored and survives a later partial update", () => {
  const storePath = tempStorePath();
  upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", {
    logicalId: "ios-abc123", wdaLocalPort: 8101, mjpegLocalPort: 9101, derivedDataPath: "/tmp/derived/ios-abc123",
  });
  const updated = upsertProvisioningRecord(storePath, "00008110-ABCDEF1234567890", { displayName: "Renamed" });
  assert.equal(updated.mjpegLocalPort, 9101);
});
