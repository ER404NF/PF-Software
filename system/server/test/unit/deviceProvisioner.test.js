import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { WdaDevice } from "../../src/wdaDevice.js";
import { discoveredDeviceId } from "../../src/deviceDiscovery.js";
import { DeviceProvisioner, classifyWdaFailure } from "../../src/deviceProvisioner.js";

test("classifyWdaFailure recognizes known manual-prerequisite failures", () => {
  assert.match(classifyWdaFailure("please Trust This Computer on the device"), /Trust this computer/);
  assert.match(classifyWdaFailure("Developer Mode is disabled"), /Enable Developer Mode/);
  assert.match(classifyWdaFailure("Untrusted Developer"), /Trust the developer certificate/);
  assert.match(classifyWdaFailure("Your maximum App ID limit has been reached"), /App ID creation limit/);
});

test("classifyWdaFailure returns null for an unrecognized error", () => {
  assert.equal(classifyWdaFailure("connection reset by peer"), null);
});

// Stands in for WdaProcessManager/IProxyManager — same on/start/stop/stopAll
// shape, fully test-controlled (no real OS process ever spawned).
class FakeProcessManager {
  constructor() {
    this.emitter = new EventEmitter();
    this.starts = [];
    this.stops = [];
    this.running = new Set();
  }
  on(...args) { this.emitter.on(...args); return this; }
  start(opts) { this.starts.push(opts); this.running.add(opts.udid); }
  stop(udid) { this.stops.push(udid); this.running.delete(udid); }
  stopAll() { for (const udid of [...this.running]) this.stop(udid); }
  emitExit(udid, log = []) { this.emitter.emit("exit", { key: udid, code: 1, signal: null, log }); }
  emitRestartLimitExceeded(udid, log = []) { this.emitter.emit("restart-limit-exceeded", { key: udid, restartCount: 99, log }); }
}

function tempStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-provisioner-")), "device-provisioning.json");
}

function makeProvisioner({ manualUdids = new Set() } = {}) {
  const state = { attached: [] };
  const devices = new Map();
  const wdaProcessManager = new FakeProcessManager();
  const iproxyManager = new FakeProcessManager();
  const changes = [];
  const provisioner = new DeviceProvisioner({
    devices,
    discoverIosDevices: () => state.attached,
    manualUdids,
    wdaProcessManager,
    iproxyManager,
    provisioningStorePath: tempStorePath(),
    derivedDataRoot: "/tmp/derived-root",
    portRange: { start: 9000, end: 9010 },
    onDeviceListChanged: () => changes.push(true),
  });
  return { provisioner, wdaProcessManager, iproxyManager, devices, changes, state };
}

test("a newly discovered, unconfigured UDID is provisioned automatically", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, changes, state } = makeProvisioner();
  state.attached = [{ id: "ignored", udid: "00008110-ABCDEF1234567890", label: "Studio iPhone" }];
  await provisioner.pollOnce();

  const logicalId = discoveredDeviceId("00008110-ABCDEF1234567890");
  const device = devices.get(logicalId);
  assert.ok(device instanceof WdaDevice);
  assert.equal(device.label, "Studio iPhone");
  assert.equal(device.discoveryState, "provisioning");
  assert.equal(device.status, "offline");
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(wdaProcessManager.starts[0].udid, "00008110-ABCDEF1234567890");
  assert.equal(wdaProcessManager.starts[0].derivedDataPath, path.join("/tmp/derived-root", logicalId));
  assert.equal(iproxyManager.starts.length, 1);
  assert.equal(iproxyManager.starts[0].localPort, 9000);
  assert.ok(changes.length > 0);
});

test("polling again for the same attached UDID does not start a second process", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  await provisioner.pollOnce();
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(iproxyManager.starts.length, 1);
});

test("clears the provisioning banner once the existing WDA readiness loop marks the device ready", async () => {
  const { provisioner, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(device.discoveryState, "provisioning");

  // index.js's existing 10s refreshWdaReadiness() loop is what actually
  // flips status via checkReadiness() — this provisioner never polls
  // /status itself, it only observes the resulting status change.
  device.status = "idle";
  await provisioner.pollOnce();
  assert.equal(device.discoveryState, null);
  assert.equal(device.discoveryStateMessage, null);
});

test("a manually configured devices.config.json UDID is never auto-provisioned", async () => {
  const { provisioner, wdaProcessManager, devices, state } = makeProvisioner({ manualUdids: new Set(["MANUAL-UDID"]) });
  state.attached = [{ id: "x", udid: "MANUAL-UDID", label: "Bench Phone" }];
  await provisioner.pollOnce();
  assert.equal(wdaProcessManager.starts.length, 0);
  assert.equal(devices.size, 0);
});

test("detach stops both processes and marks the device disconnected without deleting it", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  devices.get(logicalId).status = "idle"; // simulate having come online

  state.attached = [];
  await provisioner.pollOnce();
  assert.ok(wdaProcessManager.stops.includes("UDID-00000001"));
  assert.ok(iproxyManager.stops.includes("UDID-00000001"));
  const device = devices.get(logicalId);
  assert.equal(device.status, "offline");
  assert.equal(device.discoveryState, "disconnected");
  assert.equal(devices.has(logicalId), true); // kept, matching the architecture guide's "keep the stable registry entry"
});

