import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WdaDevice } from "../../src/wdaDevice.js";
import { frameKind } from "../../src/mjpegParser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../../fixtures/fake-wda-server.js");

let child;
let BASE_URL;
let PORT;
let MJPEG_PORT;

// Ephemeral ports for both the control API and the MJPEG server (see
// wdaDevice.test.js for why fixed ports are avoided).
function spawnFakeWda() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fixturePath, "0", "0"], { stdio: "pipe" });
    let buffer = "";
    const onData = chunk => {
      buffer += chunk.toString();
      const control = buffer.match(/\[fake-wda\] listening on http:\/\/127\.0\.0\.1:(\d+)/);
      const video = buffer.match(/\[fake-wda\] mjpeg listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (control && video) {
        proc.stdout.off("data", onData);
        resolve({ proc, control: Number(control[1]), video: Number(video[1]) });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("error", reject);
  });
}

before(async () => {
  const { proc, control, video } = await spawnFakeWda();
  child = proc;
  PORT = control;
  MJPEG_PORT = video;
  BASE_URL = `http://127.0.0.1:${PORT}`;
});

after(() => child.kill());

beforeEach(async () => {
  await post("/debug/reset");
  await post("/debug/stream-stall", { stalled: false });
  await post("/debug/stream-fps", { fps: 30 });
});

async function post(route, body) {
  return fetch(`${BASE_URL}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then(r => r.json());
}
const history = () => fetch(`${BASE_URL}/debug/history`).then(r => r.json()).then(b => b.history);
const stats = () => fetch(`${BASE_URL}/debug/stream-stats`).then(r => r.json());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, { timeoutMs = 5000, stepMs = 25, label = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function device() {
  return new WdaDevice("wda-1", "Test iPhone", { port: PORT, mjpegPort: MJPEG_PORT });
}

// ---- gestures reach WDA in device points ------------------------------------

test("drag converts a normalised path into WDA points and passes the hold time through", async () => {
  await device().drag(0.5, 0.8, 0.5, 0.2, 0.35);
  const drags = (await history()).filter(h => h.type === "drag");
  assert.equal(drags.length, 1);
  assert.deepEqual(
    [drags[0].fromX, drags[0].fromY, drags[0].toX, drags[0].toY, drags[0].duration],
    [0.5 * 375, 0.8 * 667, 0.5 * 375, 0.2 * 667, 0.35],
  );
});

test("longPress and doubleTap use the session-scoped WDA routes with scaled points", async () => {
  const wda = device();
  await wda.longPress(0.25, 0.5, 1.1);
  await wda.doubleTap(0.75, 0.25);
  const all = await history();
  const press = all.find(h => h.type === "long-press");
  const double = all.find(h => h.type === "double-tap");
  assert.deepEqual([press.x, press.y, press.duration], [0.25 * 375, 0.5 * 667, 1.1]);
  assert.deepEqual([double.x, double.y], [0.75 * 375, 0.25 * 667]);
});

test("a revoked authorization stops a gesture before it reaches the phone", async () => {
  const wda = device();
  await assert.rejects(() => wda.drag(0.1, 0.1, 0.9, 0.9, 0.2, { authorize: () => false }), { code: "DEVICE_ACCESS_REVOKED" });
  assert.equal((await history()).filter(h => h.type === "drag").length, 0);
});

test("a failing gesture surfaces the error", async () => {
  const wda = new WdaDevice("wda-1", "x", { port: 1, mjpegPort: MJPEG_PORT, timeoutMs: 500 });
  await assert.rejects(() => wda.drag(0.1, 0.1, 0.9, 0.9));
});

// ---- streaming ----------------------------------------------------------------

test("a device without an MJPEG port cannot stream", () => {
  const wda = new WdaDevice("wda-1", "x", { port: PORT });
  assert.equal(wda.supportsStream, false);
  assert.throws(() => wda.openStream({ onFrame() {} }), /no MJPEG port/);
});

test("openStream delivers real, changing, decodable frames and applies the video profile", async () => {
  const frames = [];
  const states = [];
  const stream = device().openStream({ onFrame: frame => frames.push(frame), onState: state => states.push(state) });
  try {
    await until(() => frames.length >= 5, { label: "5 frames" });
    assert.ok(frames.every(frame => frameKind(frame) === 2), "the fake serves PNG frames");
    assert.notDeepEqual(frames[0], frames[4], "frames must differ (it is a live stream)");
    assert.ok(states.includes("connecting"));
    const settings = (await history()).find(h => h.type === "settings");
    assert.ok(settings, "streaming profile posted to WDA");
    assert.equal(settings.settings.mjpegServerFramerate, 15);
    assert.equal(settings.settings.mjpegScalingFactor, 50);
    assert.equal(settings.settings.mjpegServerScreenshotQuality, 35);
  } finally {
    stream.close();
  }
});

test("a dropped video connection reconnects by itself and frames resume", async () => {
  const frames = [];
  const states = [];
  const stream = device().openStream({
    onFrame: frame => frames.push(frame),
    onState: (state, detail) => states.push([state, detail ?? null]),
    reconnectDelayMs: 50,
  });
  try {
    await until(() => frames.length >= 3, { label: "initial frames" });
    const before = frames.length;
    await post("/debug/stream-drop");
    await until(() => frames.length >= before + 3, { label: "frames after reconnect" });
    assert.ok(states.some(([state]) => state === "reconnecting"), "reconnect was reported");
    assert.ok((await stats()).connections >= 2);
  } finally {
    stream.close();
  }
});

test("a frozen stream (open but silent) is detected and reconnected", async () => {
  const frames = [];
  const states = [];
  const stream = device().openStream({
    onFrame: frame => frames.push(frame),
    onState: (state, detail) => states.push([state, detail ?? null]),
    reconnectDelayMs: 50,
    stallMs: 300,
  });
  try {
    await until(() => frames.length >= 3, { label: "initial frames" });
    await post("/debug/stream-stall", { stalled: true });
    await until(() => states.some(([state, detail]) => state === "reconnecting" && detail === "stream stalled"), { label: "stall detection" });
    await post("/debug/stream-stall", { stalled: false });
    const before = frames.length;
    await until(() => frames.length >= before + 3, { label: "frames after unfreeze" });
  } finally {
    stream.close();
  }
});

test("close() ends the upstream connection and stops emitting", async () => {
  const frames = [];
  const states = [];
  const stream = device().openStream({ onFrame: frame => frames.push(frame), onState: state => states.push(state) });
  await until(() => frames.length >= 2, { label: "frames" });
  stream.close();
  await until(async () => (await stats()).active === 0, { label: "connection closed" });
  await until(() => states.includes("closed"), { label: "closed state" });
  const count = frames.length;
  await sleep(250);
  assert.equal(frames.length, count, "no frames after close");
});

test("an unreachable video port keeps retrying without throwing", async () => {
  const wda = new WdaDevice("wda-1", "x", { port: PORT, mjpegPort: 1 });
  const states = [];
  const stream = wda.openStream({ onFrame() {}, onState: (state, detail) => states.push([state, detail ?? null]), reconnectDelayMs: 30, maxReconnectDelayMs: 60 });
  try {
    await until(() => states.filter(([state]) => state === "reconnecting").length >= 3, { label: "3 retries" });
  } finally {
    stream.close();
  }
});
