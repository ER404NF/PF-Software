import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import { assertPlainOperatorText } from "../helpers/plainText.js";
import { STORE_UNAVAILABLE } from "../../src/processOwnershipStore.js";
import {
  DEMO_CONTROL_PORT_RANGE, DEMO_VIDEO_PORT_RANGE, assertDemoEnvironment, brokenPhonesEnvironment, brokenPhonesRequested, pausedSetupRequested,
} from "../../scripts/demoOptions.js";
import { FOREIGN_PROGRAM, installBrokenPhones } from "../../scripts/demoBrokenPhones.js";
import { resolveMjpegPortRange, resolvePortRange } from "../../src/portAllocator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "../..");

test("the two demo phones reach the recording's states through the real provisioner, with no real socket or process", async () => {
  const devices = new Map();
  const changes = [];
  // Any attempt to open a real connection would fail this test.
  const connect = mock.method(net.Socket.prototype, "connect", () => { throw new Error("the demo must not open a socket"); });
  let demo;
  try {
    demo = await installBrokenPhones({ devices, onDeviceListChanged: () => changes.push(true), storeDir: fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-demo-phones-test-")) });
  } finally {
    connect.mock.restore();
  }
  try {
    assert.equal(connect.mock.callCount(), 0);
    const a = devices.get(demo.ids.a);
    const b = devices.get(demo.ids.b);
    assert.equal(a.componentHealth.recovery, "BLOCKED_PORT");
    assert.equal(a.componentErrors.iproxy.code, "I205");
    assert.match(a.discoveryStateMessage, new RegExp(FOREIGN_PROGRAM.program));
    assert.match(a.discoveryStateMessage, new RegExp(`process ${FOREIGN_PROGRAM.pid}`));
    assertPlainOperatorText(a.discoveryStateMessage, "phone A banner");
    assert.doesNotMatch(JSON.stringify(a.componentErrors.iproxy), /--listen/, "never the other program's command line");
    assert.equal(b.componentHealth.recovery, "OPERATOR_STOPPED");
    assert.equal(b.discoveryState, "wda_stopped");
    assertPlainOperatorText(b.discoveryStateMessage, "phone B banner");
    assert.ok(changes.length > 0, "the Fleet page is told the list changed");
    const lifecycle = demo.provisioner.getLifecycleState(demo.ids.b);
    assert.equal(lifecycle.state, "stopped");
  } finally {
    await demo.provisioner.stop();
  }
});

test("the demo's pretend phones use ports that cannot overlap the ports real phones use", () => {
  const realControl = resolvePortRange({});
  const realVideo = resolveMjpegPortRange({});
  const overlaps = (first, second) => first.start <= second.end && second.start <= first.end;
  assert.equal(overlaps(DEMO_CONTROL_PORT_RANGE, realControl), false);
  assert.equal(overlaps(DEMO_VIDEO_PORT_RANGE, realVideo), false);
  assert.equal(overlaps(DEMO_CONTROL_PORT_RANGE, DEMO_VIDEO_PORT_RANGE), false);
});

test("broken-phone mode is off unless explicitly asked for, by the flag or the variable", () => {
  assert.equal(brokenPhonesRequested(["node", "demo.js"], {}), false);
  assert.equal(brokenPhonesRequested(["node", "demo.js", "--broken-phones"], {}), true);
  assert.equal(brokenPhonesRequested(["node", "demo.js"], { DEMO_BROKEN_PHONES: "1" }), true);
  assert.equal(brokenPhonesRequested(["node", "demo.js"], { DEMO_BROKEN_PHONES: "0" }), false);
});

test("a paused automatic setup in the demo is off unless explicitly asked for, and it also needs the two demo phones", () => {
  assert.equal(pausedSetupRequested(["node", "demo.js"], {}), false);
  assert.equal(pausedSetupRequested(["node", "demo.js", "--paused-setup"], {}), true);
  assert.equal(pausedSetupRequested(["node", "demo.js"], { DEMO_PAUSED_SETUP: "1" }), true);
  assert.equal(pausedSetupRequested(["node", "demo.js"], { DEMO_PAUSED_SETUP: "0" }), false);
  const source = fs.readFileSync(path.join(serverRoot, "scripts/demo.js"), "utf8");
  assert.match(source, /const BROKEN_PHONES = brokenPhonesRequested\(\) \|\| PAUSED_SETUP;/, "the paused setup is shown with the demo phones");
  assert.match(source, /\.\.\.\(PAUSED_SETUP \? \{ DEMO_PAUSED_SETUP: "1" \} : \{\}\)/, "only passed on when asked for");
  const demoServer = fs.readFileSync(path.join(serverRoot, "scripts/demoServer.js"), "utf8");
  assert.match(demoServer, /pausedSetup: process\.env\.DEMO_PAUSED_SETUP === "1"/);
});

test("with the paused-setup option the real provisioner pauses on a damaged record, shows it, and Check again keeps it paused", async () => {
  const devices = new Map();
  const demo = await installBrokenPhones({
    devices, pausedSetup: true, storeDir: fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-demo-phones-paused-")),
  });
  try {
    const status = demo.provisioner.getSetupStatus();
    assert.deepEqual({ state: status.state, code: status.code }, { state: "paused", code: "setup_paused_record_damaged" });
    assertPlainOperatorText(status.message, "paused banner");
    const again = await demo.provisioner.recheckNow();
    assert.equal(again.code, "setup_paused_record_damaged");
    assert.equal(STORE_UNAVAILABLE, "PROCESS_OWNERSHIP_STORE_UNAVAILABLE");
  } finally {
    await demo.provisioner.stop();
  }
});

test("without the option the demo phones' setup is running, as before", async () => {
  const demo = await installBrokenPhones({ devices: new Map(), storeDir: fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-demo-phones-run-")) });
  try {
    assert.equal(demo.provisioner.getSetupStatus().state, "running");
  } finally {
    await demo.provisioner.stop();
  }
});

test("in broken-phone mode every switch that could reach a real phone or network is forced off", () => {
  const env = brokenPhonesEnvironment();
  for (const key of ["AUTO_DISCOVER_IOS_DEVICES", "AUTO_PROVISION_WDA", "AUTO_ROUTE_PROXY_TUNNELS", "AUTO_NETWORK_ENROLLMENT", "AUTO_ENABLE_INTERNET_SHARING"]) {
    assert.equal(env[key], "false", key);
  }
  assert.equal(env.WDA_PORT_RANGE_START, String(DEMO_CONTROL_PORT_RANGE.start));
  const source = fs.readFileSync(path.join(serverRoot, "scripts/demo.js"), "utf8");
  assert.match(source, /\.\.\.\(BROKEN_PHONES \? \{ \.\.\.brokenPhonesEnvironment\(\)/, "the demo passes them to the server child");
  assert.match(source, /BROKEN_PHONES \? "scripts\/demoServer\.js" : "src\/index\.js"/, "without the option the demo starts the server exactly as before");
});

test("the demo refuses to run in production, outside local development, or with anything outside its own temporary folder", () => {
  const tmp = os.tmpdir();
  const demoPaths = Object.fromEntries(["OPERATORS_CONFIG_PATH", "SESSION_STORE_DIR", "AUDIT_LOG_PATH", "QUEUE_STORE_PATH", "DEVICE_CONFIG_PATH"].map(key => [key, path.join(tmp, "phonefarm-demo-abc", key)]));
  const good = { PHONE_FARM_LOCAL_DEV: "true", ...demoPaths };
  assert.doesNotThrow(() => assertDemoEnvironment(good, tmp));
  assert.throws(() => assertDemoEnvironment({ ...good, NODE_ENV: "production" }, tmp), /never runs in production/);
  assert.throws(() => assertDemoEnvironment({ ...good, PHONE_FARM_LOCAL_DEV: "false" }, tmp), /LOCAL_DEV/);
  assert.throws(() => assertDemoEnvironment({ ...good, SESSION_STORE_DIR: "C:/real/storage/sessions" }, tmp), /own temporary folder/);
});

test("the demo server entry refuses to start under NODE_ENV=production (a real run, nothing is loaded)", () => {
  const run = spawnSync(process.execPath, [path.join(serverRoot, "scripts/demoServer.js")], {
    env: { ...process.env, NODE_ENV: "production", PHONE_FARM_LOCAL_DEV: "true" }, encoding: "utf8", timeout: 20_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /never runs in production/);
});

test("the server's test-only doors still refuse to open outside tests, and nothing in the installer ships the demo", () => {
  const index = fs.readFileSync(path.join(serverRoot, "src/index.js"), "utf8");
  assert.match(index, /export function setNetworkRoutingForTests[\s\S]{0,200}NODE_ENV !== "test"\) throw/);
  assert.match(index, /export function setDeviceProvisionerForTests[\s\S]{0,200}NODE_ENV !== "test"\) throw/);
  const stage = fs.readFileSync(path.resolve(serverRoot, "../../desktop/scripts/prepare-runtime.cjs"), "utf8");
  assert.match(stage, /"server\/src"/);
  assert.doesNotMatch(stage, /server\/scripts/);
});
