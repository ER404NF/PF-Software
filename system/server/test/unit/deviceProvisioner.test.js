import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { WdaDevice } from "../../src/wdaDevice.js";
import { discoveredDeviceId } from "../../src/deviceDiscovery.js";
import { DeviceProvisioner, buildControlDiagnosticReport, classifyIproxyFailure, classifyWdaFailure } from "../../src/deviceProvisioner.js";

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

test("classifyIproxyFailure exposes safe root-cause categories without returning raw process output", () => {
  assert.equal(classifyIproxyFailure("bind: Address already in use").code, "I205");
  assert.equal(classifyIproxyFailure("Usage: iproxy [OPTIONS] LOCAL_PORT:DEVICE_PORT").code, "I204");
  assert.equal(classifyIproxyFailure("No device found with udid SECRET-DEVICE-ID").code, "I206");
  assert.equal(classifyIproxyFailure("usbmuxd connection failed for /Users/private/path").code, "I207");
  assert.equal(classifyIproxyFailure("spawn /private/tool EACCES").code, "I208");
  assert.equal(classifyIproxyFailure("unknown failure"), null);
  for (const sample of [
    "No device found with udid SECRET-DEVICE-ID",
    "usbmuxd connection failed for /Users/private/path",
  ]) {
    const detail = classifyIproxyFailure(sample);
    assert.doesNotMatch(JSON.stringify(detail), /SECRET-DEVICE-ID|Users\/private/);
  }
});

test("control diagnostics identify a restarting iproxy as the immediate blocker with bounded parameters", () => {
  const report = buildControlDiagnosticReport({
    enabled: true,
    attachment: "CONNECTED",
    wdaStatus: { state: "running", restartCount: 0 },
    iproxyStatus: { state: "restarting", restartCount: 2 },
    readinessChecked: false,
    readinessPassed: false,
    readiness: { state: "RECOVERING", consecutiveFailures: 0, checkedAt: null },
    control: "UNAVAILABLE",
    localPort: 8102,
    timeoutMs: 8000,
    recovery: "IPROXY_RESTART",
  });
  assert.equal(report.outcome, "unavailable");
  assert.match(report.summary, /USB tunnel.*is still restarting/);
  assert.deepEqual(report.parameters, {
    localForwardingPort: 8102,
    readinessTimeoutMs: 8000,
    consecutiveReadinessFailures: 0,
    recoveryState: "IPROXY_RESTART",
  });
  assert.equal(report.checks.find(check => check.id === "iproxy_process").status, "wait");
  assert.equal(report.checks.find(check => check.id === "wda_endpoint").status, "blocked");
});

test("control diagnostics explain an endpoint timeout without leaking arbitrary process output", () => {
  const report = buildControlDiagnosticReport({
    enabled: true, attachment: "CONNECTED",
    wdaStatus: { state: "running", restartCount: 0 },
    iproxyStatus: { state: "running", restartCount: 0 },
    readinessChecked: true, readinessPassed: false,
    readiness: {
      state: "SUSPECT", consecutiveFailures: 1,
      lastError: { why: "The endpoint timed out.", operatorAction: "Keep the phone unlocked." },
    },
    control: "DEGRADED", localPort: 8100, timeoutMs: 8000, recovery: "IDLE",
  });
  const endpoint = report.checks.find(check => check.id === "wda_endpoint");
  assert.equal(endpoint.status, "fail");
  assert.equal(endpoint.meaning, "The endpoint timed out.");
  assert.equal(endpoint.action, "Keep the phone unlocked.");
  assert.doesNotMatch(JSON.stringify(report), /password|token|udid/i);
});

