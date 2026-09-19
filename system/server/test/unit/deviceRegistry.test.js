import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDevices } from "../../src/deviceRegistry.js";
import { MockDevice } from "../../src/mockDevice.js";
import { WdaDevice } from "../../src/wdaDevice.js";

const wda = (id, overrides = {}) => ({
  id,
  label: `Phone ${id}`,
  type: "wda",
  port: 8100,
  udid: `00008110-00000000000000${id.slice(-1)}`,
  ...overrides,
});

test("device registry creates only explicitly supported adapters", () => {
  const devices = loadDevices({ devices: [
    { id: "mock-1", label: "Mock phone", type: "mock" },
    wda("wda-1"),
  ] });
  assert.ok(devices.get("mock-1") instanceof MockDevice);
  assert.ok(devices.get("wda-1") instanceof WdaDevice);
  assert.throws(() => loadDevices({ devices: [{ id: "typo-1", label: "Typo", type: "wdaa" }] }),
    /Unsupported device type/);
});

test("device registry rejects duplicate logical and physical WDA identities", () => {
  assert.throws(() => loadDevices({ devices: [
    { id: "same", label: "One", type: "mock" },
    { id: "same", label: "Two", type: "mock" },
  ] }), /Duplicate device id/);
  assert.throws(() => loadDevices({ devices: [wda("wda-1"), wda("wda-2", {
    port: 8101, udid: "00008110-000000000000001",
  })] }),
    /Duplicate WDA UDID/);
  assert.throws(() => loadDevices({ devices: [wda("wda-1"), wda("wda-2", {
    host: "localhost", udid: "00008110-000000000000002",
  })] }), /Duplicate WDA endpoint/);
});

test("device registry validates WDA deployment fields before adapter creation", () => {
  assert.throws(() => loadDevices({ devices: [wda("wda-1", { port: undefined })] }), /port must be an integer/);
  assert.throws(() => loadDevices({ devices: [wda("wda-1", { host: "192.0.2.10" })] }), /host must be loopback/);
  assert.throws(() => loadDevices({ devices: [wda("wda-1", { timeoutMs: 100 })] }), /timeoutMs/);
  assert.throws(() => loadDevices({ devices: [wda("wda-1", { udid: undefined })] }), /requires a valid UDID/);
  assert.throws(() => loadDevices({ devices: [wda("wda-1", { label: "" })] }), /requires a non-empty label/);
});

test("a pinned WDA phone can declare its video port, which enables live streaming", () => {
  const devices = loadDevices({ devices: [wda("wda-1", { mjpegPort: 9100 }), wda("wda-2", { port: 8101 })] });
  assert.equal(devices.get("wda-1").mjpegPort, 9100);
  assert.equal(devices.get("wda-1").supportsStream, true);
  assert.equal(devices.get("wda-2").supportsStream, false, "no video port: screenshots only");
});

test("a video port must be valid and distinct from every other endpoint", () => {
  for (const mjpegPort of [0, 70000, 8100, "9100", 1.5]) {
    assert.throws(() => loadDevices({ devices: [wda("wda-1", { mjpegPort })] }), /mjpegPort/, String(mjpegPort));
  }
  assert.throws(() => loadDevices({ devices: [
    wda("wda-1", { mjpegPort: 9100 }),
    wda("wda-2", { port: 8101, mjpegPort: 9100 }),
  ] }), /Duplicate WDA endpoint/);
  assert.throws(() => loadDevices({ devices: [
    wda("wda-1", { mjpegPort: 8101 }),
    wda("wda-2", { port: 8101 }),
  ] }), /Duplicate WDA endpoint/);
});
