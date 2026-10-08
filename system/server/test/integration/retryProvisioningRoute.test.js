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

before(async () => {
  operators.set("retry-route-admin", { username: "retry-route-admin", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "admin" });
  await new Promise(resolve => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await loginCookie("retry-route-admin");
});

after(async () => {
  setDeviceProvisionerForTests(undefined);
  operators.delete("retry-route-admin");
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
