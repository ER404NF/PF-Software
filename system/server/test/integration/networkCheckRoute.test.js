// Integration coverage for the Phase 0 network-isolation HTTP route against
// the real running server, real auth/RBAC, and the real devices.config.json
// (mock-1: cellular-sim, mock-2: vlan-proxy) — networkVerifier.js's own
// collision/verification logic is covered exhaustively in
// server/test/integration/networkVerifier.test.js against an isolated
// deviceNetwork map; this file is about the wiring: HTTP route -> RBAC ->
// networkVerifier -> summary()/device_list -> audit trail.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../../fixtures/fake-network-check-server.js");

const TEST_PASSWORD = "test-password";

const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-networkcheck-"));
const isolatedDeviceConfigPath = path.join(tmpStorageRoot, "devices.config.json");
fs.copyFileSync(path.join(__dirname, "../../../devices.config.json"), isolatedDeviceConfigPath);
const isolatedDeviceConfig = JSON.parse(fs.readFileSync(isolatedDeviceConfigPath, "utf8"));
isolatedDeviceConfig.devices.find(device => device.id === "mock-1").network.failPolicy = "fail-closed";
fs.writeFileSync(isolatedDeviceConfigPath, `${JSON.stringify(isolatedDeviceConfig, null, 2)}\n`);
process.env.DEVICE_CONFIG_PATH = isolatedDeviceConfigPath;
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.ALLOW_NETWORK_CHECK_URL_OVERRIDE = "true";

const { server, wss, deviceLease, taskQueue } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");

let httpUrl;
let fakeCheckChild;
let CHECK_URL;

function spawnFakeCheckServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fixturePath, "0"], { stdio: "pipe" });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/\[fake-network-check\] listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        proc.stdout.off("data", onData);
        resolve({ proc, baseUrl: `http://127.0.0.1:${match[1]}` });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("error", reject);
  });
}

async function loginCookie(username, password) {
  const res = await fetch(`${httpUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  await res.json();
  return setCookie.split(";")[0];
}

async function fleetSnapshot(sessionCookie) {
  const ws = new (await import("ws")).WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: sessionCookie } });
  const message = await new Promise((resolve, reject) => {
    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === "device_list") resolve(parsed);
    });
    ws.on("error", reject);
  });
  ws.close();
  return message.devices;
}

let cookie;
let restrictedCookie;

before(async () => {
  operators.set("netcheck-test-va", {
    username: "netcheck-test-va",
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: null,
    role: "admin",
  });
  operators.set("netcheck-test-restricted", {
    username: "netcheck-test-restricted",
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: ["mock-2"], // deliberately NOT mock-1
    role: "manager",
  });

  await new Promise((resolve) => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  cookie = await loginCookie("netcheck-test-va", TEST_PASSWORD);
  restrictedCookie = await loginCookie("netcheck-test-restricted", TEST_PASSWORD);

  const { proc, baseUrl } = await spawnFakeCheckServer();
  fakeCheckChild = proc;
  CHECK_URL = `${baseUrl}/ip`;
});

after(async () => {
  operators.delete("netcheck-test-va");
  operators.delete("netcheck-test-restricted");
  fakeCheckChild.kill();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

test("commands require authentication like every other device route", async () => {
  const res = await fetch(`${httpUrl}/api/devices/mock-1/network-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkUrl: CHECK_URL }),
  });
  assert.equal(res.status, 401);
});

test("a verification endpoint is required", async () => {
  const res = await fetch(`${httpUrl}/api/devices/mock-1/network-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /endpoint is not configured/);
});

test("an unknown device is rejected", async () => {
  const res = await fetch(`${httpUrl}/api/devices/does-not-exist/network-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ checkUrl: CHECK_URL }),
  });
  assert.equal(res.status, 404);
});

test("device RBAC applies the same as every other device route", async () => {
  const res = await fetch(`${httpUrl}/api/devices/mock-1/network-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: restrictedCookie },
    body: JSON.stringify({ checkUrl: CHECK_URL }),
  });
  assert.equal(res.status, 403);

  // Same operator, on the device they ARE allowed — proves the 403 above is
  // genuinely RBAC, not a blanket rejection.
  const allowed = await fetch(`${httpUrl}/api/devices/mock-2/network-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: restrictedCookie },
    body: JSON.stringify({ checkUrl: CHECK_URL }),
  });
  assert.equal(allowed.status, 200);
});

