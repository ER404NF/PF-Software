import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { discoveredDeviceId } from "../../src/deviceDiscovery.js";
import { getUsbNetworkRecord, setUsbIface, setUsbIp } from "../../src/usbNetworkStore.js";
import { createProxy, assignProxyToDevice } from "../../src/proxyPool.js";
import { AutoNetworkEnrollment } from "../../src/autoNetworkEnrollment.js";

const MASTER_KEY = "a".repeat(32);
const UDID_A = "00000000-0000000000000A";
const UDID_B = "00000000-0000000000000B";

function tempStorePath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-autoenroll-")), name);
}

function sampleProxyPayload(overrides = {}) {
  return {
    provider: "Oxylabs", protocol: "socks5", host: "proxy.example.com", port: 7000,
    username: "user1", password: "s3cret", country: "US", label: "Pool 1", ...overrides,
  };
}

function makeEnrollment({
  attached = [], members = ["en5"], ownIp = "192.168.2.1", captureOutput = "", startRouting = null,
  manualUdids = new Set(), pollIntervalMs = 20,
} = {}) {
  const usbNetworkStorePath = tempStorePath("usb-network.json");
  const proxyPoolStorePath = tempStorePath("proxy-pool.json");
  const statusChanges = [];
  const startRoutingCalls = [];
  const wrappedStartRouting = startRouting
    ? async (deviceId, opts) => { startRoutingCalls.push({ deviceId, opts }); return startRouting(deviceId, opts); }
    : null;
  const enrollment = new AutoNetworkEnrollment({
    bridgeIface: "bridge0",
    usbNetworkStorePath,
    proxyPoolStorePath,
    manualUdids,
    startRouting: wrappedStartRouting,
    discoverIosDevices: () => attached,
    listBridgeMembers: async () => members,
    discoverBridgeOwnIp: async () => ownIp,
    captureDeviceTraffic: async () => captureOutput,
    pollIntervalMs,
    onStatusChanged: (deviceId, status) => statusChanges.push({ deviceId, status }),
  });
  return { enrollment, usbNetworkStorePath, proxyPoolStorePath, statusChanges, startRoutingCalls };
}

test("a single unambiguous phone + bridge member is auto-enrolled with no human action", async () => {
  const { enrollment, usbNetworkStorePath } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }],
    members: ["en5"],
  });
  await enrollment.tick();

  const logicalId = discoveredDeviceId(UDID_A);
  const record = getUsbNetworkRecord(usbNetworkStorePath, logicalId);
  assert.equal(record.usbIface, "en5");
  assert.equal(enrollment.getStatus(logicalId).state, "discovering_ip");
});

test("two phones and two new members at once are never auto-paired — both flagged ambiguous", async () => {
  const { enrollment, usbNetworkStorePath } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }, { id: "y", udid: UDID_B, label: "Phone B" }],
    members: ["en5", "en6"],
  });
  await enrollment.tick();

  assert.equal(getUsbNetworkRecord(usbNetworkStorePath, discoveredDeviceId(UDID_A)), null);
  assert.equal(getUsbNetworkRecord(usbNetworkStorePath, discoveredDeviceId(UDID_B)), null);
  assert.equal(enrollment.getStatus(discoveredDeviceId(UDID_A)).state, "ambiguous");
  assert.equal(enrollment.getStatus(discoveredDeviceId(UDID_B)).state, "ambiguous");
});

test("a phone with no new bridge member yet is left pending, not misassigned to an unrelated stale member", async () => {
  const { enrollment, usbNetworkStorePath } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }],
    members: [], // Internet Sharing hasn't picked it up yet
  });
  await enrollment.tick();
  assert.equal(getUsbNetworkRecord(usbNetworkStorePath, discoveredDeviceId(UDID_A)), null);
  assert.equal(enrollment.getStatus(discoveredDeviceId(UDID_A)).state, "pending");
});

test("a bridge inspection failure stays retryable and reports pending instead of throwing", async () => {
  const { enrollment } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }], members: [],
  });
  enrollment.listBridgeMembers = async () => { throw new Error("ifconfig unavailable"); };

  await enrollment.tick();

  const status = enrollment.getStatus(discoveredDeviceId(UDID_A));
  assert.equal(status.state, "pending");
  assert.match(status.note, /ifconfig unavailable/);
});

