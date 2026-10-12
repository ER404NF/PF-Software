// Integration coverage for the Phase B part 2 start/stop-routing HTTP
// wiring, against the real running server and real auth/RBAC. This
// deliberately does NOT enable AUTO_ROUTE_PROXY_TUNNELS (it needs a real
// macOS bridge, pfctl, and tun2proxy — none of which exist in CI), so it
// covers exactly what's reachable without hardware: authentication, the
// admin-only capability gate, and the safe "turned off on this Mac"
// fallback — proving a disabled relay never allows a routing action to
// silently no-op as success. networkRoutingOrchestrator.test.js covers the
// actual state machine exhaustively against fakes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_PASSWORD = "test-password";

const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-routing-"));
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.PROXY_POOL_STORE_PATH = path.join(tmpStorageRoot, "proxy-pool.json");
process.env.DEVICE_CONFIG_PATH = path.resolve("server/fixtures/network-devices.config.json");
process.env.TWO_FACTOR_MASTER_KEY = "a".repeat(32);
process.env.NODE_ENV = "test";
// Explicitly NOT set: AUTO_ROUTE_PROXY_TUNNELS, SHARED_BRIDGE_IFACE.

const { server, wss, networkRoutingOrchestrator, autoNetworkEnrollment } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");
const { assertPlainOperatorText } = await import("../helpers/plainText.js");

let httpUrl;

