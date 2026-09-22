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
  assert.match(classifyWdaFailure("Signing for WebDriverAgentRunner requires a development team"), /configured once in Xcode/);
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
  start(opts) { this.starts.push(opts); this.running.add(opts.udid); this.emitter.emit("starting", { key: opts.udid }); }
  stop(udid) { this.stops.push(udid); this.running.delete(udid); }
  stopAll() { for (const udid of [...this.running]) this.stop(udid); }
  getStatus(udid) { return { state: this.running.has(udid) ? "running" : "stopped", restartCount: 0 }; }
  emitExit(udid, log = []) { this.emitter.emit("exit", { key: udid, code: 1, signal: null, log }); }
  emitRestartLimitExceeded(udid, log = []) { this.emitter.emit("restart-limit-exceeded", { key: udid, restartCount: 99, log }); }
}

function tempStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-provisioner-")), "device-provisioning.json");
}

function makeProvisioner({ manualUdids = new Set(), recoveryCooldownMs, now } = {}) {
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
    ...(recoveryCooldownMs === undefined ? {} : { recoveryCooldownMs }),
    ...(now ? { now } : {}),
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

test("a discovery command failure retains attached runtimes instead of treating every phone as unplugged", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");

  state.attached = { ok: false, devices: [], error: { code: "D102", reason: "EPIPE" } };
  await provisioner.pollOnce();

  assert.equal(provisioner.runtime.has("UDID-00000001"), true);
  assert.equal(wdaProcessManager.stops.length, 0);
  assert.equal(iproxyManager.stops.length, 0);
  assert.equal(devices.get(logicalId).componentHealth.deviceAttachment, "UNKNOWN");
  assert.equal(devices.get(logicalId).readiness.lastError.code, "D102");
});

test("polling again for the same attached UDID does not start a second process", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  await provisioner.pollOnce();
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(iproxyManager.starts.length, 1);
});