test("a manually configured UDID is never auto-enrolled", async () => {
  const { enrollment, usbNetworkStorePath } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }],
    members: ["en5"],
    manualUdids: new Set([UDID_A]),
  });
  await enrollment.tick();
  assert.equal(getUsbNetworkRecord(usbNetworkStorePath, discoveredDeviceId(UDID_A)), null);
  assert.equal(enrollment.getStatus(discoveredDeviceId(UDID_A)), null);
});

test("a bridge member already claimed by a previously-enrolled device is excluded from the pending pool", async () => {
  // First tick enrolls A on en5. A second phone (B) then appears alongside
  // a SECOND new member (en6) — this must resolve cleanly to B<->en6, not
  // be treated as "2 candidates" just because en5 is still on the bridge.
  const { enrollment } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }],
    members: ["en5"],
  });
  await enrollment.tick();
  assert.equal(enrollment.getStatus(discoveredDeviceId(UDID_A)).state, "discovering_ip");

  enrollment.discoverIosDevices = () => [
    { id: "x", udid: UDID_A, label: "Phone A" },
    { id: "y", udid: UDID_B, label: "Phone B" },
  ];
  enrollment.listBridgeMembers = async () => ["en5", "en6"];
  await enrollment.tick();

  assert.equal(enrollment.getStatus(discoveredDeviceId(UDID_B)).state, "discovering_ip");
});

test("a persisted USB IP is re-observed on startup and a vanished interface is never reused", async () => {
  const { enrollment, usbNetworkStorePath } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }],
    members: ["en6"],
  });
  const logicalId = discoveredDeviceId(UDID_A);
  setUsbIface(usbNetworkStorePath, logicalId, "en5");
  setUsbIp(usbNetworkStorePath, logicalId, "192.168.2.99");

  await enrollment.tick();

  const record = getUsbNetworkRecord(usbNetworkStorePath, logicalId);
  assert.equal(record.usbIface, "en6", "the lone current bridge member is enrolled instead of reusing vanished en5");
  assert.equal(record.usbIp, null, "the persisted IP is never reused without fresh traffic evidence");
});

test("a discovery-command failure does not clear a previously attached phone's network mapping", async () => {
  const { enrollment, usbNetworkStorePath } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }], members: ["en5"],
  });
  const logicalId = discoveredDeviceId(UDID_A);
  await enrollment.tick();
  enrollment.discoverIosDevices = () => ({ ok: false, devices: [], error: { code: "D102" } });

  await enrollment.tick();

  assert.equal(getUsbNetworkRecord(usbNetworkStorePath, logicalId).usbIface, "en5");
});

test("a real detach clears transient mapping so reconnect performs enrollment again", async () => {
  let attached = [{ id: "x", udid: UDID_A, label: "Phone A" }];
  const { enrollment, usbNetworkStorePath } = makeEnrollment({ attached, members: ["en5"] });
  enrollment.discoverIosDevices = () => attached;
  const logicalId = discoveredDeviceId(UDID_A);
  await enrollment.tick();
  assert.equal(getUsbNetworkRecord(usbNetworkStorePath, logicalId).usbIface, "en5");

  attached = [];
  await enrollment.tick();
  assert.equal(getUsbNetworkRecord(usbNetworkStorePath, logicalId), null);
  assert.equal(enrollment.getStatus(logicalId).state, "disconnected");

  attached = [{ id: "x", udid: UDID_A, label: "Phone A" }];
  await enrollment.tick();
  assert.equal(getUsbNetworkRecord(usbNetworkStorePath, logicalId).usbIface, "en5");
});

test("IP discovery runs automatically after enrollment and records the resolved address", async () => {
  const { enrollment, usbNetworkStorePath } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }],
    members: ["en5"],
    ownIp: "192.168.2.1",
    captureOutput: [
      "12:00:00.000000 IP 192.168.2.10.54321 > 192.168.2.1.443: Flags [S], seq 1, length 0",
    ].join("\n"),
  });
  await enrollment.tick(); // enrolls
  await enrollment.tick(); // discovers IP

  const logicalId = discoveredDeviceId(UDID_A);
  assert.equal(getUsbNetworkRecord(usbNetworkStorePath, logicalId).usbIp, "192.168.2.10");
  assert.equal(enrollment.getStatus(logicalId).state, "ready");
});

