import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { getUsbNetworkRecord, setUsbIface, setUsbIp, loadUsbNetworkRecords } from "../../src/usbNetworkStore.js";

function tempStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-usbnetwork-")), "usb-network.json");
}

test("getUsbNetworkRecord returns null when the store or the device entry does not exist yet", () => {
  const storePath = tempStorePath();
  assert.equal(getUsbNetworkRecord(storePath, "mock-1"), null);
});

test("setUsbIface creates a record with a null usbIp", () => {
  const storePath = tempStorePath();
  const record = setUsbIface(storePath, "mock-1", "en5");
  assert.equal(record.usbIface, "en5");
  assert.equal(record.usbIp, null);
  assert.equal(getUsbNetworkRecord(storePath, "mock-1").usbIface, "en5");
});

test("setUsbIp requires enrollment (setUsbIface) to have run first", () => {
  const storePath = tempStorePath();
  assert.throws(() => setUsbIp(storePath, "mock-1", "192.168.2.10"), /enrollment must complete/);
});

test("setUsbIp records the discovered IP without disturbing the enrolled interface", () => {
  const storePath = tempStorePath();
  setUsbIface(storePath, "mock-1", "en5");
  const record = setUsbIp(storePath, "mock-1", "192.168.2.10");
  assert.equal(record.usbIface, "en5");
  assert.equal(record.usbIp, "192.168.2.10");
});

test("re-enrolling (setUsbIface again) resets usbIp to null — a new interface invalidates the old IP", () => {
  const storePath = tempStorePath();
  setUsbIface(storePath, "mock-1", "en5");
  setUsbIp(storePath, "mock-1", "192.168.2.10");
  const record = setUsbIface(storePath, "mock-1", "en6");
  assert.equal(record.usbIface, "en6");
  assert.equal(record.usbIp, null);
});

test("createdAt is preserved across updates; updatedAt advances", async () => {
  const storePath = tempStorePath();
  const first = setUsbIface(storePath, "mock-1", "en5");
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = setUsbIp(storePath, "mock-1", "192.168.2.10");
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, first.updatedAt);
});

test("loadUsbNetworkRecords returns every persisted device record, keyed by device id", () => {
  const storePath = tempStorePath();
  assert.deepEqual(loadUsbNetworkRecords(storePath), {});
  setUsbIface(storePath, "mock-1", "en5");
  setUsbIface(storePath, "mock-2", "en6");
  const all = loadUsbNetworkRecords(storePath);
  assert.deepEqual(Object.keys(all).sort(), ["mock-1", "mock-2"]);
  assert.equal(all["mock-1"].usbIface, "en5");
});

test("a corrupt store surfaces an explicit error instead of silently resetting", () => {
  const storePath = tempStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({ devices: ["not-an-object"] }));
  assert.throws(() => getUsbNetworkRecord(storePath, "mock-1"), /corrupt/);
});
