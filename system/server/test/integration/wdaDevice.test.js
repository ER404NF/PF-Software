import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { WdaDevice } from "../../src/wdaDevice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../../fixtures/fake-wda-server.js");

let child;
let BASE_URL;
let PORT;

// Spawns with an OS-assigned ephemeral port (arg "0"), not a fixed one —
// a fixed port here previously caused real, if infrequent, flakiness: many
// rapid `npm test` runs in a row can leave enough TIME_WAIT sockets behind
// on a fixed port that a later run's bind (or a connection to it) fails.
// The fixture announces the port it actually got on stdout; parse that.
function spawnFakeWda() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fixturePath, "0"], { stdio: "pipe" });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/\[fake-wda\] listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        proc.stdout.off("data", onData);
        resolve({ proc, baseUrl: `http://127.0.0.1:${match[1]}` });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("error", reject);
  });
}

before(async () => {
  const { proc, baseUrl } = await spawnFakeWda();
  child = proc;
  BASE_URL = baseUrl;
  PORT = Number(new URL(baseUrl).port);
});

after(() => {
  child.kill();
});

beforeEach(async () => {
  await fetch(`${BASE_URL}/debug/reset`, { method: "POST" });
});

async function getHistory() {
  return fetch(`${BASE_URL}/debug/history`).then((r) => r.json()).then((b) => b.history);
}

test("WDA remains offline until a readiness probe succeeds and does not overwrite ownership", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  assert.equal(device.status, "offline");
  assert.equal(await device.checkReadiness(), true);
  assert.equal(device.status, "idle");
  assert.equal(device.readiness.ready, true);

  await fetch(`${BASE_URL}/debug/ready`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ready: false }) });
  assert.equal(await device.checkReadiness(), false);
  assert.equal(device.status, "offline");
  device.status = "in-use";
  assert.equal(await device.checkReadiness(), false);
  assert.equal(device.status, "in-use");
});

test("tap sends normalized coordinates scaled to the window size", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  await device.tap(0.5, 0.25);

  const taps = (await getHistory()).filter((h) => h.type === "tap");
  assert.equal(taps.length, 1);
  assert.equal(taps[0].x, 0.5 * 375);
  assert.equal(taps[0].y, 0.25 * 667);
});

test("swipe posts the direction", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  await device.swipe("up");

  const swipes = (await getHistory()).filter((h) => h.type === "swipe");
  assert.equal(swipes.length, 1);
  assert.equal(swipes[0].direction, "up");
});

test("typeText posts the text as a single-element value array", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  await device.typeText("hello");

  const keys = (await getHistory()).filter((h) => h.type === "keys");
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0].value, ["hello"]);
});

test("pressHome posts to /wda/homescreen directly, with no session required first", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  await device.pressHome();

  const history = await getHistory();
  assert.deepEqual(history.map((h) => h.type), ["homescreen"]);
  // Real WDA registers this route `.withoutSession` (FBCustomCommands.m) —
  // pressing Home has no meaningful relationship to a driver session, so
  // this must never trigger a session/window-size round trip first the way
  // tap does.
  assert.equal(device.sessionId, null);
});

test("getUiTree returns WDA accessibility source through the shared device contract", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  const tree = await device.getUiTree();
  assert.match(tree, /<Application/);
  assert.equal(tree.includes("Research"), true);
  assert.deepEqual((await getHistory()).map((h) => h.type), ["session", "source"]);
});

test("the WDA session is created once and reused across sequential calls", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  await device.tap(0.1, 0.1);
  const firstSessionId = device.sessionId;
  await device.swipe("down");
  await device.typeText("hi");

  assert.equal(device.sessionId, firstSessionId);
  const history = await getHistory();
  // session + window-size happen once, up front, from the first tap only —
  // swipe reuses the cached window size, typeText never needs it at all.
  assert.deepEqual(history.map((h) => h.type), ["session", "window-size", "tap", "swipe", "keys"]);

});

test("concurrent sessionless render and tap coalesce one WDA session", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  await fetch(`${BASE_URL}/debug/delay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ms: 50 }),
  });

  await Promise.all([device.render(), device.tap(0.2, 0.3)]);
  const history = await getHistory();
  assert.equal(history.filter(entry => entry.type === "session").length, 1);
  assert.equal(history.filter(entry => entry.type === "screenshot").length, 1);
  assert.equal(history.filter(entry => entry.type === "tap").length, 1);
});

test("authorization revoked during window lookup prevents the physical tap", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  await device.render();
  await fetch(`${BASE_URL}/debug/reset`, { method: "POST" });
  await fetch(`${BASE_URL}/debug/delay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ms: 100 }),
  });

  let authorized = true;
  const pendingTap = device.tap(0.4, 0.4, { authorize: () => authorized });
  while (!(await getHistory()).some(entry => entry.type === "window-size")) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  authorized = false;
  await assert.rejects(pendingTap, error => error?.code === "DEVICE_ACCESS_REVOKED");
  assert.equal((await getHistory()).some(entry => entry.type === "tap"), false);
  assert.notEqual(device.sessionId, null, "authorization failure must not invalidate a healthy WDA session");
});

test("malformed WDA window dimensions are rejected before a tap", async () => {
  const originalFetch = globalThis.fetch;
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT });
  device.sessionId = "fixture-session";
  globalThis.fetch = async url => {
    if (String(url).endsWith("/window/size")) return { ok: true, json: async () => ({ value: { width: 0, height: "667" } }) };
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await assert.rejects(() => device.tap(0.1, 0.1), /invalid dimensions/);
    assert.equal(device.sessionId, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pressHome invalidates a cached session on failure, same as every other action", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT, timeoutMs: 300 });
  await device.tap(0.1, 0.1); // establish a real session first
  assert.notEqual(device.sessionId, null);

  await fetch(`${BASE_URL}/debug/hang`, { method: "POST" });
  await assert.rejects(() => device.pressHome());
  assert.equal(device.sessionId, null);
});

test("a hung WDA process times out instead of hanging forever, and invalidates the session", async () => {
  const device = new WdaDevice("wda-1", "Test iPhone", { port: PORT, timeoutMs: 300 });

  // Establish a real session first, then make the server stop responding —
  // simulates a WDA process that's locked/crashed but still holds the port.
  await device.tap(0.1, 0.1);
  assert.notEqual(device.sessionId, null);

  await fetch(`${BASE_URL}/debug/hang`, { method: "POST" });

  const start = Date.now();
  await assert.rejects(() => device.tap(0.2, 0.2));
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `expected timeout well under 2s, took ${elapsed}ms`);
  assert.equal(device.sessionId, null, "a failed call must invalidate the cached session");
});