test("revocation during a delayed network check returns no observed network data", async () => {
  await fetch(`${CHECK_URL.replace("/ip", "/debug/set-ip")}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip: "198.51.100.93" }),
  });
  await fetch(`${CHECK_URL.replace("/ip", "/debug/delay")}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ms: 100 }),
  });

  const pending = fetch(`${httpUrl}/api/devices/mock-2/network-check`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: restrictedCookie },
    body: JSON.stringify({ checkUrl: CHECK_URL }),
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  const operator = operators.get("netcheck-test-restricted");
  const previousGrant = operator.allowedDevices;
  operator.allowedDevices = [];
  try {
    const response = await pending;
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.deepEqual(body, { error: "not authorized for this device" });
    assert.equal(JSON.stringify(body).includes("198.51.100.93"), false);
    assert.equal(JSON.stringify(body).includes("test-region"), false);
  } finally {
    operator.allowedDevices = previousGrant;
    await fetch(`${CHECK_URL.replace("/ip", "/debug/delay")}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ms: 0 }),
    });
  }
});

test("a successful check updates the device summary and is audited with the assigned network egress", async () => {
  await fetch(`${CHECK_URL.replace("/ip", "/debug/set-ip")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ip: "198.51.100.77" }),
  });

  const res = await fetch(`${httpUrl}/api/devices/mock-1/network-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ checkUrl: CHECK_URL }),
  });
  assert.equal(res.status, 200);
  const { network } = await res.json();
  assert.equal(network.egress, "cellular-sim"); // mock-1's real devices.config.json assignment
  assert.equal(network.simIdentifierSuffix, "0001");
  assert.equal("simIccid" in network, false);
  assert.equal(network.networkObservedIp, "198.51.100.77");
  assert.equal(network.networkVerified, true);

  const meta = await fetch(`${httpUrl}/api/audit?deviceId=mock-1&limit=5`, { headers: { Cookie: cookie } }).then((r) =>
    r.json()
  );
  const checkEvent = meta.events.find((e) => e.type === "network_check");
  assert.ok(checkEvent, "expected a network_check audit event");
  assert.equal(checkEvent.detail.networkEgress, "cellular-sim");
  assert.equal(checkEvent.detail.observedIp, "198.51.100.77");
});

test("device_list over WebSocket carries the same network fields as the HTTP route", async () => {
  const ws = new (await import("ws")).WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: cookie } });
  const deviceListMsg = await new Promise((resolve, reject) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "device_list") resolve(msg);
    });
    ws.on("error", reject);
  });
  ws.close();

  const mock1 = deviceListMsg.devices.find((d) => d.id === "mock-1");
  assert.equal(mock1.network.egress, "cellular-sim");
  assert.equal("simIccid" in mock1.network, false);
  assert.ok("networkVerified" in mock1);
  assert.ok("networkMismatch" in mock1);

  const mock2 = deviceListMsg.devices.find((d) => d.id === "mock-2");
  assert.equal(mock2.network.egress, "vlan-proxy");
});

test("only a proxy manager can persist and broadcast the safe proxy assignment switch", async () => {
  const denied = await fetch(`${httpUrl}/api/admin/devices/mock-2/proxy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: restrictedCookie },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(denied.status, 403);

  const notProxy = await fetch(`${httpUrl}/api/admin/devices/mock-1/proxy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(notProxy.status, 409);

  const disabled = await fetch(`${httpUrl}/api/admin/devices/mock-2/proxy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).network.enabled, false);
  const saved = JSON.parse(fs.readFileSync(isolatedDeviceConfigPath, "utf8"));
  assert.equal(saved.devices.find(device => device.id === "mock-2").network.enabled, false);

  const blockedCheck = await fetch(`${httpUrl}/api/devices/mock-2/network-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ checkUrl: CHECK_URL }),
  });
  assert.equal(blockedCheck.status, 409);
  assert.match((await blockedCheck.json()).error, /proxy assignment is disabled/);

  const restored = await fetch(`${httpUrl}/api/admin/devices/mock-2/proxy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).network.enabled, true);

  const audit = await fetch(`${httpUrl}/api/audit?deviceId=mock-2&limit=10`, { headers: { Cookie: cookie } }).then(response => response.json());
  assert.ok(audit.events.some(event => event.type === "proxy_setting_changed" && event.detail.enabled === false));
  assert.ok(audit.events.every(event => !JSON.stringify(event).includes("vlan-bench-1")));
});

test("fail-closed mismatch blocks Human selection and AI dispatch until a fresh passing check", async () => {
  await fetch(`${CHECK_URL.replace("/ip", "/debug/set-ip")}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip: "198.51.100.91" }),
  });
  for (const deviceId of ["mock-2", "mock-1"]) {
    const response = await fetch(`${httpUrl}/api/devices/${deviceId}/network-check`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ checkUrl: CHECK_URL }),
    });
    assert.equal(response.status, 200);
  }

  const blocked = (await fleetSnapshot(cookie)).find(device => device.id === "mock-1");
  assert.equal(blocked.networkMismatch, true);
  assert.equal(blocked.canOpen, false);
  assert.equal(blocked.accessState, "network_mismatch");

  const task = taskQueue.addTask({ goal: "must wait for safe network", createdBy: "netcheck-test-va",
    deviceSelector: { deviceId: "mock-1" } });
  assert.equal(task.state, "QUEUED");
  assert.equal(deviceLease.getMode("mock-1"), "HUMAN");

  await fetch(`${CHECK_URL.replace("/ip", "/debug/set-ip")}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip: "198.51.100.92" }),
  });
  const restored = await fetch(`${httpUrl}/api/devices/mock-1/network-check`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ checkUrl: CHECK_URL }),
  });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).network.networkVerified, true);
  assert.equal(taskQueue.getTask(task.id).state, "RUNNING");

  taskQueue.emergencyStopDevice("mock-1");
});
