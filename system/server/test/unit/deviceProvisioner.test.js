import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { WdaDevice } from "../../src/wdaDevice.js";
import { discoveredDeviceId } from "../../src/deviceDiscovery.js";
import { DeviceProvisioner, buildControlDiagnosticReport, classifyIproxyFailure, classifyWdaFailure } from "../../src/deviceProvisioner.js";
import { LifecycleError } from "../../src/provisioningResults.js";
import { createPortReclaimer } from "../../src/portReclaimer.js";
import { assertPlainOperatorText } from "../helpers/plainText.js";

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
  start(opts) { this.starts.push(opts); this.running.add(opts.udid); this.emitter.emit("starting", { key: opts.udid }); return "started"; }
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
  isPortAvailable = async () => true, extra = {} } = {}) {
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
    ...extra,
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

test("automatic attach stops before iproxy when the WDA supervisor is blocked", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  wdaProcessManager.start = opts => { wdaProcessManager.starts.push(opts); return "blocked"; };
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];

  await provisioner.pollOnce();

  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(iproxyManager.starts.length, 0);
  assert.deepEqual(wdaProcessManager.stops, ["UDID-00000001"]);
  assert.equal(device.discoveryState, "provisioning_error");
  assert.equal(device.componentHealth.control, "UNAVAILABLE");
  assert.equal(device.componentHealth.recovery, "STOP_FAILED");
});

test("automatic attach cancels a queued WDA replacement and never starts iproxy", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  wdaProcessManager.start = opts => { wdaProcessManager.starts.push(opts); return "queued"; };
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];

  await provisioner.pollOnce();

  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(iproxyManager.starts.length, 0);
  assert.deepEqual(wdaProcessManager.stops, ["UDID-00000001"]);
  assert.equal(device.discoveryState, "provisioning_error");
  assert.equal(device.componentHealth.control, "UNAVAILABLE");
});

test("automatic attach cleans up WDA and iproxy when the tunnel supervisor is blocked", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, devices, state } = makeProvisioner();
  iproxyManager.start = opts => { iproxyManager.starts.push(opts); return "blocked"; };
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];

  await provisioner.pollOnce();

  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(iproxyManager.starts.length, 1);
  assert.deepEqual(wdaProcessManager.stops, ["UDID-00000001"]);
  assert.deepEqual(iproxyManager.stops, ["UDID-00000001"]);
  assert.equal(device.discoveryState, "provisioning_error");
  assert.equal(device.componentHealth.control, "UNAVAILABLE");
  assert.equal(device.componentHealth.wdaProcess, "STOPPED");
  assert.equal(device.componentHealth.iproxy, "FAILED");
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
  await assert.rejects(() => restarted.provisioner.retryDevice(logicalId), error => {
    assert.ok(error instanceof LifecycleError);
    assert.equal(error.code, "port_held_by_unidentified_program");
    return true;
  });
  const device = restarted.devices.get(logicalId);
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

  await assert.rejects(() => provisioner.startDevice(logicalId), error => {
    assert.ok(error instanceof LifecycleError);
    assert.equal(error.code, "port_held_by_unidentified_program");
    assert.equal(error.status, 409);
    return true;
  });
  const device = devices.get(logicalId);
  assert.equal(provisioner.getLifecycleState(logicalId).enabled, false);
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
  assert.deepEqual(ok, { ok: true, code: "started", message: "Phone control is starting." });
  const device = devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(device.discoveryState, "provisioning");
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(wdaProcessManager.starts[0].udid, "UDID-00000001");
  assert.equal(iproxyManager.starts.length, 1);
  assert.equal(iproxyManager.starts[0].localPort, 9000);
});

test("retry() on a phone that is not attached says so instead of returning false", async () => {
  const { provisioner } = makeProvisioner();
  await assert.rejects(() => provisioner.retry("NEVER-SEEN"), error => error instanceof LifecycleError && error.code === "device_not_attached");
});

