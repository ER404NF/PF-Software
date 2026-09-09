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
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");

const { server, wss } = await import("../../src/index.js");
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
    role: "va",
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

test("checkUrl is required", async () => {
  const res = await fetch(`${httpUrl}/api/devices/mock-1/network-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /checkUrl is required/);
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
  assert.ok("networkVerified" in mock1);
  assert.ok("networkMismatch" in mock1);

  const mock2 = deviceListMsg.devices.find((d) => d.id === "mock-2");
  assert.equal(mock2.network.egress, "vlan-proxy");
});
