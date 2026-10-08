// The broken-phone demo against the real running server: the Fleet page receives both phones in their states over
// the live connection, the lifecycle buttons answer on them, and the enrollment is pending on phone B.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_PASSWORD = "test-password";
const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-demo-phones-it-"));
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.PROXY_POOL_STORE_PATH = path.join(tmpStorageRoot, "proxy-pool.json");
process.env.DEVICE_CONFIG_PATH = path.resolve("server/fixtures/network-devices.config.json");
process.env.TWO_FACTOR_MASTER_KEY = "a".repeat(32);
process.env.NODE_ENV = "test";

const { server, wss, devices, broadcastDeviceList, setDeviceProvisionerForTests, setNetworkRoutingForTests } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");
const { installBrokenPhones, startEnrollmentOnB } = await import("../../scripts/demoBrokenPhones.js");
const { assertPlainOperatorText } = await import("../helpers/plainText.js");

let httpUrl;
let demo;
let cookie;

async function deviceList() {
  const ws = new (await import("ws")).WebSocket(httpUrl.replace("http", "ws"), { headers: { Cookie: cookie } });
  const message = await new Promise((resolve, reject) => {
    ws.on("message", raw => { const parsed = JSON.parse(raw.toString()); if (parsed.type === "device_list") resolve(parsed); });
    ws.on("error", reject);
  });
  ws.close();
  return message.devices;
}

before(async () => {
  operators.set("demo-it-admin", { username: "demo-it-admin", passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: null, role: "admin" });
  await new Promise(resolve => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  demo = await installBrokenPhones({ devices, onDeviceListChanged: broadcastDeviceList, storeDir: path.join(tmpStorageRoot, "phones") });
  setDeviceProvisionerForTests(demo.provisioner);
  setNetworkRoutingForTests({ orchestrator: { bridgeIface: "bridge100", getRoute: () => null }, setupState: { state: "enabled", message: "Proxy routing is enabled." }, listBridgeMembers: async () => ["en5"] });
  const login = await fetch(`${httpUrl}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "demo-it-admin", password: TEST_PASSWORD }) });
  await login.text(); // the session is saved before the last byte of the answer; use the cookie only after that
  cookie = login.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  await demo.provisioner.stop();
  setDeviceProvisionerForTests(undefined);
  setNetworkRoutingForTests({});
  operators.delete("demo-it-admin");
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

test("the Fleet page receives both phones over the live connection, in the recorded states, with plain messages", async () => {
  const list = await deviceList();
  const a = list.find(device => device.id === demo.ids.a);
  const b = list.find(device => device.id === demo.ids.b);
  assert.ok(a && b, "both demo phones are in the fleet");
  assert.equal(a.componentHealth.recovery, "BLOCKED_PORT");
  assert.equal(a.accessState, "wda_provisioning_error");
  assert.match(a.discoveryStateMessage, /proxy-tool/);
  assertPlainOperatorText(a.discoveryStateMessage, "phone A message");
  assert.equal(b.componentHealth.recovery, "OPERATOR_STOPPED");
  assert.equal(b.accessState, "wda_stopped");
});

test("the lifecycle information answers for the demo phones, with a reason wherever a button is off", async () => {
  const list = await deviceList();
  const b = list.find(device => device.id === demo.ids.b);
  assert.equal(b.wdaLifecycle.managed, true);
  assert.equal(b.wdaLifecycle.canStart, true, "Start is allowed on the stopped phone");
  assert.equal(b.wdaLifecycle.canStop, false);
  assert.equal(typeof b.wdaLifecycle.stopReason, "string", "a disabled Stop says why");
  assertPlainOperatorText(b.wdaLifecycle.stopReason, "phone B stop reason");
  const a = list.find(device => device.id === demo.ids.a);
  assert.equal(a.wdaLifecycle.canStop, true, "Stop works on a blocked phone, so it can always be cleaned up");
});

test("a network enrollment started on phone B through the real route shows as pending, and as 'in another window' to a different session", async () => {
  const result = await startEnrollmentOnB({ baseUrl: httpUrl, username: "demo-it-admin", password: TEST_PASSWORD, deviceId: demo.ids.b });
  assert.equal(result.enrollment.state, "pending");
  const list = await deviceList(); // a second, separate session
  const b = list.find(device => device.id === demo.ids.b);
  assert.equal(b.networkEnrollment.state, "owned_by_other_session");
  assert.equal(b.routingFeature.state, "enabled", "the card shows the routing panel with the enrollment steps, not \"routing disabled\"");
});