test("control diagnostics include read-only session, geometry, screenshot, and sanitized timeline checks", () => {
  const report = buildControlDiagnosticReport({
    enabled: true, attachment: "CONNECTED",
    wdaStatus: { state: "running", restartCount: 0 }, iproxyStatus: { state: "running", restartCount: 0 },
    readinessChecked: true, readinessPassed: true,
    readiness: { state: "HEALTHY", consecutiveFailures: 0 }, control: "READY",
    localPort: 8100, timeoutMs: 8000, recovery: "IDLE",
    sessionProbe: successfulProbeForTest("wda_session", "WDA automation session"),
    windowProbe: successfulProbeForTest("window_geometry", "Input geometry"),
    screenshotProbe: successfulProbeForTest("screenshot", "Screenshot capture"),
    recentEvents: [{ type: "WDA_READY", at: "2026-10-06T10:00:00.000Z", udid: "SECRET" }],
  });
  assert.equal(report.checks.filter(check => ["wda_session", "window_geometry", "screenshot"].includes(check.id)).length, 3);
  assert.deepEqual(report.timeline, [{ type: "WDA_READY", at: "2026-10-06T10:00:00.000Z" }]);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|udid/i);
});

function successfulProbeForTest(id, label) {
  return { id, label, observed: "ok; 4 ms", expected: "successful", status: "pass", meaning: "Ready.", action: "None." };
}

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
  ownsMapping(udid, { localPort, mjpegLocalPort }) {
    const last = [...this.starts].reverse().find(start => start.udid === udid);
    return this.running.has(udid) && last?.localPort === localPort && last?.mjpegLocalPort === mjpegLocalPort;
  }
  emitExit(udid, log = []) { this.emitter.emit("exit", { key: udid, code: 1, signal: null, log }); }
  emitRestartLimitExceeded(udid, log = []) { this.emitter.emit("restart-limit-exceeded", { key: udid, restartCount: 99, log }); }
  emitPersistentFailure(udid, log = []) { this.emitter.emit("persistent-failure", { key: udid, restartCount: 99, log }); }
  emitStable(udid) { this.emitter.emit("stable", { key: udid }); }
}

function tempStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-provisioner-")), "device-provisioning.json");
}

