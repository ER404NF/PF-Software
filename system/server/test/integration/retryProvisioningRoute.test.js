// "Retry setup": every way it can fail has its own plain message, machine code and HTTP status —
// no more single "not currently managed" answer for a port held by another program.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_PASSWORD = "test-password";

const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-retry-route-"));
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.PROXY_POOL_STORE_PATH = path.join(tmpStorageRoot, "proxy-pool.json");
process.env.DEVICE_CONFIG_PATH = path.resolve("server/fixtures/network-devices.config.json");
process.env.TWO_FACTOR_MASTER_KEY = "a".repeat(32);
process.env.NODE_ENV = "test";

const { server, wss, setDeviceProvisionerForTests } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");
const { LifecycleError, resultCodes, resultStatus } = await import("../../src/provisioningResults.js");
const { assertPlainOperatorText } = await import("../helpers/plainText.js");

let httpUrl;
let adminCookie;
let managerCookie;

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

const retry = () => fetch(`${httpUrl}/api/admin/devices/mock-1/retry-provisioning`, {
  method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie }, body: "{}",
});
const retryAs = cookie => fetch(`${httpUrl}/api/admin/devices/mock-1/retry-provisioning`, {
  method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}",
});

before(async () => {
  operators.set("retry-route-admin", { username: "retry-route-admin", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "admin" });
  operators.set("retry-route-manager", { username: "retry-route-manager", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "manager", teamId: "retry-team" });
  await new Promise(resolve => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await loginCookie("retry-route-admin");
  managerCookie = await loginCookie("retry-route-manager");
});

after(async () => {
  setDeviceProvisionerForTests(undefined);
  operators.delete("retry-route-admin");
  operators.delete("retry-route-manager");
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

test("with automatic provisioning off the answer says so", async () => {
  setDeviceProvisionerForTests(undefined);
  const res = await retry();
  assert.equal(res.status, 409);
  const message = (await res.json()).error;
  assert.equal(message, "Automatic phone setup is turned off on this Mac.");
  assertPlainOperatorText(message, "retry route, provisioning off");
});

test("a started retry answers ok with its code", async () => {
  setDeviceProvisionerForTests({ retryDevice: async () => ({ ok: true, code: "started" }) });
  const res = await retry();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, code: "started" });
});

test("the USB-tunnel route calls only the tunnel recovery operation", async () => {
  let fullRetries = 0;
  let tunnelRetries = 0;
  setDeviceProvisionerForTests({
    retryDevice: async () => { fullRetries += 1; return { ok: true, code: "started" }; },
    retryTunnelDevice: async (_deviceId, { authorize }) => {
      await authorize();
      tunnelRetries += 1;
      return { ok: true, code: "started" };
    },
  });
  const res = await fetch(`${httpUrl}/api/admin/devices/mock-1/retry-tunnel`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie }, body: "{}",
  });
  assert.equal(res.status, 200);
  assert.equal(tunnelRetries, 1);
  assert.equal(fullRetries, 0);
});

test("each failure keeps its own status, code and plain message", async () => {
  const details = { program: "proxy-tool", pid: 4121, port: 8101 };
  for (const code of resultCodes().filter(candidate => candidate !== "started")) {
    setDeviceProvisionerForTests({ retryDevice: async () => { throw new LifecycleError(code, details); } });
    const res = await retry();
    assert.equal(res.status, resultStatus(code), code);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, code);
    assertPlainOperatorText(body.error, code);
    assert.doesNotMatch(body.error, /not currently managed/);
  }
});

test("a port held by another program names the program, the process number and the port", async () => {
  setDeviceProvisionerForTests({ retryDevice: async () => { throw new LifecycleError("port_held_by_other_program", { program: "proxy-tool", pid: 4121, port: 8101 }); } });
  const body = await (await retry()).json();
  assert.match(body.error, /proxy-tool.*process 4121.*port 8101/);
});

test("an unexpected failure is still a server error", async () => {
  setDeviceProvisionerForTests({ retryDevice: async () => { throw new Error("boom"); } });
  assert.equal((await retry()).status, 500);
});

test("ordinary device-management capability cannot invoke WDA provisioning retry", async () => {
  let calls = 0;
  setDeviceProvisionerForTests({ retryDevice: async () => { calls += 1; return { ok: true, code: "started" }; } });
  const res = await retryAs(managerCookie);
  assert.equal(res.status, 403);
  assert.equal(calls, 0);
});

for (const [name, expectedStatus, revoke, restore] of [
  ["role", 403, () => { operators.get("retry-route-admin").role = "manager"; }, () => { operators.get("retry-route-admin").role = "admin"; }],
  ["device grant", 403, () => { operators.get("retry-route-admin").allowedDevices = []; }, () => { operators.get("retry-route-admin").allowedDevices = null; }],
  ["operator deletion", 401, () => { operators.delete("retry-route-admin"); }, () => {
    operators.set("retry-route-admin", { username: "retry-route-admin", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "admin" });
  }],
]) {
  test(`${name} revocation while retry is pending fails before success`, async () => {
    setDeviceProvisionerForTests({
      retryDevice: async (_deviceId, { authorize }) => {
        revoke();
        await authorize();
        return { ok: true, code: "started" };
      },
    });
    try {
      const res = await retry();
      assert.equal(res.status, expectedStatus);
    } finally {
      restore();
    }
  });
}

test("session revocation while retry is pending fails before success", async () => {
  setDeviceProvisionerForTests({
    retryDevice: async (_deviceId, { authorize }) => {
      await fetch(`${httpUrl}/api/logout`, { method: "POST", headers: { Cookie: adminCookie } });
      await authorize();
      return { ok: true, code: "started" };
    },
  });
  const res = await retry();
  assert.equal(res.status, 401);
  adminCookie = await loginCookie("retry-route-admin");
});