test("two attached iPhones get isolated WDA builds and scoped tunnels, and one detach leaves the other running", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [
    { id: "a", udid: "UDID-00000001", label: "Phone A" },
    { id: "b", udid: "UDID-00000002", label: "Phone B" },
  ];
  await provisioner.pollOnce();

  assert.equal(devices.size, 2);
  assert.deepEqual(wdaProcessManager.starts.map(start => start.udid), ["UDID-00000001", "UDID-00000002"]);
  assert.equal(new Set(wdaProcessManager.starts.map(start => start.derivedDataPath)).size, 2);
  assert.deepEqual(iproxyManager.starts.map(start => [start.udid, start.localPort]), [
    ["UDID-00000001", 9000],
    ["UDID-00000002", 9001],
  ]);

  state.attached = [{ id: "b", udid: "UDID-00000002", label: "Phone B" }];
  await provisioner.pollOnce();
  assert.ok(wdaProcessManager.stops.includes("UDID-00000001"));
  assert.ok(iproxyManager.stops.includes("UDID-00000001"));
  assert.equal(wdaProcessManager.running.has("UDID-00000002"), true);
  assert.equal(iproxyManager.running.has("UDID-00000002"), true);
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

test("detach preserves an in-flight ownership lock but reports the physical disconnect", async () => {
  const { provisioner, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  device.status = "in-use";

  state.attached = [];
  await provisioner.pollOnce();
  assert.equal(device.status, "in-use");
  assert.equal(device.discoveryState, "disconnected");
  assert.equal(device.componentHealth.deviceAttachment, "DISCONNECTED");
  assert.equal(device.componentHealth.control, "UNAVAILABLE");
  assert.equal(device.readiness.lastError.code, "D101");
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
  assert.equal(device.readiness.lastError.code, "W205");
  assert.equal(device.componentHealth.recovery, "USER_ACTION_REQUIRED");
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

test("an unresponsive endpoint restarts iproxy first, then WDA, before exhausting recovery", async () => {
  let clock = 1000;
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner({
    recoveryCooldownMs: 10,
    now: () => clock,
  });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  const initialWdaStarts = wdaProcessManager.starts.length;
  const initialIproxyStarts = iproxyManager.starts.length;

  device.readiness.state = "FAILED";
  clock += 20;
  await provisioner.pollOnce();
  assert.equal(iproxyManager.starts.length, initialIproxyStarts + 1);
  assert.equal(wdaProcessManager.starts.length, initialWdaStarts);
  assert.equal(device.componentHealth.recovery, "IPROXY");
  assert.equal(device.readiness.lastError.code, "I202");

  device.readiness.state = "FAILED";
  clock += 20;
  await provisioner.pollOnce();
  assert.equal(wdaProcessManager.starts.length, initialWdaStarts + 1);
  assert.equal(iproxyManager.starts.length, initialIproxyStarts + 1);
  assert.equal(device.componentHealth.recovery, "WDA");

  device.readiness.state = "FAILED";
  clock += 20;
  await provisioner.pollOnce();
  assert.equal(device.componentHealth.recovery, "EXHAUSTED");
  assert.equal(device.readiness.lastError.code, "R201");
  assert.equal(device.discoveryState, "provisioning_error");
});

test("endpoint recovery for Phone A never restarts Phone B processes", async () => {
  let clock = 1000;
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner({
    recoveryCooldownMs: 10,
    now: () => clock,
  });
  state.attached = [
    { id: "a", udid: "UDID-00000001", label: "Phone A" },
    { id: "b", udid: "UDID-00000002", label: "Phone B" },
  ];
  await provisioner.pollOnce();
  devices.get(discoveredDeviceId("UDID-00000001")).readiness.state = "FAILED";
  devices.get(discoveredDeviceId("UDID-00000002")).readiness.state = "HEALTHY";
  wdaProcessManager.stops.length = 0;
  iproxyManager.stops.length = 0;
  clock += 20;

  await provisioner.pollOnce();

  assert.deepEqual(iproxyManager.stops, ["UDID-00000001"]);
  assert.deepEqual(wdaProcessManager.stops, []);
  assert.equal(iproxyManager.starts.filter(start => start.udid === "UDID-00000002").length, 1);
  assert.equal(wdaProcessManager.starts.filter(start => start.udid === "UDID-00000002").length, 1);
});

test("exhausting the restart budget surfaces a retryable error without exposing raw process output", async () => {
  const { provisioner, wdaProcessManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();

  wdaProcessManager.emitRestartLimitExceeded("UDID-00000001", ["failed /Users/operator/WDA for UDID-00000001\n"]);

  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(device.discoveryState, "provisioning_error");
  assert.match(device.discoveryStateMessage, /WDA failed to start after repeated attempts/);
  assert.doesNotMatch(device.discoveryStateMessage, /UDID-00000001/);
  assert.doesNotMatch(device.discoveryStateMessage, /\/Users\/operator/);
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

test("each phone gets its own video port, forwarded next to the control port and given to WdaDevice", async () => {
  const { provisioner, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [
    { id: "a", udid: "00008110-AAAAAAAAAAAAAAAA", label: "One" },
    { id: "b", udid: "00008110-BBBBBBBBBBBBBBBB", label: "Two" },
  ];
  await provisioner.pollOnce();

  assert.equal(iproxyManager.starts.length, 2);
  const video = iproxyManager.starts.map(start => start.mjpegLocalPort);
  assert.equal(new Set(video).size, 2, "video ports are distinct");
  assert.ok(video.every(port => port >= 9100 && port <= 9199));
  for (const start of iproxyManager.starts) assert.notEqual(start.mjpegLocalPort, start.localPort);

  const first = devices.get(discoveredDeviceId("00008110-AAAAAAAAAAAAAAAA"));
  assert.equal(first.supportsStream, true);
  assert.equal(first.mjpegPort, iproxyManager.starts[0].mjpegLocalPort);
});
