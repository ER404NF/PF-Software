// The one plain status of automatic phone setup, as the Fleet page receives it, and the Check again route behind the device
// provisioning capability. Driven by a fake provisioner (a real one needs a Mac with iPhones).

import { test as baseTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

// A regression that makes one of these steps wait for something that never happens must fail this test, not stall the run.
const test = (name, run) => baseTest(name, { timeout: 30_000 }, run);

const TEST_PASSWORD = "test-password";
const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-setup-routes-"));
const auditPath = path.join(tmpStorageRoot, "audit.log");
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = auditPath;
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.PROXY_POOL_STORE_PATH = path.join(tmpStorageRoot, "proxy-pool.json");
process.env.DEVICE_CONFIG_PATH = path.resolve("server/fixtures/network-devices.config.json");
process.env.TWO_FACTOR_MASTER_KEY = "a".repeat(32);
process.env.NODE_ENV = "test";

const { server, wss, setDeviceProvisionerForTests, broadcastDeviceList } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");
const { LifecycleError } = await import("../../src/provisioningResults.js");
const { buildSetupStatus } = await import("../../src/setupStatus.js");
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
  const cookie = res.headers.get("set-cookie").split(";")[0];
  await res.json(); // the session is saved before the last byte of the answer
  return cookie;
}