function makeProvisioner({ manualUdids = new Set(), recoveryCooldownMs, now, provisioningStorePath = tempStorePath(),
  isPortAvailable = async () => true } = {}) {
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
    provisioningStorePath,
    derivedDataRoot: "/tmp/derived-root",
    portRange: { start: 9000, end: 9010 },
    ...(recoveryCooldownMs === undefined ? {} : { recoveryCooldownMs }),
    ...(now ? { now } : {}),
    isPortAvailable,
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

test("automatic provisioning skips occupied control and MJPEG listeners before starting iproxy", async () => {
  const occupied = new Set([9000, 9100]);
  const { provisioner, iproxyManager, state } = makeProvisioner({
    isPortAvailable: async port => !occupied.has(port),
  });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  assert.equal(iproxyManager.starts[0].localPort, 9001);
  assert.equal(iproxyManager.starts[0].mjpegLocalPort, 9101);
});

test("I205 stops retrying and blocks rather than launching a duplicate pipeline on different ports", async () => {
  const occupied = new Set();
  const { provisioner, iproxyManager, state } = makeProvisioner({
    isPortAvailable: async port => !occupied.has(port),
  });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  occupied.add(9000);
  occupied.add(9100);
  iproxyManager.emitExit("UDID-00000001", ["bind: Address already in use"]);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(iproxyManager.starts.length, 1);
  assert.equal(iproxyManager.stops.filter(id => id === "UDID-00000001").length, 1);
  const device = provisioner.runtime.get("UDID-00000001").wdaDevice;
  assert.equal(device.componentHealth.recovery, "BLOCKED_PORT");
  assert.equal(device.componentErrors.iproxy.code, "I205");
});

test("persisted ports owned by an unproven process block attach without launching a duplicate", async () => {
  const store = tempStorePath();
  const first = makeProvisioner({ provisioningStorePath: store });
  first.state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await first.provisioner.pollOnce();

  const restarted = makeProvisioner({ provisioningStorePath: store, isPortAvailable: async () => false });
  restarted.state.attached = first.state.attached;
  await restarted.provisioner.pollOnce();
  const device = restarted.devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(restarted.wdaProcessManager.starts.length, 0);
  assert.equal(restarted.iproxyManager.starts.length, 0);
  assert.equal(device.componentHealth.recovery, "BLOCKED_PORT");
  assert.equal(device.componentErrors.iproxy.code, "I205");
  assert.doesNotMatch(JSON.stringify(device.componentErrors.iproxy), /UDID-00000001/);
});

test("retrying a persisted I205 device remains blocked while its foreign listener is present", async () => {
  const store = tempStorePath();
  const first = makeProvisioner({ provisioningStorePath: store });
  first.state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await first.provisioner.pollOnce();

  const restarted = makeProvisioner({ provisioningStorePath: store, isPortAvailable: async () => false });
  restarted.state.attached = first.state.attached;
  await restarted.provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const result = await restarted.provisioner.retryDevice(logicalId);
  const device = restarted.devices.get(logicalId);
  assert.equal(result, false);
  assert.equal(restarted.wdaProcessManager.starts.length, 0);
  assert.equal(restarted.iproxyManager.starts.length, 0);
  assert.equal(device.componentErrors.iproxy.code, "I205");
  assert.equal(device.componentHealth.recovery, "BLOCKED_PORT");
});

test("starting an intentionally stopped device refuses an occupied foreign port pair", async () => {
  const occupied = new Set();
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner({
    isPortAvailable: async port => !occupied.has(port),
  });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  await provisioner.stopDevice(logicalId);
  wdaProcessManager.starts.length = 0;
  iproxyManager.starts.length = 0;
  occupied.add(9000);
  occupied.add(9100);

  const lifecycle = await provisioner.startDevice(logicalId);
  const device = devices.get(logicalId);
  assert.equal(lifecycle.enabled, false);
  assert.equal(wdaProcessManager.starts.length, 0);
  assert.equal(iproxyManager.starts.length, 0);
  assert.equal(device.componentErrors.iproxy.code, "I205");
  assert.equal(device.componentHealth.recovery, "BLOCKED_PORT");
});

test("an occupied mapping already owned by this runtime is adopted without a second iproxy launch", async () => {
  const { provisioner, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const entry = provisioner.runtime.get("UDID-00000001");
  provisioner.runtime.delete("UDID-00000001");
  provisioner.isPortAvailable = async port => ![entry.port, entry.mjpegPort].includes(port);
  await provisioner.pollOnce();
  assert.equal(iproxyManager.starts.length, 1, "the runtime-owned mapping is adopted");
});

test("I205 recovery reports a stop failure distinctly and never launches a replacement", async () => {
  const { provisioner, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  iproxyManager.stop = async () => { throw Object.assign(new Error("permission denied while stopping"), { code: "EPERM" }); };
  iproxyManager.emitExit("UDID-00000001", ["bind: Address already in use"]);
  await new Promise(resolve => setImmediate(resolve));
  const device = provisioner.runtime.get("UDID-00000001").wdaDevice;
  assert.equal(device.componentErrors.iproxy.code, "I210");
  assert.equal(device.componentHealth.recovery, "STOP_FAILED");
  assert.equal(iproxyManager.starts.length, 1);
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

test("overlapping discovery polls share allocation and cannot launch duplicate tunnels", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { provisioner, iproxyManager, state } = makeProvisioner({ isPortAvailable: async () => { await gate; return true; } });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  const first = provisioner.pollOnce();
  const second = provisioner.pollOnce();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
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
  device.readiness = { ...device.readiness, ready: true, state: "HEALTHY" };
  device.setComponentHealth({ wdaProcess: "RUNNING", iproxy: "RUNNING", wdaEndpoint: "HEALTHY", control: "READY" });
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

test("a deterministic iproxy failure remains visible while capped automatic retry continues", async () => {
  const { iproxyManager, devices, state, provisioner } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();

  iproxyManager.emitExit("UDID-00000001", ["bind: Address already in use on a private host path\n"]);
  iproxyManager.emitPersistentFailure("UDID-00000001", ["bind: Address already in use on a private host path\n"]);

  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(device.discoveryState, "provisioning_error");
  assert.equal(device.componentHealth.iproxy, "RESTARTING");
  assert.equal(device.componentHealth.control, "UNAVAILABLE");
  assert.equal(device.componentHealth.recovery, "RETRYING_CAPPED");
  assert.equal(device.healthSnapshot().latestError.code, "I205");
  assert.doesNotMatch(JSON.stringify(device.healthSnapshot()), /private host path/);
  assert.match(device.discoveryStateMessage, /local port/i);
  assert.match(device.discoveryStateMessage, /automatic retry/i);
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

  const ok = await provisioner.retry("UDID-00000001");
  assert.equal(ok, true);
  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(device.discoveryState, "provisioning");
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(wdaProcessManager.starts[0].udid, "UDID-00000001");
  assert.equal(iproxyManager.starts.length, 1);
  assert.equal(iproxyManager.starts[0].localPort, 9000);
});

test("retry() on an unmanaged UDID returns false", async () => {
  const { provisioner } = makeProvisioner();
  assert.equal(await provisioner.retry("NEVER-SEEN"), false);
});

test("retryDevice() resolves a logical device id to its UDID — routes never need the raw UDID", async () => {
  const { provisioner, wdaProcessManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  wdaProcessManager.emitRestartLimitExceeded("UDID-00000001", ["boom\n"]);
  wdaProcessManager.starts.length = 0;

  const logicalId = discoveredDeviceId("UDID-00000001");
  const ok = await provisioner.retryDevice(logicalId);
  assert.equal(ok, true);
  assert.equal(devices.get(logicalId).discoveryState, "provisioning");
  assert.equal(wdaProcessManager.starts[0].udid, "UDID-00000001");
});

test("retryDevice() on an unknown logical id returns false", async () => {
  const { provisioner } = makeProvisioner();
  assert.equal(await provisioner.retryDevice("ios-does-not-exist"), false);
});

test("an iproxy stable event immediately verifies and restores end-to-end control", async () => {
  const { provisioner, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const device = devices.get(logicalId);
  let checks = 0;
  device.checkReadiness = async () => {
    checks += 1;
    device.readiness = { ...device.readiness, ready: true, state: "HEALTHY" };
    device.setComponentHealth({ wdaEndpoint: "HEALTHY", control: "READY" });
    device.status = "idle";
    return true;
  };

  device.discoveryState = "provisioning";
  device.discoveryStateMessage = "Recovering the device tunnel. The phone will be available after a fresh readiness check.";
  iproxyManager.emitStable("UDID-00000001");
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(checks, 1);
  assert.equal(device.componentHealth.control, "READY");
  assert.equal(device.discoveryState, null);
  assert.equal(device.discoveryStateMessage, null);
});

test("manual WDA stop is idempotent, stops both processes, and persists across provisioner restart", async () => {
  const store = tempStorePath();
  const first = makeProvisioner({ provisioningStorePath: store });
  first.state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await first.provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  assert.deepEqual(await first.provisioner.stopDevice(logicalId), {
    enabled: false, state: "stopped", wdaProcess: "stopped", iproxyProcess: "stopped",
    endpointReady: false, controlReady: false,
  });
  await first.provisioner.stopDevice(logicalId);
  assert.equal(first.wdaProcessManager.stops.filter(id => id === "UDID-00000001").length, 1);
  assert.equal(first.iproxyManager.stops.filter(id => id === "UDID-00000001").length, 1);

  const second = makeProvisioner({ provisioningStorePath: store });
  second.state.attached = first.state.attached;
  await second.provisioner.pollOnce();
  assert.equal(second.wdaProcessManager.starts.length, 0);
  assert.equal(second.iproxyManager.starts.length, 0);
  assert.equal(second.devices.get(logicalId).discoveryState, "wda_stopped");
});

test("manual WDA start restores the isolated WDA and iproxy pipeline", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  await provisioner.stopDevice(logicalId);
  wdaProcessManager.starts.length = 0;
  iproxyManager.starts.length = 0;

  const lifecycle = await provisioner.startDevice(logicalId);
  assert.equal(lifecycle.enabled, true);
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(iproxyManager.starts.length, 1);
  assert.equal(devices.get(logicalId).discoveryState, "provisioning");
});

test("manual WDA lifecycle denial is checked inside the mutation boundary and leaves processes running", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const expected = new Error("authorization revoked");

  await assert.rejects(
    provisioner.stopDevice(logicalId, { authorize: async () => { throw expected; } }),
    error => error === expected,
  );

  assert.equal(wdaProcessManager.stops.length, 0);
  assert.equal(iproxyManager.stops.length, 0);
  assert.equal(provisioner.getLifecycleState(logicalId).enabled, true);
});

test("full control diagnostics coalesce overlapping readiness probes", async () => {
  const { provisioner, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const device = devices.get(logicalId);
  let release;
  let checks = 0;
  device.checkReadiness = () => {
    checks += 1;
    return new Promise(resolve => { release = () => {
      device.readiness = { ...device.readiness, ready: true, state: "HEALTHY", consecutiveFailures: 0 };
      device.setComponentHealth({ wdaEndpoint: "HEALTHY", control: "READY" });
      resolve(true);
    }; });
  };
  device.ensureSession = async () => "session";
  device.ensureWindowSize = async () => ({ width: 390, height: 844 });
  device.render = async () => ({ kind: "image", mime: "image/png", data: "cG5n" });
  const first = provisioner.diagnoseDevice(logicalId);
  const second = provisioner.diagnoseDevice(logicalId);
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(checks, 1);
  assert.equal(results.every(result => result.readinessPassed), true);
  assert.equal(results.every(result => result.report.outcome === "ready"), true);
  assert.equal(results.every(result => result.report.checks.find(check => check.id === "window_geometry")?.observed.includes("390 x 844")), true);
});

test("stop() tears down every managed process", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  await provisioner.stop();
  assert.ok(wdaProcessManager.stops.includes("UDID-00000001"));
  assert.ok(iproxyManager.stops.includes("UDID-00000001"));
});

test("stop fences an in-flight attach before it can start WDA or iproxy", async () => {
  let release;
  const allocationGate = new Promise(resolve => { release = resolve; });
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner({
    isPortAvailable: async () => { await allocationGate; return true; },
  });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  const poll = provisioner.pollOnce();
  await new Promise(resolve => setImmediate(resolve));
  const stopping = provisioner.stop();
  release();
  await Promise.all([poll, stopping]);
  assert.equal(wdaProcessManager.starts.length, 0);
  assert.equal(iproxyManager.starts.length, 0);
  await provisioner.stop();
  assert.equal(wdaProcessManager.starts.length, 0, "idempotent stop must not reopen provisioning");
});

test("restart waits for both stops, starts one pair, and reports readiness truthfully", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const device = devices.get(logicalId);
  device.checkReadiness = async () => {
    device.readiness = { ...device.readiness, ready: true, state: "HEALTHY" };
    device.setComponentHealth({ wdaEndpoint: "HEALTHY", control: "READY" });
    return true;
  };
  wdaProcessManager.starts.length = 0;
  iproxyManager.starts.length = 0;
  let authorizations = 0;
  const lifecycle = await provisioner.restartDevice(logicalId, { authorize: async () => { authorizations += 1; } });
  assert.equal(authorizations, 2);
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(iproxyManager.starts.length, 1);
  assert.equal(lifecycle.state, "ready");
  assert.equal(lifecycle.controlReady, true);
});

test("restart failure stops partial replacements and reports a failed, disabled lifecycle", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  iproxyManager.start = () => { throw new Error("spawn failed"); };
  await assert.rejects(provisioner.restartDevice(logicalId), /spawn failed/);
  const lifecycle = provisioner.getLifecycleState(logicalId);
  assert.equal(lifecycle.enabled, false);
  assert.equal(lifecycle.controlReady, false);
  assert.equal(devices.get(logicalId).componentHealth.recovery, "FAILED");
  assert.ok(wdaProcessManager.stops.length >= 2, "the partially restarted WDA is stopped again");
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