test("detach never overrides an in-use device's status", async () => {
  const { provisioner, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  device.status = "in-use";

  state.attached = [];
  await provisioner.pollOnce();
  assert.equal(device.status, "in-use");
  assert.notEqual(device.discoveryState, "disconnected");
});

test("a replug after detach reuses the same WdaDevice instance and the same persisted port", async () => {
  const { provisioner, wdaProcessManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const firstInstance = devices.get(logicalId);

  state.attached = [];
  await provisioner.pollOnce(); // detach

  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce(); // replug

  assert.equal(devices.get(logicalId), firstInstance); // same object, not recreated
  assert.equal(devices.get(logicalId).discoveryState, "provisioning");
  assert.equal(wdaProcessManager.starts.length, 2); // one per attach
  assert.equal(wdaProcessManager.starts[1].udid, "UDID-00000001");
});

test("a recognized WDA failure surfaces as user_action_required and stops retrying", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();

  wdaProcessManager.emitExit("UDID-00000001", ["Xcode\n", "Untrusted Developer. Please verify the app in Settings.\n"]);

  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(device.discoveryState, "user_action_required");
  assert.match(device.discoveryStateMessage, /Trust the developer certificate/);
  assert.equal(device.status, "offline");
  assert.ok(wdaProcessManager.stops.includes("UDID-00000001"));
  assert.ok(iproxyManager.stops.includes("UDID-00000001"));
});

test("an iproxy exit is never classified with WDA-specific failure patterns, even if its log text happens to match", async () => {
  // classifyWdaFailure's patterns (untrusted cert, Developer Mode, App ID
  // limit) are about Xcode/WDA installation, not iproxy (a USB
  // port-forwarder) — misapplying them here would send an operator to fix
  // the wrong thing.
  const { provisioner, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();

  iproxyManager.emitExit("UDID-00000001", ["Untrusted Developer. Please verify the app in Settings.\n"]);

  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(device.discoveryState, "provisioning"); // unchanged — not misclassified as user_action_required
});

test("an unrecognized process exit is left to the restart/backoff path, not surfaced as a banner", async () => {
  const { provisioner, wdaProcessManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const device = devices.get(discoveredDeviceId("UDID-00000001"));

  wdaProcessManager.emitExit("UDID-00000001", ["some transient network blip\n"]);
  assert.equal(device.discoveryState, "provisioning"); // unchanged — SupervisedProcessGroup handles the restart itself
});

test("exhausting the restart budget surfaces provisioning_error with the last log line", async () => {
  const { provisioner, wdaProcessManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();

  wdaProcessManager.emitRestartLimitExceeded("UDID-00000001", ["boom happened\n"]);

  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(device.discoveryState, "provisioning_error");
  assert.match(device.discoveryStateMessage, /WDA failed to start after repeated attempts/);
  assert.match(device.discoveryStateMessage, /boom happened/);
});

test("retry() restarts both processes with the persisted port/derivedDataPath and resets the banner", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  wdaProcessManager.emitRestartLimitExceeded("UDID-00000001", ["boom\n"]);
  wdaProcessManager.starts.length = 0;
  iproxyManager.starts.length = 0;

  const ok = provisioner.retry("UDID-00000001");
  assert.equal(ok, true);
  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(device.discoveryState, "provisioning");
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(wdaProcessManager.starts[0].udid, "UDID-00000001");
  assert.equal(iproxyManager.starts.length, 1);
  assert.equal(iproxyManager.starts[0].localPort, 9000);
});

test("retry() on an unmanaged UDID returns false", () => {
  const { provisioner } = makeProvisioner();
  assert.equal(provisioner.retry("NEVER-SEEN"), false);
});

test("retryDevice() resolves a logical device id to its UDID — routes never need the raw UDID", async () => {
  const { provisioner, wdaProcessManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  wdaProcessManager.emitRestartLimitExceeded("UDID-00000001", ["boom\n"]);
  wdaProcessManager.starts.length = 0;

  const logicalId = discoveredDeviceId("UDID-00000001");
  const ok = provisioner.retryDevice(logicalId);
  assert.equal(ok, true);
  assert.equal(devices.get(logicalId).discoveryState, "provisioning");
  assert.equal(wdaProcessManager.starts[0].udid, "UDID-00000001");
});

test("retryDevice() on an unknown logical id returns false", () => {
  const { provisioner } = makeProvisioner();
  assert.equal(provisioner.retryDevice("ios-does-not-exist"), false);
});

test("stop() tears down every managed process", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  provisioner.stop();
  assert.ok(wdaProcessManager.stops.includes("UDID-00000001"));
  assert.ok(iproxyManager.stops.includes("UDID-00000001"));
});