function post(route, cookie) {
  return fetch(`${httpUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" });
}

async function deviceListMessage(cookie) {
  const ws = new WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: cookie } });
  const message = await new Promise((resolve, reject) => {
    ws.on("message", raw => { const parsed = JSON.parse(raw.toString()); if (parsed.type === "device_list") resolve(parsed); });
    ws.on("error", reject);
  });
  ws.close();
  return message;
}

function auditEvents() {
  try {
    return fs.readFileSync(auditPath, "utf8").split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

before(async () => {
  operators.set("setup-host", { username: "setup-host", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "host" });
  operators.set("setup-va", { username: "setup-va", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: ["mock-1"], role: "va" });
  await new Promise(resolve => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  hostCookie = await loginCookie("setup-host");
  vaCookie = await loginCookie("setup-va");
});

after(async () => {
  setDeviceProvisionerForTests(undefined);
  operators.delete("setup-host");
  operators.delete("setup-va");
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

function fakeProvisioner(code, overrides = {}) {
  return {
    status: buildSetupStatus(code),
    getSetupStatus() { return { ...this.status }; },
    getLifecycleState: () => null,
    recheckNow: async function recheck() { return this.getSetupStatus(); },
    ...overrides,
  };
}

test("without automatic setup the page is told it is off, and nobody can ask for a check", async () => {
  setDeviceProvisionerForTests(undefined);
  const { automaticSetup } = await deviceListMessage(hostCookie);
  assert.deepEqual(automaticSetup, { state: "off", code: "setup_off", message: "Automatic phone setup is turned off on this Mac.", canCheckAgain: false });
});

test("a running setup is reported to everyone, with no Check again", async () => {
  setDeviceProvisionerForTests(fakeProvisioner("setup_running"));
  for (const cookie of [hostCookie, vaCookie]) {
    const { automaticSetup } = await deviceListMessage(cookie);
    assert.equal(automaticSetup.state, "running");
    assert.equal(automaticSetup.canCheckAgain, false);
  }
});

test("a paused setup is reported to everyone with its reason; only people with the provisioning capability may check again", async () => {
  for (const code of ["setup_paused_cannot_check", "setup_paused_earlier_session", "setup_paused_record_damaged"]) {
    setDeviceProvisionerForTests(fakeProvisioner(code));
    const host = (await deviceListMessage(hostCookie)).automaticSetup;
    const va = (await deviceListMessage(vaCookie)).automaticSetup;
    assert.equal(host.state, "paused", code);
    assert.equal(host.code, code);
    assert.equal(host.canCheckAgain, true, `${code}: the host may check again (a damaged record may have been repaired by hand)`);
    assert.equal(va.canCheckAgain, false, `${code}: a VA may not`);
    assert.equal(va.message, host.message, "everyone reads the same words");
    assertPlainOperatorText(host.message, code);
    assert.doesNotMatch(JSON.stringify(host), /[\\/]|process-ownership|\.json/);
  }
});

test("a change of status is broadcast to open pages", async () => {
  const provisioner = fakeProvisioner("setup_checking");
  setDeviceProvisionerForTests(provisioner);
  const ws = new WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: hostCookie } });
  const seen = [];
  ws.on("message", raw => { const message = JSON.parse(raw.toString()); if (message.type === "device_list") seen.push(message.automaticSetup.code); });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  await new Promise(resolve => setTimeout(resolve, 150));
  provisioner.status = buildSetupStatus("setup_running");
  broadcastDeviceList();
  await new Promise(resolve => setTimeout(resolve, 150));
  ws.close();
  assert.deepEqual([seen[0], seen.at(-1)], ["setup_checking", "setup_running"]);
});

// ---- the Check again route ---------------------------------------------------------------------------------

test("Check again needs a signed-in person with the provisioning capability", async () => {
  setDeviceProvisionerForTests(fakeProvisioner("setup_paused_cannot_check"));
  assert.equal((await fetch(`${httpUrl}/api/admin/automatic-setup/check`, { method: "POST" })).status, 401);
  assert.equal((await post("/api/admin/automatic-setup/check", vaCookie)).status, 403);
});

test("Check again answers with the new status and writes one audit entry that names the result", async () => {
  const provisioner = fakeProvisioner("setup_paused_cannot_check", {
    recheckNow: async function recheck() { this.status = buildSetupStatus("setup_running"); return this.getSetupStatus(); },
  });
  setDeviceProvisionerForTests(provisioner);
  const before = auditEvents().filter(event => event.type === "automatic_setup_check").length;
  const res = await post("/api/admin/automatic-setup/check", hostCookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status.code, "setup_running");
  assert.equal(body.status.state, "running");
  assertPlainOperatorText(body.status.message, "route status");
  const events = auditEvents().filter(event => event.type === "automatic_setup_check");
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).operator, "setup-host");
  assert.equal(events.at(-1).detail.code, "setup_running");
});

test("Check again that still finds the pause is a normal answer, not an error", async () => {
  setDeviceProvisionerForTests(fakeProvisioner("setup_paused_earlier_session"));
  const res = await post("/api/admin/automatic-setup/check", hostCookie);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status.code, "setup_paused_earlier_session");
});

test("pressing Check again twice at once reaches the provisioner twice and both get an answer (the provisioner shares the check)", async () => {
  let calls = 0;
  setDeviceProvisionerForTests(fakeProvisioner("setup_paused_cannot_check", {
    recheckNow: async function recheck() { calls += 1; await new Promise(resolve => setTimeout(resolve, 30)); return this.getSetupStatus(); },
  }));
  const [first, second] = await Promise.all([post("/api/admin/automatic-setup/check", hostCookie), post("/api/admin/automatic-setup/check", hostCookie)]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal(calls, 2);
});

test("Check again is refused with a plain message while Bodun is shutting down", async () => {
  setDeviceProvisionerForTests(fakeProvisioner("setup_paused_cannot_check", {
    recheckNow: async () => { throw new LifecycleError("shutting_down"); },
  }));
  const res = await post("/api/admin/automatic-setup/check", hostCookie);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "shutting_down");
  assertPlainOperatorText(body.error, "shutting down");
});

test("Check again without automatic setup says so plainly", async () => {
  setDeviceProvisionerForTests(undefined);
  const res = await post("/api/admin/automatic-setup/check", hostCookie);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "provisioning_off");
  assert.match(body.error, /turned off/);
});

test("an unexpected failure is a server error, not a made-up answer", async () => {
  setDeviceProvisionerForTests(fakeProvisioner("setup_paused_cannot_check", { recheckNow: async () => { throw new Error("odd"); } }));
  const res = await post("/api/admin/automatic-setup/check", hostCookie);
  assert.equal(res.status, 500);
});

// ---- phone cards while setup is paused -----------------------------------------------------------------------

test("a detected phone that setup has not adopted yet says setup is paused, never that it is turned off; manual phones keep their own wording", async () => {
  const { devices } = await import("../../src/index.js");
  const { DiscoveredIosDevice } = await import("../../src/deviceDiscovery.js");
  devices.set("ios-detected", new DiscoveredIosDevice({ id: "ios-detected", label: "Detected phone", udid: "UDID-DETECTED" }));
  try {
    for (const [code, expected] of [
      ["setup_paused_cannot_check", /paused/],
      ["setup_paused_record_damaged", /paused/],
      ["setup_checking", /checking its earlier phone connections/],
    ]) {
      setDeviceProvisionerForTests(fakeProvisioner(code));
      const list = (await deviceListMessage(hostCookie)).devices;
      const detected = list.find(device => device.id === "ios-detected").wdaLifecycle;
      assert.equal(detected.managed, false, code);
      assert.match(detected.startReason, expected, code);
      assert.doesNotMatch(detected.startReason, /turned off|not managing/i, code);
      assertPlainOperatorText(detected.startReason, code);
      const manual = list.find(device => device.id === "mock-1").wdaLifecycle;
      assert.match(manual.startReason, /not managing this phone/i, "a phone that is not part of automatic setup keeps its own wording");
    }
    setDeviceProvisionerForTests(fakeProvisioner("setup_running"));
    const running = (await deviceListMessage(hostCookie)).devices.find(device => device.id === "ios-detected").wdaLifecycle;
    assert.match(running.startReason, /not managing this phone/i, "once setup runs, the ordinary answer returns");
  } finally {
    devices.delete("ios-detected");
  }
});