test("retryDevice() resolves a logical device id to its UDID — routes never need the raw UDID", async () => {
  const { provisioner, wdaProcessManager, devices, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  wdaProcessManager.emitRestartLimitExceeded("UDID-00000001", ["boom\n"]);
  wdaProcessManager.starts.length = 0;

  const logicalId = discoveredDeviceId("UDID-00000001");
  const ok = await provisioner.retryDevice(logicalId);
  assert.equal(ok.ok, true);
  assert.equal(devices.get(logicalId).discoveryState, "provisioning");
  assert.equal(wdaProcessManager.starts[0].udid, "UDID-00000001");
});

test("retryDevice() on an unknown logical id is device_unknown (404)", async () => {
  const { provisioner } = makeProvisioner();
  await assert.rejects(() => provisioner.retryDevice("ios-does-not-exist"), error => error instanceof LifecycleError && error.code === "device_unknown" && error.status === 404);
});

test("retryDevice() while shutting down is shutting_down (503)", async () => {
  const { provisioner } = makeProvisioner();
  provisioner.stopping = true;
  await assert.rejects(() => provisioner.retryDevice("ios-any"), error => error.code === "shutting_down" && error.status === 503);
});

test("retry() when a managed process would not stop says Bodun could not stop its old process", async () => {
  const { provisioner, wdaProcessManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  wdaProcessManager.getStatus = () => ({ state: "stop_failed", restartCount: 0 });
  await assert.rejects(() => provisioner.retry("UDID-00000001"), error => error.code === "old_process_would_not_stop" && error.status === 409);
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

// The lifecycle also carries the allowed actions and their reasons (tested separately); these tests
// look at the process facts.
const pickState = ({ enabled, state, wdaProcess, iproxyProcess, endpointReady, controlReady }) => (
  { enabled, state, wdaProcess, iproxyProcess, endpointReady, controlReady });

test("manual WDA stop is idempotent, stops both processes, and persists across provisioner restart", async () => {
  const store = tempStorePath();
  const first = makeProvisioner({ provisioningStorePath: store });
  first.state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await first.provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  assert.deepEqual(pickState(await first.provisioner.stopDevice(logicalId)), {
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

test("Restart refuses a control service that was intentionally stopped and does not launch anything", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  await provisioner.stopDevice(logicalId);
  wdaProcessManager.starts.length = 0;
  iproxyManager.starts.length = 0;

  await assert.rejects(provisioner.restartDevice(logicalId), error => {
    assert.ok(error instanceof LifecycleError);
    assert.equal(error.code, "wda_not_running");
    assert.match(error.message, /Use Start WDA/);
    return true;
  });
  assert.equal(wdaProcessManager.starts.length, 0);
  assert.equal(iproxyManager.starts.length, 0);
});

test("Restart rechecks authorization before revealing that control is intentionally stopped", async () => {
  const { provisioner, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  await provisioner.stopDevice(logicalId);

  await assert.rejects(
    provisioner.restartDevice(logicalId, { authorize: async () => { throw new Error("access revoked"); } }),
    /access revoked/,
  );
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


// ---- S6a: stale-leftover reclaim, truthful conflicts, serialization -------------------------

const OWN_BIN = "/opt/homebrew/bin/iproxy";

// A fake operating system shared by the port probe, the inspector and `kill`.
function conflictWorld() {
  const processes = new Map();
  const listeners = new Map(); // port -> [pid]
  const signals = [];
  const inspector = {
    supported: true,
    describe: async pid => processes.get(pid) ?? null,
    findListeners: async port => ({ supported: true, listeners: (listeners.get(port) ?? []).map(pid => ({ pid })) }),
  };
  const world = {
    processes, listeners, signals, inspector,
    ignoreTerm: false, ignoreKill: false,
    isPortAvailable: async port => (listeners.get(port) ?? []).length === 0,
    kill(pid, signal) {
      signals.push([pid, signal]);
      if ((signal === "SIGTERM" && world.ignoreTerm) || (signal === "SIGKILL" && world.ignoreKill)) return;
      processes.delete(pid);
      for (const [port, pids] of listeners) listeners.set(port, pids.filter(candidate => candidate !== pid));
    },
    hold(port, pid, description) {
      processes.set(pid, { pid, ppid: 1, pgid: pid, startTime: "Tue Oct 6 19:00:00 2026", program: "iproxy", command: "x", ...description });
      listeners.set(port, [...(listeners.get(port) ?? []), pid]);
    },
  };
  return world;
}

function reclaimExtra(world, records = []) {
  return {
    portReclaimer: createPortReclaimer({ inspector: world.inspector, kill: world.kill, sleep: async () => {}, termWaitMs: 200, killWaitMs: 200, pollMs: 100 }),
    ownershipStore: { list: () => records },
    ownerServer: { pid: 900, startTime: "Tue Oct 6 20:00:00 2026" },
    iproxyBin: OWN_BIN,
  };
}

// Attach a phone once so its ports are persisted, then "restart Bodun" on the same store.
async function restartedWithBusyPorts(world, { records = [], holders }) {
  const store = tempStorePath();
  const first = makeProvisioner({ provisioningStorePath: store });
  first.state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await first.provisioner.pollOnce();
  for (const holder of holders) world.hold(holder.port, holder.pid, holder.description);
  const restarted = makeProvisioner({ provisioningStorePath: store, isPortAvailable: world.isPortAvailable, extra: reclaimExtra(world, records) });
  restarted.state.attached = first.state.attached;
  await restarted.provisioner.pollOnce();
  return restarted;
}

const STALE_COMMAND = `${OWN_BIN} -u UDID-00000001 9000:8100 9100:9100`;
const STALE_RECORD = {
  kind: "iproxy", udid: "UDID-00000001", pid: 4121, startTime: "Tue Oct 6 19:00:00 2026", command: STALE_COMMAND,
  unverified: false, ports: [9000, 9100], ownerServerPid: 555, ownerServerStartTime: "Tue Oct 6 18:00:00 2026",
};

test("a stale Bodun leftover holding the persisted ports is stopped and the phone comes up", async () => {
  const world = conflictWorld();
  const restarted = await restartedWithBusyPorts(world, {
    records: [STALE_RECORD],
    holders: [{ port: 9000, pid: 4121, description: { command: STALE_COMMAND } }, { port: 9100, pid: 4121, description: { command: STALE_COMMAND } }],
  });
  const device = restarted.devices.get(discoveredDeviceId("UDID-00000001"));
  assert.deepEqual(world.signals, [[4121, "SIGTERM"]]);
  assert.equal(restarted.wdaProcessManager.starts.length, 1, "the phone proceeds");
  assert.equal(restarted.iproxyManager.starts.length, 1);
  assert.notEqual(device.componentHealth.recovery, "BLOCKED_PORT");
  assert.equal(device.discoveryState, "provisioning");
});

test("a foreign program on the port keeps the phone blocked, is never signalled, and is named in plain words", async () => {
  const world = conflictWorld();
  const restarted = await restartedWithBusyPorts(world, {
    holders: [{ port: 9000, pid: 4121, description: { program: "proxy-tool", ppid: 3333, command: "proxy-tool --listen 9000" } }],
  });
  const device = restarted.devices.get(discoveredDeviceId("UDID-00000001"));
  assert.equal(world.signals.length, 0);
  assert.equal(restarted.iproxyManager.starts.length, 0);
  assert.equal(device.componentHealth.recovery, "BLOCKED_PORT");
  assert.match(device.discoveryStateMessage, /proxy-tool/);
  assert.match(device.discoveryStateMessage, /process 4121/);
  assert.match(device.discoveryStateMessage, /port 9000/);
  assertPlainOperatorText(device.discoveryStateMessage, "banner");
  assert.doesNotMatch(JSON.stringify(device.componentErrors.iproxy), /--listen|UDID-00000001/, "never the holder's command line or a phone id");
});

test("a listener Bodun cannot identify keeps the phone blocked and is never signalled", async () => {
  const world = conflictWorld();
  const restarted = await restartedWithBusyPorts(world, { holders: [] });
  const logicalId = discoveredDeviceId("UDID-00000001");
  await restarted.provisioner.stopDevice(logicalId);
  world.listeners.set(9000, [4121]); // visible to the port probe, invisible to the inspector
  await assert.rejects(() => restarted.provisioner.startDevice(logicalId), error => {
    assert.equal(error.code, "port_held_by_unidentified_program");
    assertPlainOperatorText(error.message, "error");
    return true;
  });
  assert.equal(world.signals.length, 0);
});

test("a leftover that will not stop reports that Bodun could not stop its old process", async () => {
  const world = conflictWorld();
  world.ignoreTerm = true;
  world.ignoreKill = true;
  const restarted = await restartedWithBusyPorts(world, {
    records: [STALE_RECORD],
    holders: [{ port: 9000, pid: 4121, description: { command: STALE_COMMAND } }],
  });
  const device = restarted.devices.get(discoveredDeviceId("UDID-00000001"));
  assert.deepEqual(world.signals, [[4121, "SIGTERM"], [4121, "SIGKILL"]]);
  assert.equal(device.componentHealth.recovery, "STOP_FAILED");
  assert.match(device.discoveryStateMessage, /could not stop its old connection process/);
});

test("Restart on a phone whose port is held by another program throws the typed error and keeps the phone enabled", async () => {
  const world = conflictWorld();
  const { provisioner, state, devices } = makeProvisioner({ isPortAvailable: world.isPortAvailable, extra: reclaimExtra(world) });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  world.hold(9000, 4121, { program: "proxy-tool", ppid: 3333, command: "proxy-tool --listen 9000" });
  await assert.rejects(() => provisioner.restartDevice(logicalId), error => {
    assert.ok(error instanceof LifecycleError);
    assert.equal(error.code, "port_held_by_other_program");
    assert.equal(error.status, 409);
    assert.match(error.message, /proxy-tool/);
    return true;
  });
  assert.equal(provisioner.runtime.get("UDID-00000001").wdaEnabled, true, "a port conflict must not turn WDA off");
  assert.equal(devices.get(logicalId).componentHealth.recovery, "BLOCKED_PORT");
  assert.equal(world.signals.length, 0);
});

test("an iproxy that died on a stale Bodun leftover is brought back once the leftover is stopped", async () => {
  const world = conflictWorld();
  const { provisioner, iproxyManager, state } = makeProvisioner({
    isPortAvailable: world.isPortAvailable, extra: reclaimExtra(world, [STALE_RECORD]),
  });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  world.hold(9000, 4121, { command: STALE_COMMAND });
  iproxyManager.emitExit("UDID-00000001", ["bind: Address already in use"]);
  for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(world.signals, [[4121, "SIGTERM"]]);
  assert.equal(iproxyManager.starts.length, 2, "the tunnel is restarted on the same ports");
  assert.notEqual(provisioner.runtime.get("UDID-00000001").wdaDevice.componentHealth.recovery, "BLOCKED_PORT");
});

test("a Retry queued behind a port recovery waits for it", async () => {
  const world = conflictWorld();
  const { provisioner, iproxyManager, wdaProcessManager, state } = makeProvisioner({ isPortAvailable: world.isPortAvailable, extra: reclaimExtra(world) });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const realStop = iproxyManager.stop.bind(iproxyManager);
  let first = true;
  iproxyManager.stop = udid => { realStop(udid); if (first) { first = false; return gate; } return undefined; };
  iproxyManager.emitExit("UDID-00000001", ["bind: Address already in use"]);
  await new Promise(resolve => setImmediate(resolve));
  const wdaStopsBefore = wdaProcessManager.stops.length;
  const retry = provisioner.retryDevice(discoveredDeviceId("UDID-00000001"));
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(wdaProcessManager.stops.length, wdaStopsBefore, "the Retry has not started while the recovery is still running");
  release();
  assert.equal((await retry).ok, true);
  assert.ok(wdaProcessManager.stops.length > wdaStopsBefore, "…and it ran after the recovery finished");
});

test("a port conflict is never resolved while the provisioner is shutting down", async () => {
  const world = conflictWorld();
  const { provisioner, state } = makeProvisioner({ isPortAvailable: world.isPortAvailable, extra: reclaimExtra(world, [STALE_RECORD]) });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  world.hold(9000, 4121, { command: STALE_COMMAND });
  provisioner.stopping = true;
  const result = await provisioner._resolvePortConflict(provisioner.runtime.get("UDID-00000001"));
  assert.equal(result.status, "shutting_down");
  assert.equal(world.signals.length, 0);
});


// ---- S7: startup sweep of stale ownership records ------------------------------------------

function sweepFixture(world, records) {
  const dropped = [];
  const store = {
    list: () => records.filter(record => !dropped.includes(record)),
    drop: async (kind, udid) => { const record = records.find(item => item.kind === kind && item.udid === udid); if (record) dropped.push(record); return true; },
  };
  const extra = { ...reclaimExtra(world, records), ownershipStore: store };
  const { provisioner } = makeProvisioner({ isPortAvailable: world.isPortAvailable, extra });
  return { provisioner, dropped };
}

const SWEEP_RECORD = { ...STALE_RECORD };

test("sweep: a record whose process is gone is dropped", async () => {
  const world = conflictWorld();
  const { provisioner, dropped } = sweepFixture(world, [SWEEP_RECORD]);
  const summary = await provisioner.sweepStaleOwnership();
  assert.equal(dropped.length, 1);
  assert.equal(summary.dropped, 1);
  assert.equal(world.signals.length, 0);
});

test("sweep: an unavailable process inspection preserves the record and blocks replacement", async () => {
  const world = conflictWorld();
  world.inspector.describe = async () => undefined;
  const { provisioner, dropped } = sweepFixture(world, [SWEEP_RECORD]);
  const summary = await provisioner.sweepStaleOwnership();
  assert.equal(dropped.length, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(world.signals.length, 0);
});

test("sweep: a still-running leftover whose owner server is dead is stopped and its record dropped", async () => {
  const world = conflictWorld();
  world.hold(9000, 4121, { command: STALE_COMMAND });
  const { provisioner, dropped } = sweepFixture(world, [SWEEP_RECORD]);
  const summary = await provisioner.sweepStaleOwnership();
  assert.deepEqual(world.signals, [[4121, "SIGTERM"]]);
  assert.equal(summary.reclaimed, 1);
  assert.equal(dropped.length, 1);
});

test("sweep: a reused pid (different start time) is never signalled; only the record is dropped", async () => {
  const world = conflictWorld();
  world.hold(9000, 4121, { command: STALE_COMMAND, startTime: "Tue Oct 6 23:30:00 2026" });
  const { provisioner, dropped } = sweepFixture(world, [SWEEP_RECORD]);
  await provisioner.sweepStaleOwnership();
  assert.equal(world.signals.length, 0);
  assert.equal(dropped.length, 1);
});

test("sweep: a live unverified record is preserved and never signalled", async () => {
  const world = conflictWorld();
  world.hold(9000, 4121, { command: STALE_COMMAND });
  const { provisioner, dropped } = sweepFixture(world, [{ ...SWEEP_RECORD, startTime: null, unverified: true }]);
  const summary = await provisioner.sweepStaleOwnership();
  assert.equal(world.signals.length, 0);
  assert.equal(dropped.length, 0);
  assert.equal(summary.skipped, 1);
});

test("sweep: an unverified record is dropped only after its pid is confirmed gone", async () => {
  const world = conflictWorld();
  const { provisioner, dropped } = sweepFixture(world, [{ ...SWEEP_RECORD, startTime: null, unverified: true }]);
  const summary = await provisioner.sweepStaleOwnership();
  assert.equal(world.signals.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(summary.dropped, 1);
});

test("sweep: a process owned by a different, still-alive Bodun server is left alone with its record", async () => {
  const world = conflictWorld();
  world.hold(9000, 4121, { command: STALE_COMMAND });
  world.processes.set(555, { pid: 555, ppid: 1, pgid: 555, startTime: "Tue Oct 6 18:00:00 2026", program: "Bodun", command: "Bodun server" });
  const { provisioner, dropped } = sweepFixture(world, [SWEEP_RECORD]);
  const summary = await provisioner.sweepStaleOwnership();
  assert.equal(world.signals.length, 0);
  assert.equal(dropped.length, 0);
  assert.equal(summary.skipped, 1);
});

test("sweep: an owner pid that was reused by another process counts as a dead owner", async () => {
  const world = conflictWorld();
  world.hold(9000, 4121, { command: STALE_COMMAND });
  world.processes.set(555, { pid: 555, ppid: 1, pgid: 555, startTime: "Tue Oct 6 22:00:00 2026", program: "other", command: "other" });
  const { provisioner } = sweepFixture(world, [SWEEP_RECORD]);
  const summary = await provisioner.sweepStaleOwnership();
  assert.equal(summary.reclaimed, 1);
});

test("sweep: an alive owner whose start time was never recorded is skipped (safe default)", async () => {
  const world = conflictWorld();
  world.hold(9000, 4121, { command: STALE_COMMAND });
  world.processes.set(555, { pid: 555, ppid: 1, pgid: 555, startTime: "whenever", program: "Bodun", command: "Bodun server" });
  const { provisioner, dropped } = sweepFixture(world, [{ ...SWEEP_RECORD, ownerServerStartTime: null }]);
  await provisioner.sweepStaleOwnership();
  assert.equal(world.signals.length, 0);
  assert.equal(dropped.length, 0);
});

test("sweep: nothing happens without an ownership store and reclaimer", async () => {
  const { provisioner } = makeProvisioner();
  assert.deepEqual(await provisioner.sweepStaleOwnership(), { dropped: 0, reclaimed: 0, skipped: 0 });
});

test("start() sweeps before the first discovery pass", async () => {
  const world = conflictWorld();
  world.hold(9000, 4121, { command: STALE_COMMAND });
  const { provisioner } = sweepFixture(world, [SWEEP_RECORD]);
  const order = [];
  const realSweep = provisioner.sweepStaleOwnership.bind(provisioner);
  provisioner.sweepStaleOwnership = async () => { order.push("sweep"); return realSweep(); };
  const realPoll = provisioner.pollOnce.bind(provisioner);
  provisioner.pollOnce = () => { order.push("poll"); return realPoll(); };
  await provisioner.start();
  assert.equal(order[0], "sweep");
  assert.ok(order.indexOf("poll") > order.indexOf("sweep"));
  await provisioner.stop();
});

test("start() does not install polling or discover phones until the ownership sweep settles", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner({
    extra: { ownershipStore: { list: () => [] } },
  });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  let releaseSweep;
  provisioner.sweepStaleOwnership = () => new Promise(resolve => { releaseSweep = resolve; });

  const started = provisioner.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(provisioner.timer, null, "the periodic poll is not armed during stale-process inspection");
  assert.equal(wdaProcessManager.starts.length, 0);
  assert.equal(iproxyManager.starts.length, 0);

  releaseSweep({ dropped: 0, reclaimed: 0, skipped: 0 });
  await started;
  assert.equal(wdaProcessManager.starts.length, 1);
  assert.equal(iproxyManager.starts.length, 1);
  assert.ok(provisioner.timer, "polling begins only after the barrier and first discovery pass");
  await provisioner.stop();
});

test("a failed ownership sweep blocks polling and pauses setup (until a later check succeeds)", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner({ extra: { startupRetryDelayMs: 0 } });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  provisioner.sweepStaleOwnership = async () => { throw new Error("ownership unavailable"); };
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await provisioner.start();
    await provisioner.pollOnce();
  } finally {
    console.error = originalError;
  }
  assert.equal(provisioner.timer, null);
  assert.equal(wdaProcessManager.starts.length, 0);
  assert.equal(iproxyManager.starts.length, 0);
  assert.ok(errors.some(line => /blocked.*ownership|ownership.*blocked/i.test(line)));
  assert.equal(provisioner.getSetupStatus().code, "setup_paused_cannot_check");
  await provisioner.stop();
});

test("an unresolved ownership record also blocks startup discovery", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner({ extra: { startupRetryDelayMs: 0 } });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  provisioner.sweepStaleOwnership = async () => ({ dropped: 0, reclaimed: 0, skipped: 1 });
  const originalError = console.error;
  console.error = () => {};
  try {
    await provisioner.start();
    await provisioner.pollOnce();
  } finally {
    console.error = originalError;
  }
  assert.equal(provisioner.timer, null);
  assert.equal(wdaProcessManager.starts.length, 0);
  assert.equal(iproxyManager.starts.length, 0);
  await provisioner.stop();
});

// ---- S9: no FAILED <-> STOPPED flapping while the cause is unchanged -------------------------

test("a port-blocked phone keeps its FAILED iproxy state and error across readiness sweeps (attach path)", async () => {
  const world = conflictWorld();
  const restarted = await restartedWithBusyPorts(world, {
    holders: [{ port: 9000, pid: 4121, description: { program: "proxy-tool", ppid: 3333, command: "proxy-tool --listen 9000" } }],
  });
  const entry = restarted.provisioner.runtime.get("UDID-00000001");
  entry.wdaEnabled = true;
  for (let sweep = 0; sweep < 3; sweep += 1) {
    await restarted.provisioner._reconcileReadiness();
    assert.equal(entry.wdaDevice.componentHealth.iproxy, "FAILED", `sweep ${sweep}`);
    assert.equal(entry.wdaDevice.componentHealth.recovery, "BLOCKED_PORT");
    assert.ok(entry.wdaDevice.componentErrors.iproxy);
  }
});

test("a port-blocked phone keeps its FAILED iproxy state across readiness sweeps (died-on-busy-port path)", async () => {
  const world = conflictWorld();
  const { provisioner, iproxyManager, state } = makeProvisioner({ isPortAvailable: world.isPortAvailable, extra: reclaimExtra(world) });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  world.hold(9000, 4121, { program: "proxy-tool", ppid: 3333, command: "proxy-tool --listen 9000" });
  iproxyManager.emitExit("UDID-00000001", ["bind: Address already in use"]);
  for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setImmediate(resolve));
  const entry = provisioner.runtime.get("UDID-00000001");
  assert.equal(entry.wdaDevice.componentHealth.recovery, "BLOCKED_PORT");
  for (let sweep = 0; sweep < 3; sweep += 1) {
    await provisioner._reconcileReadiness();
    assert.equal(entry.wdaDevice.componentHealth.iproxy, "FAILED", `sweep ${sweep}`);
  }
});

test("the latch clears after a successful retry, and on detach", async () => {
  const world = conflictWorld();
  const { provisioner, iproxyManager, state } = makeProvisioner({ isPortAvailable: world.isPortAvailable, extra: reclaimExtra(world) });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  iproxyManager.running.clear(); // Bodun's own tunnel is no longer running, so its ports are up for grabs
  world.hold(9000, 4121, { program: "proxy-tool", ppid: 3333, command: "proxy-tool --listen 9000" });
  await assert.rejects(() => provisioner.retry("UDID-00000001"));
  const entry = provisioner.runtime.get("UDID-00000001");
  assert.equal(entry.wdaDevice.componentHealth.iproxy, "FAILED");
  world.listeners.set(9000, []); // the other program went away
  assert.equal((await provisioner.retry("UDID-00000001")).ok, true);
  assert.notEqual(entry.wdaDevice.componentHealth.recovery, "BLOCKED_PORT");
  await provisioner._reconcileReadiness();
  assert.notEqual(entry.wdaDevice.componentHealth.iproxy, "FAILED");
  state.attached = [];
  await provisioner.pollOnce();
  assert.equal(provisioner.runtime.has("UDID-00000001"), false);
});

// ---- S14: the lifecycle state the card shows -----------------------------------------------

test("lifecycle state carries the allowed actions and their reasons for an attached phone", async () => {
  const { provisioner, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const lifecycle = provisioner.getLifecycleState(discoveredDeviceId("UDID-00000001"));
  assert.equal(lifecycle.managed, true);
  assert.equal(lifecycle.attached, true);
  assert.equal(lifecycle.state, "enabled"); // both processes are running; control is not verified yet
  assert.equal(lifecycle.canStart, false);
  assert.equal(lifecycle.startReason, "Already running.");
  assert.equal(lifecycle.canStop, true);
  assert.equal(lifecycle.canRestart, true);
  assert.equal(lifecycle.restartReason, null);
});

test("a phone in use by a human cannot be stopped or restarted while attached, and says why", async () => {
  const { provisioner, state, devices } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  provisioner.wdaProcessManager.emitStable("UDID-00000001");
  provisioner.iproxyManager.emitStable("UDID-00000001");
  devices.get(logicalId).status = "in-use";
  const lifecycle = provisioner.getLifecycleState(logicalId);
  assert.equal(lifecycle.inUse, true);
  assert.equal(lifecycle.canStop, false);
  assert.equal(lifecycle.stopReason, "Release the phone first.");
});

test("authoritative ownership overrides a stale device status in lifecycle guidance", async () => {
  const { provisioner, state, devices } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  devices.get(logicalId).status = "in-use";

  const lifecycle = provisioner.getLifecycleState(logicalId, { inUse: false });
  assert.equal(lifecycle.inUse, false);
  assert.equal(lifecycle.canStop, true);
  assert.equal(lifecycle.stopReason, null);
});

test("a phone unplugged in this session reports 'detached', can still be stopped, and cannot be started or restarted", async () => {
  const { provisioner, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  state.attached = [];
  await provisioner.pollOnce();
  const lifecycle = provisioner.getLifecycleState(logicalId);
  assert.equal(lifecycle.state, "detached");
  assert.equal(lifecycle.attached, false);
  assert.equal(lifecycle.enabled, true);
  assert.equal(lifecycle.canStop, true);
  assert.equal(lifecycle.canStart, false);
  assert.equal(lifecycle.startReason, "Plug the phone in first.");
  assert.equal(lifecycle.canRestart, false);
});

test("an unknown logical id has no lifecycle", () => {
  const { provisioner } = makeProvisioner();
  assert.equal(provisioner.getLifecycleState("ios-nothing"), null);
});

// ---- S15: typed lifecycle errors -----------------------------------------------------------

async function lifecycleError(promise) {
  try { await promise; } catch (error) { return error; }
  return null;
}

test("start/stop/restart of a phone Bodun does not manage say so (409), instead of returning nothing", async () => {
  const { provisioner } = makeProvisioner();
  for (const action of ["startDevice", "stopDevice", "restartDevice"]) {
    const error = await lifecycleError(provisioner[action]("ios-never-seen"));
    assert.ok(error instanceof LifecycleError, action);
    assert.equal(error.code, "device_not_managed");
    assert.equal(error.status, 409);
  }
});

test("start and restart of an unplugged phone say it must be plugged in", async () => {
  const { provisioner, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  state.attached = [];
  await provisioner.pollOnce();
  for (const action of ["startDevice", "restartDevice"]) {
    const error = await lifecycleError(provisioner[action](logicalId));
    assert.equal(error?.code, "device_not_attached", action);
  }
});

test("while shutting down every lifecycle action is a 503 shutting_down", async () => {
  const { provisioner } = makeProvisioner();
  provisioner.stopping = true;
  for (const action of ["startDevice", "stopDevice", "restartDevice"]) {
    const error = await lifecycleError(provisioner[action]("ios-any"));
    assert.equal(error?.code, "shutting_down", action);
    assert.equal(error.status, 503);
  }
});

test("a stop that cannot be confirmed is wda_stop_unconfirmed with plain wording", async () => {
  const { provisioner, wdaProcessManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  wdaProcessManager.stop = () => ({ ok: false, error: "did not exit" });
  const error = await lifecycleError(provisioner.stopDevice(discoveredDeviceId("UDID-00000001")));
  assert.equal(error.code, "wda_stop_unconfirmed");
  assert.equal(error.status, 409);
  assertPlainOperatorText(error.message, "stop failure");
});

test("a restart whose old processes do not confirm exit is the same typed error and keeps the phone enabled", async () => {
  const { provisioner, wdaProcessManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  wdaProcessManager.stop = () => ({ ok: false, error: "did not exit" });
  const error = await lifecycleError(provisioner.restartDevice(discoveredDeviceId("UDID-00000001")));
  assert.equal(error.code, "wda_stop_unconfirmed");
  assert.equal(provisioner.runtime.get("UDID-00000001").wdaEnabled, true);
});


// ---- S16 / S17: Start, Stop and Restart for failed, blocked and unplugged phones ----------------

function blockStops(provisioner, { wda = true, iproxy = true } = {}) {
  const gates = { cleared: false, calls: [] };
  for (const [manager, active] of [[provisioner.wdaProcessManager, wda], [provisioner.iproxyManager, iproxy]]) {
    if (!active) continue;
    manager.running.clear();
    manager.getStatus = () => (gates.cleared ? { state: "stopped", restartCount: 0 } : { state: "stop_failed", restartCount: 0 });
    manager.clearBlockedStop = async (udid, options) => { gates.calls.push([udid, options ?? null]); return gates.cleared; };
  }
  return gates;
}

test("Start on a failed phone whose old process never confirmed exit: refused while it may be alive, works once it is provably gone", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const gates = blockStops(provisioner);
  assert.equal(provisioner.getLifecycleState(logicalId).state, "failed");
  assert.equal(provisioner.getLifecycleState(logicalId).canStart, true);

  const refused = await lifecycleError(provisioner.startDevice(logicalId));
  assert.equal(refused.code, "old_process_would_not_stop");
  assert.equal(wdaProcessManager.starts.length, 1, "nothing new was started");

  gates.cleared = true; // the old process is now provably gone
  const lifecycle = await provisioner.startDevice(logicalId);
  assert.equal(lifecycle.enabled, true);
  assert.equal(wdaProcessManager.starts.length, 2);
  assert.equal(iproxyManager.starts.length, 2);
});

test("Start on a failed phone whose processes are still running is refused plainly: use Restart", async () => {
  const { provisioner, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  provisioner.runtime.get("UDID-00000001").wdaDevice.setComponentHealth({ recovery: "FAILED" });
  const error = await lifecycleError(provisioner.startDevice(logicalId));
  assert.equal(error.code, "running_not_responding");
  assert.equal(error.message, "Control is running but not responding. Use Restart WDA.");
});

test("a supervisor that reports blocked is never reported as a successful Start", async () => {
  const { provisioner, wdaProcessManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  await provisioner.stopDevice(logicalId);
  wdaProcessManager.start = opts => { wdaProcessManager.starts.push(opts); return "blocked"; };
  const error = await lifecycleError(provisioner.startDevice(logicalId));
  assert.equal(error.code, "old_process_would_not_stop");
});

test("Start reports a queued supervisor replacement as pending and does not launch iproxy", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  await provisioner.stopDevice(logicalId);
  const iproxyStarts = iproxyManager.starts.length;
  wdaProcessManager.start = opts => { wdaProcessManager.starts.push(opts); return "queued"; };
  const error = await lifecycleError(provisioner.startDevice(logicalId));
  assert.equal(error.code, "process_replacement_pending");
  assert.equal(iproxyManager.starts.length, iproxyStarts, "a second process is not launched after a queued WDA result");
  assert.equal(provisioner.getLifecycleState(logicalId).state, "failed");
});

test("Retry and Restart never report success when a supervisor blocks or queues replacement", async () => {
  {
    const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
    state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
    await provisioner.pollOnce();
    const logicalId = discoveredDeviceId("UDID-00000001");
    const iproxyStarts = iproxyManager.starts.length;
    wdaProcessManager.start = opts => { wdaProcessManager.starts.push(opts); return "blocked"; };
    const error = await lifecycleError(provisioner.retryDevice(logicalId));
    assert.equal(error.code, "old_process_would_not_stop");
    assert.equal(iproxyManager.starts.length, iproxyStarts, "Retry stops after the blocked WDA result");
  }
  {
    const { provisioner, iproxyManager, state } = makeProvisioner();
    state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
    await provisioner.pollOnce();
    const logicalId = discoveredDeviceId("UDID-00000001");
    iproxyManager.start = opts => { iproxyManager.starts.push(opts); return "queued"; };
    const error = await lifecycleError(provisioner.restartDevice(logicalId));
    assert.equal(error.code, "process_replacement_pending");
    assert.equal(provisioner.getLifecycleState(logicalId).state, "failed");
  }
});

test("Stop on a phone that is already off but whose stop was never confirmed re-attempts it and reports the truth", async () => {
  const { provisioner, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  await provisioner.stopDevice(logicalId); // the flag is now off
  const gates = blockStops(provisioner);
  const refused = await lifecycleError(provisioner.stopDevice(logicalId));
  assert.equal(refused.code, "wda_stop_unconfirmed");
  gates.cleared = true;
  const lifecycle = await provisioner.stopDevice(logicalId);
  assert.equal(lifecycle.state, "stopped");
  assert.ok(gates.calls.length >= 1);
});

test("Restart on a phone with an unconfirmed stop clears it when provably gone, refuses while it may be alive, and stays enabled", async () => {
  const { provisioner, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const gates = blockStops(provisioner);
  const refused = await lifecycleError(provisioner.restartDevice(logicalId));
  assert.equal(refused.code, "old_process_would_not_stop");
  assert.equal(provisioner.runtime.get("UDID-00000001").wdaEnabled, true);
  gates.cleared = true;
  const lifecycle = await provisioner.restartDevice(logicalId);
  assert.equal(lifecycle.enabled, true);
});

test("a supervisor-owned process that is provably Bodun's own is stopped, and that unblocks Restart", async () => {
  const world = conflictWorld();
  const record = { ...STALE_RECORD, ownerServerPid: 900, ownerServerStartTime: "Tue Oct 6 20:00:00 2026" };
  const { provisioner, state } = makeProvisioner({
    isPortAvailable: world.isPortAvailable,
    extra: { ...reclaimExtra(world, [record]), ownershipStore: { list: () => [record], get: (kind, udid) => (kind === "iproxy" && udid === record.udid ? record : null) } },
  });
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const gates = blockStops(provisioner, { wda: false });
  world.hold(9000, 4121, { command: STALE_COMMAND }); // the unconfirmed process is still alive and provably ours
  provisioner.iproxyManager.clearBlockedStop = async (udid, options) => { gates.calls.push([udid, options ?? null]); return options?.verifiedGone === true; };
  const lifecycle = await provisioner.restartDevice(logicalId);
  assert.deepEqual(world.signals, [[4121, "SIGTERM"]]);
  assert.equal(lifecycle.enabled, true);
  assert.ok(gates.calls.some(([, options]) => options?.verifiedGone === true));
});

test("Stop, Start and Restart requests queue and never interleave", async () => {
  const { provisioner, wdaProcessManager, iproxyManager, state } = makeProvisioner();
  state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  const events = [];
  const realStart = wdaProcessManager.start.bind(wdaProcessManager);
  const realStop = wdaProcessManager.stop.bind(wdaProcessManager);
  wdaProcessManager.start = opts => { events.push("start"); return realStart(opts); };
  wdaProcessManager.stop = udid => { events.push("stop"); return realStop(udid); };
  await Promise.allSettled([
    provisioner.restartDevice(logicalId), provisioner.stopDevice(logicalId), provisioner.startDevice(logicalId), provisioner.stopDevice(logicalId),
  ]);
  // restart = stop,start ; stop = stop ; start = start ; stop = stop  (in exactly that order)
  assert.deepEqual(events, ["stop", "start", "stop", "start", "stop"]);
  assert.equal(provisioner.getLifecycleState(logicalId).state, "stopped");
  assert.equal(iproxyManager.running.size, 0);
});

test("a phone unplugged in this session can be stopped, and comes back stopped when plugged in again", async () => {
  const store = tempStorePath();
  const first = makeProvisioner({ provisioningStorePath: store });
  first.state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await first.provisioner.pollOnce();
  const logicalId = discoveredDeviceId("UDID-00000001");
  first.state.attached = [];
  await first.provisioner.pollOnce();
  assert.equal(first.provisioner.getLifecycleState(logicalId).state, "detached");
  const lifecycle = await first.provisioner.stopDevice(logicalId);
  assert.equal(lifecycle.enabled, false);
  assert.equal(lifecycle.canStop, false);
  assert.equal(lifecycle.stopReason, "Already stopped.");

  // plugged in again, even by a fresh Bodun on the same storage
  const second = makeProvisioner({ provisioningStorePath: store });
  second.state.attached = [{ id: "x", udid: "UDID-00000001", label: "Phone" }];
  await second.provisioner.pollOnce();
  assert.equal(second.wdaProcessManager.starts.length, 0);
  assert.equal(second.devices.get(logicalId).discoveryState, "wda_stopped");
});
