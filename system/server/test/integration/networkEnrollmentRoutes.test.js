// Network enrollment (binding a phone to its USB sharing connection): the pending lock, cancel, expiry,
// the "another phone is being set up" reason and the plain-language failures — against the real server
// and real auth, with a stand-in for the Mac's network tools.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_PASSWORD = "test-password";
const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-enrollment-"));
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.PROXY_POOL_STORE_PATH = path.join(tmpStorageRoot, "proxy-pool.json");
process.env.USB_NETWORK_STORE_PATH = path.join(tmpStorageRoot, "usb-network.json");
process.env.DEVICE_CONFIG_PATH = path.resolve("server/fixtures/network-devices.config.json");
process.env.TWO_FACTOR_MASTER_KEY = "a".repeat(32);
process.env.NODE_ENV = "test";

const { server, wss, setNetworkRoutingForTests } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");
const { getUsbNetworkRecord, setUsbIface } = await import("../../src/usbNetworkStore.js");
const { assertPlainOperatorText } = await import("../helpers/plainText.js");

let httpUrl;
let bridge = ["en5"];
let hostSession1;
let hostSession2;
let adminSession;

async function loginCookie(username) {
  const res = await fetch(`${httpUrl}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  await res.json();
  return setCookie.split(";")[0];
}

const call = (method, route, cookie) => fetch(`${httpUrl}${route}`, {
  method, headers: { "Content-Type": "application/json", Cookie: cookie }, ...(method === "POST" ? { body: "{}" } : {}),
});
const start = (device, cookie) => call("POST", `/api/admin/devices/${device}/network-enrollment/start`, cookie);
const confirm = (device, cookie) => call("POST", `/api/admin/devices/${device}/network-enrollment/confirm`, cookie);
const cancel = (device, cookie) => call("DELETE", `/api/admin/devices/${device}/network-enrollment`, cookie);

async function enrollmentStates(cookie) {
  const ws = new (await import("ws")).WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: cookie } });
  const message = await new Promise((resolve, reject) => {
    ws.on("message", raw => { const parsed = JSON.parse(raw.toString()); if (parsed.type === "device_list") resolve(parsed); });
    ws.on("error", reject);
  });
  ws.close();
  return Object.fromEntries(message.devices.map(device => [device.id, device.networkEnrollment]));
}

before(async () => {
  operators.set("enroll-host", { username: "enroll-host", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "host" });
  operators.set("enroll-admin", { username: "enroll-admin", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "admin" });
  await new Promise(resolve => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  hostSession1 = await loginCookie("enroll-host");
  hostSession2 = await loginCookie("enroll-host");
  adminSession = await loginCookie("enroll-admin");
  setNetworkRoutingForTests({ orchestrator: { bridgeIface: "bridge100", getRoute: () => null }, listBridgeMembers: async () => [...bridge] });
});

beforeEach(async () => {
  bridge = ["en5"];
  for (const device of ["mock-1", "mock-2"]) await cancel(device, hostSession1); // clean slate
});

after(async () => {
  setNetworkRoutingForTests({});
  operators.delete("enroll-host");
  operators.delete("enroll-admin");
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

test("starting an enrollment holds the lock: the starter sees it pending, other phones see why they are blocked", async () => {
  assert.equal((await start("mock-1", hostSession1)).status, 200);
  const mine = await enrollmentStates(hostSession1);
  assert.equal(mine["mock-1"].state, "pending");
  assert.ok(mine["mock-1"].expiresInMs > 290_000 && mine["mock-1"].expiresInMs <= 300_000);
  assert.equal(mine["mock-2"].state, "blocked_by_other");
  assert.equal(mine["mock-2"].otherDeviceId, "mock-1");
  assert.ok(mine["mock-2"].otherLabel);
  assert.ok(mine["mock-2"].remainingMs > 0);
});

test("the same operator in another window sees it as started elsewhere, not as their own", async () => {
  await start("mock-1", hostSession1);
  const other = await enrollmentStates(hostSession2);
  assert.equal(other["mock-1"].state, "owned_by_other_session");
  assert.ok(other["mock-1"].remainingMs > 0);
});

test("starting a second phone is refused with a plain reason that names the first and the minutes left", async () => {
  await start("mock-1", hostSession1);
  const res = await start("mock-2", hostSession1);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "ENROLLMENT_CONCURRENT");
  assert.match(body.error, /is being set up for networking\. Cancel that one or wait \d+ minutes?\./);
  assertPlainOperatorText(body.error, "concurrent message");
});

test("the enrollment slot is held while the first bridge snapshot is still pending", async () => {
  let releaseSnapshot;
  let snapshotStarted;
  const entered = new Promise(resolve => { snapshotStarted = resolve; });
  setNetworkRoutingForTests({
    orchestrator: { bridgeIface: "bridge100", getRoute: () => null },
    listBridgeMembers: () => new Promise(resolve => {
      releaseSnapshot = resolve;
      snapshotStarted();
    }),
  });
  try {
    const first = start("mock-1", hostSession1);
    await entered;
    const earlyConfirm = await confirm("mock-1", hostSession1);
    assert.equal(earlyConfirm.status, 409);
    assert.equal((await earlyConfirm.json()).code, "ENROLLMENT_STARTING");
    const second = await start("mock-2", hostSession1);
    assert.equal(second.status, 409);
    assert.equal((await second.json()).code, "ENROLLMENT_CONCURRENT");
    releaseSnapshot(["en5"]);
    assert.equal((await first).status, 200);
    const states = await enrollmentStates(hostSession1);
    assert.equal(states["mock-1"].state, "pending");
    assert.equal(states["mock-2"].state, "blocked_by_other");
  } finally {
    releaseSnapshot?.(["en5"]);
    setNetworkRoutingForTests({
      orchestrator: { bridgeIface: "bridge100", getRoute: () => null },
      listBridgeMembers: async () => [...bridge],
    });
  }
});

test("cancel releases the lock at once; cancelling again says there is nothing to cancel", async () => {
  await start("mock-1", hostSession1);
  assert.equal((await cancel("mock-1", hostSession1)).status, 200);
  const states = await enrollmentStates(hostSession1);
  assert.equal(states["mock-1"].state, "required");
  assert.equal(states["mock-2"].state, "required");
  assert.equal((await start("mock-2", hostSession1)).status, 200, "another phone can start straight away");
  const again = await cancel("mock-1", hostSession1);
  assert.equal(again.status, 409);
  const body = await again.json();
  assert.equal(body.code, "ENROLLMENT_NOTHING_TO_CANCEL");
  assertPlainOperatorText(body.error, "nothing to cancel");
});

test("another operator who may manage routing can cancel it, and it is audited", async () => {
  await start("mock-1", hostSession1);
  assert.equal((await cancel("mock-1", adminSession)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  const audit = fs.readFileSync(process.env.AUDIT_LOG_PATH, "utf8");
  assert.match(audit, /network_enrollment_cancelled/);
  assert.match(audit, /enroll-admin/);
});

test("cancel needs authentication and refuses an unknown phone", async () => {
  assert.equal((await fetch(`${httpUrl}/api/admin/devices/mock-1/network-enrollment`, { method: "DELETE" })).status, 401);
  assert.equal((await cancel("no-such-phone", hostSession1)).status, 404);
});

test("Confirm after a successful start binds the single new connection", async () => {
  await start("mock-1", hostSession1);
  bridge = ["en5", "en6"];
  const res = await confirm("mock-1", hostSession1);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).network.usbIface, "en6");
  const states = await enrollmentStates(hostSession1);
  assert.equal(states["mock-2"].state, "required", "the lock is released after a successful confirm");
  await call("DELETE", "/api/admin/devices/mock-1/network-enrollment", hostSession1);
});

test("every way Confirm fails has its own code and a plain message", async () => {
  const messages = [];
  const expect = async (response, code) => {
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, code);
    assertPlainOperatorText(body.error, code);
    messages.push(body.error);
  };
  await expect(await confirm("mock-1", hostSession1), "ENROLLMENT_MISSING");
  await start("mock-1", hostSession1);
  await expect(await confirm("mock-2", hostSession1), "ENROLLMENT_WRONG_DEVICE");
  await expect(await confirm("mock-1", hostSession2), "ENROLLMENT_WRONG_SESSION");
  await expect(await confirm("mock-1", adminSession), "ENROLLMENT_OWNER_MISMATCH");
  await expect(await confirm("mock-1", hostSession1), "ENROLLMENT_NO_CHANGE");
  bridge = ["en5", "en6", "en7"];
  await expect(await confirm("mock-1", hostSession1), "ENROLLMENT_MULTIPLE_CHANGES");
  assert.equal(new Set(messages).size, messages.length, "no two failures share a message");
});

test("an enrollment that waited too long is expired, Confirm says so, and the lock is free again", async () => {
  const realNow = Date.now;
  try {
    await start("mock-1", hostSession1);
    Date.now = () => realNow() + 6 * 60_000;
    const states = await enrollmentStates(hostSession1);
    assert.equal(states["mock-1"].state, "required");
    assert.equal(states["mock-2"].state, "required");
    // the expiry is remembered once so Confirm can explain it
    const res = await confirm("mock-1", hostSession1);
    const body = await res.json();
    assert.equal(body.code, "ENROLLMENT_STALE");
    assert.match(body.error, /waited too long/);
    assertPlainOperatorText(body.error, "stale");
  } finally { Date.now = realNow; }
});

test("when this Mac's network tools cannot be read, Start and Confirm say so plainly (409), not a generic server error", async () => {
  setNetworkRoutingForTests({
    orchestrator: { bridgeIface: "bridge100", getRoute: () => null },
    listBridgeMembers: async () => { throw Object.assign(new Error("ifconfig bridge100 failed: permission denied"), { code: "IFCONFIG_FAILED" }); },
  });
  try {
    const res = await start("mock-1", hostSession1);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ENROLLMENT_NETWORK_UNREADABLE");
    assertPlainOperatorText(body.error, "unreadable");
    assert.doesNotMatch(body.error, /permission denied|ifconfig/);
  } finally {
    setNetworkRoutingForTests({ orchestrator: { bridgeIface: "bridge100", getRoute: () => null }, listBridgeMembers: async () => [...bridge] });
  }
});

test("routing that starts during Confirm invalidates the snapshot before USB interface commit", async () => {
  await start("mock-1", hostSession1);
  bridge = ["en5", "en6"];
  const before = getUsbNetworkRecord(process.env.USB_NETWORK_STORE_PATH, "mock-1");
  let releaseBridge;
  let entered;
  const bridgeEntered = new Promise(resolve => { entered = resolve; });
  let route = null;
  const orchestrator = {
    bridgeIface: "bridge100",
    getRoute: () => route,
    startRouting: async (_deviceId, { usbIp, authorize }) => {
      await authorize();
      route = { state: "routed", usbIp, tunIface: "utun-test" };
      return route;
    },
    stopRouting: async () => { route = null; },
  };
  setNetworkRoutingForTests({
    orchestrator,
    listBridgeMembers: () => new Promise(resolve => { releaseBridge = resolve; entered(); }),
  });
  try {
    const confirming = confirm("mock-1", hostSession1);
    await bridgeEntered;
    const routed = await fetch(`${httpUrl}/api/admin/devices/mock-1/start-routing`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: hostSession1 },
      body: JSON.stringify({ usbIp: "192.168.2.10" }),
    });
    assert.equal(routed.status, 200);
    releaseBridge(["en5", "en6"]);
    const rejected = await confirming;
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "ENROLLMENT_STALE_OPERATION");
    assert.deepEqual(getUsbNetworkRecord(process.env.USB_NETWORK_STORE_PATH, "mock-1"), before);
  } finally {
    releaseBridge?.(["en5", "en6"]);
    setNetworkRoutingForTests({ orchestrator: { bridgeIface: "bridge100", getRoute: () => null }, listBridgeMembers: async () => [...bridge] });
  }
});

test("newer IP discovery and route start both prevent stale IP commits", async () => {
  setUsbIface(process.env.USB_NETWORK_STORE_PATH, "mock-1", "en6");
  let releaseFirstCapture;
  let captureEnteredResolve;
  let captureEntered = new Promise(resolve => { captureEnteredResolve = resolve; });
  let captureCall = 0;
  let route = null;
  const orchestrator = {
    bridgeIface: "bridge100", getRoute: () => route,
    startRouting: async (_deviceId, { usbIp, authorize }) => { await authorize(); route = { state: "routed", usbIp, tunIface: "utun-test" }; return route; },
    stopRouting: async () => { route = null; },
  };
  setNetworkRoutingForTests({
    orchestrator,
    listBridgeMembers: async () => [...bridge],
    discoverBridgeOwnIp: async () => "192.168.2.1",
    captureDeviceTraffic: async () => {
      captureCall += 1;
      if (captureCall === 1) {
        captureEnteredResolve();
        return new Promise(resolve => { releaseFirstCapture = resolve; });
      }
      return "12:00:00 IP 192.168.2.11.123 > 192.168.2.1.443: Flags [S]\n";
    },
  });
  const discover = () => call("POST", "/api/admin/devices/mock-1/discover-ip", hostSession1);
  try {
    const stale = discover();
    await captureEntered;
    const newer = await discover();
    assert.equal(newer.status, 200);
    assert.equal((await newer.json()).network.usbIp, "192.168.2.11");
    releaseFirstCapture("12:00:00 IP 192.168.2.10.123 > 192.168.2.1.443: Flags [S]\n");
    const staleResult = await stale;
    assert.equal(staleResult.status, 409);
    assert.equal((await staleResult.json()).code, "ENROLLMENT_STALE_OPERATION");
    assert.equal(getUsbNetworkRecord(process.env.USB_NETWORK_STORE_PATH, "mock-1").usbIp, "192.168.2.11");

    setUsbIface(process.env.USB_NETWORK_STORE_PATH, "mock-1", "en6");
    captureCall = 0;
    captureEntered = new Promise(resolve => { captureEnteredResolve = resolve; });
    const duringRoute = discover();
    await captureEntered;
    const routed = await fetch(`${httpUrl}/api/admin/devices/mock-1/start-routing`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: hostSession1 },
      body: JSON.stringify({ usbIp: "192.168.2.12" }),
    });
    assert.equal(routed.status, 200);
    releaseFirstCapture("12:00:00 IP 192.168.2.13.123 > 192.168.2.1.443: Flags [S]\n");
    const rejected = await duringRoute;
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "ENROLLMENT_STALE_OPERATION");
    assert.equal(getUsbNetworkRecord(process.env.USB_NETWORK_STORE_PATH, "mock-1").usbIp, null);
  } finally {
    releaseFirstCapture?.("");
    setNetworkRoutingForTests({ orchestrator: { bridgeIface: "bridge100", getRoute: () => null }, listBridgeMembers: async () => [...bridge] });
  }
});
