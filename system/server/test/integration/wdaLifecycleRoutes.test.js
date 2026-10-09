// The WDA Start / Stop / Restart routes, against the real running server with real auth and role
// checks, driven by a fake provisioner (a real one needs a Mac with iPhones attached).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const TEST_PASSWORD = "test-password";

const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-wda-routes-"));
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.PROXY_POOL_STORE_PATH = path.join(tmpStorageRoot, "proxy-pool.json");
process.env.DEVICE_CONFIG_PATH = path.resolve("server/fixtures/network-devices.config.json");
process.env.TWO_FACTOR_MASTER_KEY = "a".repeat(32);
process.env.NODE_ENV = "test";

const { server, wss, setDeviceProvisionerForTests } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");
const { LifecycleError } = await import("../../src/provisioningResults.js");
const { assertPlainOperatorText } = await import("../helpers/plainText.js");

let httpUrl;
let hostCookie;
let vaCookie;

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

function post(route, cookie) {
  return fetch(`${httpUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" });
}

async function openOwner(cookie, deviceId = "mock-1") {
  const ws = new WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: cookie } });
  const messages = [];
  const waiters = [];
  ws.on("message", raw => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (!waiters[index].predicate(message)) continue;
      waiters[index].resolve(message);
      waiters.splice(index, 1);
    }
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const waitFor = (predicate, timeoutMs = 3000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket message timed out")), timeoutMs);
      waiters.push({ predicate, resolve: message => { clearTimeout(timer); resolve(message); } });
    });
  };
  const initialList = await waitFor(message => message.type === "device_list");
  ws.send(JSON.stringify({ type: "select_device", deviceId }));
  await waitFor(message => message.type === "frame" && message.deviceId === deviceId);
  return { ws, waitFor, phoneLabel: initialList.devices.find(device => device.id === deviceId)?.label };
}

before(async () => {
  operators.set("wda-route-host", { username: "wda-route-host", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "host" });
  operators.set("wda-route-va", { username: "wda-route-va", fullName: "Valerie Assistant", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: ["mock-1"], role: "va" });
  await new Promise(resolve => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  hostCookie = await loginCookie("wda-route-host");
  vaCookie = await loginCookie("wda-route-va");
});

after(async () => {
  setDeviceProvisionerForTests(undefined);
  operators.delete("wda-route-host");
  operators.delete("wda-route-va");
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

function fakeProvisioner(overrides = {}) {
  return {
    getLifecycleState: () => null,
    // The real provisioner re-authorizes the operator at the moment it commits; a fake must too,
    // or the route (rightly) refuses to call the action complete.
    startDevice: async (_id, { authorize }) => { await authorize(); return { enabled: true, state: "starting" }; },
    stopDevice: async (_id, { authorize }) => { await authorize(); return { enabled: false, state: "stopped" }; },
    restartDevice: async (_id, { authorize }) => { await authorize(); return { enabled: true, state: "starting" }; },
    performPrimaryAction: async (_id, { authorize }) => { await authorize(); return { enabled: false, state: "stopped", primaryAction: "start", primaryLabel: "Start WDA" }; },
    ...overrides,
  };
}

test("the lifecycle routes need a signed-in operator with the lifecycle capability", async () => {
  setDeviceProvisionerForTests(fakeProvisioner());
  const anonymous = await fetch(`${httpUrl}/api/admin/devices/mock-1/wda/restart`, { method: "POST" });
  assert.equal(anonymous.status, 401);
  assert.equal((await post("/api/admin/devices/mock-1/wda/restart", vaCookie)).status, 403);
});

test("a successful action answers ok with the new lifecycle state", async () => {
  setDeviceProvisionerForTests(fakeProvisioner());
  const res = await post("/api/admin/devices/mock-1/wda/restart", hostCookie);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, lifecycle: { enabled: true, state: "starting" } });
});

test("the primary route executes the server-selected action without a client action name", async () => {
  let calls = 0;
  setDeviceProvisionerForTests(fakeProvisioner({
    performPrimaryAction: async (_id, { authorize }) => { calls += 1; await authorize(); return { state: "stopped", primaryAction: "start" }; },
  }));
  const res = await post("/api/admin/devices/mock-1/wda/primary", hostCookie);
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.equal((await res.json()).lifecycle.primaryAction, "start");
});

test("a port held by another program is a 409 with a plain message and a machine code — not a 500", async () => {
  setDeviceProvisionerForTests(fakeProvisioner({
    restartDevice: async () => { throw new LifecycleError("port_held_by_other_program", { program: "proxy-tool", pid: 4121, port: 8101 }); },
  }));
  const res = await post("/api/admin/devices/mock-1/wda/restart", hostCookie);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "port_held_by_other_program");
  assert.match(body.error, /proxy-tool.*process 4121.*port 8101/);
  assertPlainOperatorText(body.error, "route error");
});

test("every typed failure keeps its own status", async () => {
  for (const [code, status] of [["old_process_would_not_stop", 409], ["port_held_by_unidentified_program", 409], ["shutting_down", 503]]) {
    setDeviceProvisionerForTests(fakeProvisioner({ startDevice: async () => { throw new LifecycleError(code, { port: 8101 }); } }));
    const res = await post("/api/admin/devices/mock-1/wda/start", hostCookie);
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).code, code);
  }
});

test("an unexpected failure is still a server error, not a made-up typed result", async () => {
  setDeviceProvisionerForTests(fakeProvisioner({ stopDevice: async () => { throw new Error("boom"); } }));
  const res = await post("/api/admin/devices/mock-1/wda/stop", hostCookie);
  assert.equal(res.status, 500);
});

// ---- what each viewer is told about the lifecycle (device_list) --------------------------------

async function deviceList(cookie) {
  const ws = new (await import("ws")).WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: cookie } });
  const message = await new Promise((resolve, reject) => {
    ws.on("message", raw => { const parsed = JSON.parse(raw.toString()); if (parsed.type === "device_list") resolve(parsed); });
    ws.on("error", reject);
  });
  ws.close();
  return message.devices;
}

test("device_list: a capability holder gets the live lifecycle, or an explicit 'not managed' for other phones", async () => {
  setDeviceProvisionerForTests(fakeProvisioner({
    getLifecycleState: id => (id === "mock-1" ? { managed: true, attached: true, enabled: true, state: "ready", canStart: false, canStop: true, canRestart: true } : null),
  }));
  const devices = await deviceList(hostCookie);
  assert.equal(devices.find(device => device.id === "mock-1").wdaLifecycle.state, "ready");
  const unmanaged = devices.find(device => device.id === "mock-2").wdaLifecycle;
  assert.equal(unmanaged.managed, false);
  assert.equal(unmanaged.canStart, false);
  assert.equal(unmanaged.startReason, "Bodun is not managing this phone's control service.");
});

test("device_list: with automatic provisioning switched off the lifecycle is null (the card explains that)", async () => {
  setDeviceProvisionerForTests(undefined);
  const devices = await deviceList(hostCookie);
  assert.equal(devices.find(device => device.id === "mock-1").wdaLifecycle, null);
});

test("device_list: a viewer without the lifecycle capability never sees it", async () => {
  setDeviceProvisionerForTests(fakeProvisioner({ getLifecycleState: () => ({ managed: true, state: "ready" }) }));
  const devices = await deviceList(vaCookie);
  for (const device of devices) assert.equal(device.wdaLifecycle, null);
});

test("device_list: Admin now receives the lifecycle too", async () => {
  operators.set("wda-route-admin", { username: "wda-route-admin", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "admin" });
  try {
    setDeviceProvisionerForTests(fakeProvisioner({ getLifecycleState: () => ({ managed: true, state: "ready", canStop: true }) }));
    const devices = await deviceList(await loginCookie("wda-route-admin"));
    assert.equal(devices.find(device => device.id === "mock-1").wdaLifecycle.state, "ready");
    const route = await post("/api/admin/devices/mock-1/wda/restart", await loginCookie("wda-route-admin"));
    assert.equal(route.status, 200, "…and may use the routes");
  } finally { operators.delete("wda-route-admin"); }
});

// ---- S15: typed answers for the cases that used to be bare 409/500 -----------------------------

test("with automatic provisioning off the answer carries a plain message and a code", async () => {
  setDeviceProvisionerForTests(undefined);
  const res = await post("/api/admin/devices/mock-1/wda/start", hostCookie);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "provisioning_off");
  assertPlainOperatorText(body.error, "route error");
});

test("a phone the provisioner does not know is device_not_managed", async () => {
  setDeviceProvisionerForTests(fakeProvisioner({ stopDevice: async (_id, { authorize }) => { await authorize(); return null; } }));
  const res = await post("/api/admin/devices/mock-1/wda/stop", hostCookie);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "device_not_managed");
});

test("a stop that could not be confirmed answers 409 wda_stop_unconfirmed", async () => {
  setDeviceProvisionerForTests(fakeProvisioner({ stopDevice: async () => { throw new LifecycleError("wda_stop_unconfirmed"); } }));
  const res = await post("/api/admin/devices/mock-1/wda/stop", hostCookie);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "wda_stop_unconfirmed");
  assert.match(body.error, /Restart Bodun/);
});

test("a stale in-use display status without a human owner does not block lifecycle actions", async () => {
  const { devices } = await import("../../src/index.js");
  const device = devices.get("mock-1");
  const before = device.status;
  device.status = "in-use";
  try {
    setDeviceProvisionerForTests(fakeProvisioner({
      getLifecycleState: (_id, { inUse }) => ({ attached: true, state: "ready", inUse }),
    }));
    const card = (await deviceList(hostCookie)).find(item => item.id === "mock-1");
    assert.equal(card.wdaLifecycle.inUse, false);
    const res = await post("/api/admin/devices/mock-1/wda/stop", hostCookie);
    assert.equal(res.status, 200);
  } finally { device.status = before; }
});

test("Stop and Restart name the human owner and prefer their full name", async () => {
  setDeviceProvisionerForTests(fakeProvisioner({
    getLifecycleState: (_id, { inUse }) => ({ attached: true, state: "ready", inUse }),
  }));
  const owner = await openOwner(vaCookie);
  try {
    const card = (await deviceList(hostCookie)).find(item => item.id === "mock-1");
    assert.equal(card.wdaLifecycle.inUse, true);
    for (const action of ["stop", "restart"]) {
      const refused = await post(`/api/admin/devices/mock-1/wda/${action}`, hostCookie);
      assert.equal(refused.status, 409);
      const body = await refused.json();
      assert.equal(body.code, "phone_in_use");
      assert.equal(body.error,
        `${owner.phoneLabel} is in use by Valerie Assistant. Ask them to release it before stopping or restarting its control service.`);
    }
  } finally {
    const released = owner.waitFor(message => message.type === "device_list"
      && message.devices.find(device => device.id === "mock-1")?.status === "idle");
    owner.ws.send(JSON.stringify({ type: "release_device", deviceId: "mock-1" }));
    await released;
    owner.ws.close();
  }
});

test("Restart of stopped control says to use Start WDA instead of reporting stale ownership", async () => {
  setDeviceProvisionerForTests(fakeProvisioner({
    getLifecycleState: () => ({ attached: true, enabled: false, state: "stopped", inUse: true }),
    restartDevice: async (_id, { authorize }) => {
      await authorize();
      throw new LifecycleError("wda_not_running");
    },
  }));
  const owner = await openOwner(vaCookie);
  try {
    const refused = await post("/api/admin/devices/mock-1/wda/restart", hostCookie);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      ok: false,
      code: "wda_not_running",
      error: "Phone control is stopped. Use Start WDA instead.",
    });
  } finally {
    const released = owner.waitFor(message => message.type === "device_list"
      && message.devices.find(device => device.id === "mock-1")?.status === "idle");
    owner.ws.send(JSON.stringify({ type: "release_device", deviceId: "mock-1" }));
    await released;
    owner.ws.close();
  }
});

test("in use + unplugged with no owner: Stop is allowed", async () => {
  const { devices } = await import("../../src/index.js");
  const device = devices.get("mock-1");
  const before = device.status;
  device.status = "in-use";
  try {
    setDeviceProvisionerForTests(fakeProvisioner({ getLifecycleState: () => ({ attached: false }) }));
    assert.equal((await post("/api/admin/devices/mock-1/wda/stop", hostCookie)).status, 200);
  } finally { device.status = before; }
});
