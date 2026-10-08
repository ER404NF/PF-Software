// Found by the broken-phone demo: a phone whose connection port is held by another program told the operator
// "Control is running but not responding" on its disabled Start button, and a phone stopped on purpose kept showing
// an old "WDA endpoint unavailable" error. Both are fixed here.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceProvisioner, lifecycleGuidance } from "../../src/deviceProvisioner.js";
import { discoveredDeviceId } from "../../src/deviceDiscovery.js";
import { createPortReclaimer } from "../../src/portReclaimer.js";
import { PretendProcessManager, createPretendSystem } from "../../scripts/demoBrokenPhones.js";
import { assertPlainOperatorText } from "../helpers/plainText.js";

function build({ withReclaimer = true } = {}) {
  const devices = new Map();
  const world = createPretendSystem();
  const wda = new PretendProcessManager();
  const iproxy = new PretendProcessManager();
  const attached = [{ id: "x", udid: "UDID-BLOCK-0001", label: "Phone" }];
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-lifecycle-blocked-"));
  const provisioner = new DeviceProvisioner({
    devices, discoverIosDevices: () => attached, manualUdids: new Set(), wdaProcessManager: wda, iproxyManager: iproxy,
    provisioningStorePath: path.join(folder, "store.json"), derivedDataRoot: path.join(folder, "derived"),
    portRange: { start: 38300, end: 38309 }, mjpegPortRange: { start: 38400, end: 38409 },
    isPortAvailable: world.isPortAvailable,
    ...(withReclaimer ? { portReclaimer: createPortReclaimer({ inspector: world.inspector, kill: () => { throw new Error("never signalled"); }, sleep: async () => {} }) } : {}),
  });
  return { provisioner, devices, world, wda, iproxy, id: discoveredDeviceId("UDID-BLOCK-0001") };
}

async function blockThePort(fixture, program = "proxy-tool") {
  await fixture.provisioner.pollOnce();
  const tunnel = fixture.iproxy.starts[0];
  for (const port of [tunnel.localPort, tunnel.mjpegLocalPort]) fixture.world.holdPort(port, 7421, { program, command: `${program} --listen ${port}` });
  fixture.iproxy.emitExit("UDID-BLOCK-0001", ["bind: Address already in use"]);
  for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

test("guidance: a blocked phone's Start says what is wrong instead of 'running but not responding'", () => {
  const message = "Close the other program first, then use Retry setup.";
  const guidance = lifecycleGuidance({ state: "failed", anyRunning: true, blockedMessage: message });
  assert.equal(guidance.canStart, false);
  assert.equal(guidance.startReason, message);
  assert.equal(guidance.canStop, true, "Stop still works so the phone can always be cleaned up");
  assert.equal(guidance.canRestart, true, "Restart is how it is tried again once the other program is gone");
});

test("guidance: without a blocked message the wording is unchanged", () => {
  assert.equal(lifecycleGuidance({ state: "failed", anyRunning: true }).startReason, "Control is running but not responding. Use Restart WDA.");
  assert.equal(lifecycleGuidance({ state: "stopped" }).canStart, true);
});

test("a phone blocked by another program: Start says what to do, and does not repeat the banner above the buttons", async () => {
  const f = build();
  await blockThePort(f);
  const lifecycle = f.provisioner.getLifecycleState(f.id);
  assert.equal(lifecycle.canStart, false);
  assert.equal(lifecycle.startReason, "Close the other program first, then use Retry setup.");
  assert.doesNotMatch(lifecycle.startReason, /running but not responding/);
  assert.notEqual(lifecycle.startReason, f.devices.get(f.id).discoveryStateMessage, "the sentence is shown once on the card");
  assertPlainOperatorText(lifecycle.startReason, "blocked start reason");
  await f.provisioner.stop();
});

test("a phone blocked by a program Bodun cannot name still gets a plain reason", async () => {
  const f = build({ withReclaimer: false });
  await blockThePort(f);
  const lifecycle = f.provisioner.getLifecycleState(f.id);
  assert.equal(lifecycle.canStart, false);
  assert.equal(lifecycle.startReason, "Close the other program first, then use Retry setup.");
  assertPlainOperatorText(lifecycle.startReason, "unnamed blocked start reason");
  await f.provisioner.stop();
});

test("stopping a phone on purpose clears the old error, so the card does not show a failure for it", async () => {
  const f = build();
  await f.provisioner.pollOnce();
  const device = f.devices.get(f.id);
  device.readiness = { ...device.readiness, lastError: { code: "W204", name: "WDA endpoint unavailable", why: "No answer.", operatorAction: "Check the phone." } };
  device.componentErrors.wdaProcess = { code: "W202", name: "WDA process exited" };
  assert.ok(device.healthSnapshot().latestError, "an error is showing before the stop");
  await f.provisioner.stopDevice(f.id, { authorize: async () => {} });
  assert.equal(device.healthSnapshot().latestError, null);
  assert.equal(device.componentHealth.recovery, "OPERATOR_STOPPED");
  await f.provisioner.stop();
});

test("stopping a phone that is blocked also clears its error, and a later start can raise a fresh one", async () => {
  const f = build();
  await blockThePort(f);
  const device = f.devices.get(f.id);
  assert.ok(device.healthSnapshot().latestError, "the blocked phone shows its error");
  await f.provisioner.stopDevice(f.id, { authorize: async () => {} });
  assert.equal(device.healthSnapshot().latestError, null);
  await f.provisioner.stop();
});

test("a phone stopped on purpose is not probed again, so no new 'endpoint unavailable' error appears on it", async () => {
  const { mock } = await import("node:test");
  const f = build();
  await f.provisioner.pollOnce();
  await f.provisioner.stopDevice(f.id, { authorize: async () => {} });
  const device = f.devices.get(f.id);
  const fetchSpy = mock.method(globalThis, "fetch", async () => { throw new Error("must not be called for a stopped phone"); });
  try {
    assert.equal(await device.checkReadiness(), false);
    assert.equal(fetchSpy.mock.callCount(), 0, "no request is made to a phone that was stopped on purpose");
    assert.equal(device.healthSnapshot().latestError, null);
    assert.equal(device.componentHealth.recovery, "OPERATOR_STOPPED");
  } finally {
    fetchSpy.mock.restore();
    await f.provisioner.stop();
  }
});

test("starting the phone again makes it checkable again", async () => {
  const f = build();
  await f.provisioner.pollOnce();
  await f.provisioner.stopDevice(f.id, { authorize: async () => {} });
  await f.provisioner.startDevice(f.id, { authorize: async () => {} });
  const device = f.devices.get(f.id);
  assert.notEqual(device.componentHealth.recovery, "OPERATOR_STOPPED");
  await f.provisioner.stop();
});