test("IP discovery respects a cooldown — does not hammer tcpdump on every single tick", async () => {
  let captureCalls = 0;
  const { enrollment } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }],
    members: ["en5"],
  });
  enrollment.captureDeviceTraffic = async () => { captureCalls += 1; return ""; };
  // The first tick both enrolls the device AND makes the first IP-capture
  // attempt (enrollment and IP discovery share one tick() call), so the two
  // ticks after that must both land inside the cooldown window and skip.
  await enrollment.tick();
  await enrollment.tick();
  await enrollment.tick();
  assert.equal(captureCalls, 1);
});

test("no traffic captured leaves the device in discovering_ip with a helpful note, and keeps retrying (never gives up)", async () => {
  const { enrollment } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }],
    members: ["en5"],
    captureOutput: "reading from file -, link-type EN10MB\n", // no IP traffic
  });
  await enrollment.tick();
  await enrollment.tick();
  const status = enrollment.getStatus(discoveredDeviceId(UDID_A));
  assert.equal(status.state, "discovering_ip");
  assert.match(status.note, /no_traffic|no non-excluded/);
});

test("once a proxy is already assigned, resolving the IP automatically starts routing", async () => {
  const storePath = tempStorePath("proxy-pool.json");
  let injectedProxyPoolPath;
  const proxy = createProxy(storePath, sampleProxyPayload(), MASTER_KEY);
  const logicalId = discoveredDeviceId(UDID_A);
  assignProxyToDevice(storePath, { deviceId: logicalId, proxyId: proxy.id });

  const { enrollment, startRoutingCalls } = (() => {
    const usbNetworkStorePath = tempStorePath("usb-network.json");
    const statusChanges = [];
    const startRoutingCalls = [];
    const enrollment = new AutoNetworkEnrollment({
      bridgeIface: "bridge0",
      usbNetworkStorePath,
      proxyPoolStorePath: storePath,
      startRouting: async (deviceId, opts) => { startRoutingCalls.push({ deviceId, opts }); return { state: "routed" }; },
      discoverIosDevices: () => [{ id: "x", udid: UDID_A, label: "Phone A" }],
      listBridgeMembers: async () => ["en5"],
      discoverBridgeOwnIp: async () => "192.168.2.1",
      captureDeviceTraffic: async () => "12:00:00.000000 IP 192.168.2.10.1 > 192.168.2.1.443: Flags [S], length 0\n",
      pollIntervalMs: 20,
      onStatusChanged: (deviceId, status) => statusChanges.push({ deviceId, status }),
    });
    return { enrollment, startRoutingCalls };
  })();

  await enrollment.tick();
  await enrollment.tick();

  assert.equal(startRoutingCalls.length, 1);
  assert.equal(startRoutingCalls[0].deviceId, logicalId);
  assert.equal(startRoutingCalls[0].opts.usbIp, "192.168.2.10");
  assert.equal(enrollment.getStatus(logicalId).state, "routing");
});

test("without a proxy assigned yet, the device stops at ready and never calls startRouting", async () => {
  const { enrollment, startRoutingCalls } = makeEnrollment({
    attached: [{ id: "x", udid: UDID_A, label: "Phone A" }],
    members: ["en5"],
    captureOutput: "12:00:00.000000 IP 192.168.2.10.1 > 192.168.2.1.443: Flags [S], length 0\n",
    startRouting: async () => ({ state: "routed" }),
  });
  await enrollment.tick();
  await enrollment.tick();
  assert.equal(startRoutingCalls.length, 0);
  assert.equal(enrollment.getStatus(discoveredDeviceId(UDID_A)).state, "ready");
});

test("start()/stop() run an immediate tick, then on the interval, then nothing after stop", async () => {
  let ticks = 0;
  const { enrollment } = makeEnrollment({ attached: [], members: [] });
  enrollment.discoverIosDevices = () => { ticks += 1; return []; };
  enrollment.start();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(ticks, 1);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.ok(ticks >= 2);
  enrollment.stop();
  const ticksAtStop = ticks;
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(ticks, ticksAtStop);
});