async function loginCookie(username, password) {
  const res = await fetch(`${httpUrl}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  await res.json();
  return setCookie.split(";")[0];
}

let adminCookie;
let managerCookie;

before(async () => {
  operators.set("routing-test-admin", {
    username: "routing-test-admin", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "admin",
  });
  operators.set("routing-test-manager", {
    username: "routing-test-manager", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: ["mock-1"], role: "manager",
  });
  await new Promise((resolve) => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await loginCookie("routing-test-admin", TEST_PASSWORD);
  managerCookie = await loginCookie("routing-test-manager", TEST_PASSWORD);
});

after(async () => {
  operators.delete("routing-test-admin");
  operators.delete("routing-test-manager");
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

test("networkRoutingOrchestrator is not constructed without AUTO_ROUTE_PROXY_TUNNELS", () => {
  assert.equal(networkRoutingOrchestrator, undefined);
});

test("stop-routing refreshes authorization immediately before beginning fail-closed teardown", () => {
  const source = fs.readFileSync(new URL("../../src/index.js", import.meta.url), "utf8");
  assert.match(source,
    /const currentAtStart = await authorizeRoutingMutation\(req, req\.params\.deviceId\);\s*advanceNetworkIdentityGeneration\(req\.params\.deviceId\);\s*\/\/ Once teardown[\s\S]*?await networkRoutingOrchestrator\.stopRouting/);
});

test("network observation and generation changes begin only after fresh authorization", () => {
  const source = fs.readFileSync(new URL("../../src/index.js", import.meta.url), "utf8");
  assert.match(source,
    /currentAtStart = await authorizeRoutingMutation[\s\S]*?const reservation = networkEnrollmentLock\.tryStart/);
  assert.match(source,
    /ENROLLMENT_STARTING[\s\S]*?await authorizeRoutingMutation\(req, req\.params\.deviceId\);\s*networkRoutingOrchestrator\.assertRoutingAvailable\?\.\(\);\s*const after = await enrollmentTools\.listBridgeMembers/);
  assert.match(source,
    /complete network enrollment[\s\S]*?await authorizeRoutingMutation\(req, req\.params\.deviceId\);\s*networkRoutingOrchestrator\.assertRoutingAvailable\?\.\(\);\s*const generation = advanceNetworkIdentityGeneration[\s\S]*?discoverBridgeOwnIp/);
  assert.match(source,
    /usbIp is required[\s\S]*?await authorizeRoutingMutation\(req, req\.params\.deviceId\);\s*advanceNetworkIdentityGeneration[\s\S]*?networkRoutingOrchestrator\.startRouting/);
});

test("autoNetworkEnrollment is not constructed without AUTO_NETWORK_ENROLLMENT (nested under AUTO_ROUTE_PROXY_TUNNELS, itself unset here)", () => {
  assert.equal(autoNetworkEnrollment, undefined);
});

test("start-routing and stop-routing both require authentication", async () => {
  const start = await fetch(`${httpUrl}/api/admin/devices/mock-1/start-routing`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usbIp: "192.168.2.10" }),
  });
  assert.equal(start.status, 401);
  const stop = await fetch(`${httpUrl}/api/admin/devices/mock-1/stop-routing`, { method: "POST" });
  assert.equal(stop.status, 401);
  const recover = await fetch(`${httpUrl}/api/admin/routing/recover`, { method: "POST" });
  assert.equal(recover.status, 401);
  const repair = await fetch(`${httpUrl}/api/admin/routing/repair`, { method: "POST" });
  assert.equal(repair.status, 401);
});

test("Manager (proxy:assign, but not routing:manage) is refused — routing stays Admin-only", async () => {
  const res = await fetch(`${httpUrl}/api/admin/devices/mock-1/start-routing`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ usbIp: "192.168.2.10" }),
  });
  assert.equal(res.status, 403);
  const recover = await fetch(`${httpUrl}/api/admin/routing/recover`, {
    method: "POST", headers: { Cookie: managerCookie },
  });
  assert.equal(recover.status, 403);
  const repair = await fetch(`${httpUrl}/api/admin/routing/repair`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(repair.status, 403);
});

test("an authorized Admin gets a clear 409 rather than a silent no-op when routing is disabled", async () => {
  const start = await fetch(`${httpUrl}/api/admin/devices/mock-1/start-routing`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ usbIp: "192.168.2.10" }),
  });
  assert.equal(start.status, 409);
  assert.match((await start.json()).error, /Automatic network setup is turned off on this Mac\./);

  const stop = await fetch(`${httpUrl}/api/admin/devices/mock-1/stop-routing`, {
    method: "POST", headers: { Cookie: adminCookie },
  });
  assert.equal(stop.status, 409);
  const stopMessage = (await stop.json()).error;
  assert.match(stopMessage, /Automatic network setup is turned off on this Mac\./);
  assertPlainOperatorText(stopMessage, "stop routing while routing is off");
  const repair = await fetch(`${httpUrl}/api/admin/routing/repair`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(repair.status, 409);
  assert.match((await repair.json()).error, /Automatic network setup is turned off on this Mac\./);
});

test("device_list never exposes a routing field to a viewer without routing:manage", async () => {
  const ws = new (await import("ws")).WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: managerCookie } });
  const deviceListMsg = await new Promise((resolve, reject) => {
    ws.on("message", (raw) => { const msg = JSON.parse(raw.toString()); if (msg.type === "device_list") resolve(msg); });
    ws.on("error", reject);
  });
  ws.close();
  const mock1 = deviceListMsg.devices.find((d) => d.id === "mock-1");
  assert.equal(mock1.routing, null);
  assert.equal(mock1.usbNetwork, null);
  assert.equal(mock1.autoEnrollment, null);
  assert.equal(mock1.routingFeature, null);
});

test("Admin device summaries distinguish a disabled routing feature from an unenrolled phone", async () => {
  const ws = new (await import("ws")).WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: adminCookie } });
  const deviceListMsg = await new Promise((resolve, reject) => {
    ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type === "device_list") resolve(msg); });
    ws.on("error", reject);
  });
  ws.close();
  const mock1 = deviceListMsg.devices.find(device => device.id === "mock-1");
  assert.deepEqual(mock1.routingFeature, {
    state: "disabled",
    message: "Proxy routing is disabled on this host.",
    hostRouting: null,
  });
  assert.equal(mock1.routing, null);
});

test("network-enrollment and discover-ip routes require authentication", async () => {
  for (const [method, path] of [
    ["POST", "/api/admin/devices/mock-1/network-enrollment/start"],
    ["POST", "/api/admin/devices/mock-1/network-enrollment/confirm"],
    ["POST", "/api/admin/devices/mock-1/discover-ip"],
  ]) {
    const res = await fetch(`${httpUrl}${path}`, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("network-enrollment and discover-ip stay Admin-only, same as start/stop-routing", async () => {
  for (const path of [
    "/api/admin/devices/mock-1/network-enrollment/start",
    "/api/admin/devices/mock-1/network-enrollment/confirm",
    "/api/admin/devices/mock-1/discover-ip",
  ]) {
    const res = await fetch(`${httpUrl}${path}`, { method: "POST", headers: { Cookie: managerCookie } });
    assert.equal(res.status, 403, path);
  }
});

test("network-enrollment and discover-ip all return the same clear 409 while routing is disabled", async () => {
  for (const path of [
    "/api/admin/devices/mock-1/network-enrollment/start",
    "/api/admin/devices/mock-1/network-enrollment/confirm",
    "/api/admin/devices/mock-1/discover-ip",
  ]) {
    const res = await fetch(`${httpUrl}${path}`, { method: "POST", headers: { Cookie: adminCookie } });
    assert.equal(res.status, 409, path);
    assert.match((await res.json()).error, /Automatic network setup is turned off on this Mac\./);
  }
});
