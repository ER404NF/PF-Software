import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { WdaDevice } from "../../src/wdaDevice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../../fixtures/fake-wda-server.js");
const TEST_PASSWORD = "test-password";

// Same isolation as wsProtocol.test.js: index.js reads these at import time.
const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-wsstream-"));
process.env.FILE_STORE_DIR = path.join(tmpStorageRoot, "files");
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(tmpStorageRoot, "model-selections.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(tmpStorageRoot, "assignments.json");
process.env.MEDIA_DEVICE_QUOTA_BYTES = "64";
process.env.MEDIA_GLOBAL_QUOTA_BYTES = "128";
process.env.MEDIA_MIN_FREE_BYTES = "0";
process.env.STREAM_IDLE_CLOSE_MS = "150";

const { server, wss, devices, deviceHealth, deviceLease, auditLog, streamHub, deviceMonitorConfig } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");

let relayUrl;
let httpUrl;
let fakeWdaChild;
let FAKE_URL;
let CONTROL_PORT;
let VIDEO_PORT;
const openClients = [];

async function loginCookie(username) {
  const res = await fetch(`${httpUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: HTTP ${res.status}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  await res.json();
  return cookie;
}

// A client that keeps JSON messages and binary video frames apart.
async function openClient(username = "test-va") {
  const ws = new WebSocket(relayUrl, { headers: { Cookie: await loginCookie(username) } });
  const messages = [];
  const frames = []; // { kind, streamId, payload }
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      const buffer = Buffer.from(raw);
      frames.push({ kind: buffer[0], streamId: buffer.readUInt32BE(1), payload: buffer.subarray(5) });
    } else messages.push(JSON.parse(raw.toString()));
  });
  const client = {
    ws, messages, frames,
    send: message => ws.send(JSON.stringify(message)),
    async until(predicate, { timeoutMs = 4000, label = "condition" } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    message: (predicate, label) => client.until(() => messages.find(predicate), { label }),
    close: () => ws.close(),
  };
  openClients.push(client);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  await client.message(m => m.type === "device_list", "device_list");
  return client;
}

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

const fakeHistory = () => fetch(`${FAKE_URL}/debug/history`).then(r => r.json()).then(b => b.history);
const fakeStats = () => fetch(`${FAKE_URL}/debug/stream-stats`).then(r => r.json());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  const { proc, control, video } = await spawnFakeWda();
  fakeWdaChild = proc;
  CONTROL_PORT = control;
  VIDEO_PORT = video;
  FAKE_URL = `http://127.0.0.1:${control}`;

  devices.set("stream-wda", new WdaDevice("stream-wda", "Streaming WDA", { port: CONTROL_PORT, mjpegPort: VIDEO_PORT, timeoutMs: 1000 }));
  devices.set("plain-wda", new WdaDevice("plain-wda", "Plain WDA", { port: CONTROL_PORT, timeoutMs: 1000 }));
  // Read-only watching needs a configured monitor adapter for the device.
  deviceMonitorConfig.set("stream-wda", { adapter: "wda", physicallyValidated: false });
  for (const [username, role, allowedDevices] of [
    ["test-va", "admin", null],
    ["test-va-2", "admin", null],
    ["test-limited", "va", ["stream-wda", "mock-1"]],
  ]) operators.set(username, { username, passwordHash: hashPassword(TEST_PASSWORD), allowedDevices, role });

  await new Promise(resolve => server.listen(0, resolve));
  relayUrl = `ws://127.0.0.1:${server.address().port}`;
  httpUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const client of openClients) client.close();
  for (const id of ["stream-wda", "plain-wda"]) { devices.delete(id); deviceMonitorConfig.delete(id); }
  for (const name of ["test-va", "test-va-2", "test-limited"]) operators.delete(name);
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fakeWdaChild.kill();
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // A connection keeps its claim on a phone until it closes, so end every
  // client from the previous test before this one starts.
  for (const client of openClients.splice(0)) {
    if (client.ws.readyState !== WebSocket.CLOSED) {
      await new Promise(resolve => { client.ws.once("close", resolve); client.ws.close(); });
    }
  }
  await sleep(100);
  await fetch(`${FAKE_URL}/debug/reset`, { method: "POST" });
  await fetch(`${FAKE_URL}/debug/stream-stall`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stalled: false }) });
  deviceHealth.clear();
  for (const device of devices.values()) device.status = "idle";
  deviceLease.reset();
  // Let the previous test's stream finish its grace period.
  await sleep(250);
});

async function select(client, deviceId) {
  client.send({ type: "select_device", deviceId });
  await client.message(m => m.type === "frame" && m.deviceId === deviceId, `first frame of ${deviceId}`);
}

async function startStream(client, deviceId) {
  const before = client.messages.length;
  client.send({ type: "start_stream", deviceId });
  const started = await client.message(m => m.type === "stream_started" && m.deviceId === deviceId, "stream_started");
  assert.ok(client.messages.length > before);
  return started;
}

test("the mock phone streams live and inputs are acknowledged instead of screenshotted", async () => {
  const client = await openClient();
  await select(client, "mock-1");
  const framesBefore = client.messages.filter(m => m.type === "frame").length;

  const started = await startStream(client, "mock-1");
  assert.equal(started.mode, "control");
  const first = await client.until(() => client.frames.find(f => f.streamId === started.streamId), { label: "first video frame" });
  assert.equal(first.kind, 3, "SVG for the mock phone");
  assert.match(first.payload.toString(), /^<svg/);

  client.send({ type: "tap", x: 70 / 375, y: 120 / 667, requestId: 41 });
  const ack = await client.message(m => m.type === "action_ack" && m.requestId === 41, "action_ack");
  assert.equal(ack.action, "Tap");
  await client.until(() => client.frames.some(f => /Instagram \(mock\)/.test(f.payload.toString())), { label: "video shows the opened app" });
  assert.equal(client.messages.filter(m => m.type === "frame").length, framesBefore, "no screenshot frames while streaming");
});

test("mouse-style gestures: drag scrolls the feed, long press and double tap are accepted and audited", async () => {
  const client = await openClient();
  await select(client, "mock-1");
  await startStream(client, "mock-1");
  client.send({ type: "tap", x: 70 / 375, y: 120 / 667 });
  await client.until(() => client.frames.some(f => /Instagram \(mock\)/.test(f.payload.toString())), { label: "app open" });

  client.send({ type: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.3, requestId: 7 });
  await client.message(m => m.type === "action_ack" && m.requestId === 7, "drag ack");
  await client.until(() => client.frames.some(f => /Post 12/.test(f.payload.toString())), { label: "feed scrolled" });

  client.send({ type: "long_press", x: 0.5, y: 0.5, durationMs: 900, requestId: 8 });
  await client.message(m => m.type === "action_ack" && m.requestId === 8, "long press ack");
  client.send({ type: "double_tap", x: 0.5, y: 0.5, requestId: 9 });
  await client.message(m => m.type === "action_ack" && m.requestId === 9, "double tap ack");

  const types = auditLog.listEvents().map(event => event.type);
  for (const type of ["action_drag", "action_long_press", "action_double_tap"]) assert.ok(types.includes(type), type + " audited");
});

test("malformed gestures never reach the device", async () => {
  const client = await openClient();
  await select(client, "stream-wda");
  client.send({ type: "drag", x1: 2, y1: 0.5, x2: 0.5, y2: 0.3 });
  client.send({ type: "drag", x1: "a", y1: 0.5, x2: 0.5, y2: 0.3 });
  client.send({ type: "drag", x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 });
  client.send({ type: "long_press", x: NaN, y: 0.2 });
  client.send({ type: "double_tap", x: -1, y: 0.2 });
  const framesBefore = client.messages.filter(m => m.type === "frame").length;
  client.send({ type: "tap", x: 0.5, y: 0.5 }); // proves the queue drained past the bad ones
  await client.until(() => client.messages.filter(m => m.type === "frame").length > framesBefore, { label: "the valid tap completes" });
  const history = await fakeHistory();
  assert.equal(history.filter(h => ["drag", "long-press", "double-tap"].includes(h.type)).length, 0);
});

test("a real WDA phone streams PNG/JPEG frames, and gestures reach it in device points", async () => {
  const client = await openClient();
  await select(client, "stream-wda");
  const started = await startStream(client, "stream-wda");
  await client.until(() => client.frames.filter(f => f.streamId === started.streamId).length >= 5, { label: "5 video frames" });
  const mine = client.frames.filter(f => f.streamId === started.streamId);
  assert.ok(mine.every(f => f.kind === 2), "the fake serves PNG");
  assert.notDeepEqual(mine[0].payload, mine[4].payload, "frames change");

  client.send({ type: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, holdMs: 60, requestId: 5 });
  await client.message(m => m.type === "action_ack" && m.requestId === 5, "drag ack");
  client.send({ type: "type_text", text: "ab\b", requestId: 6 });
  await client.message(m => m.type === "action_ack" && m.requestId === 6, "text ack");

  const history = await fakeHistory();
  const drag = history.find(h => h.type === "drag");
  assert.deepEqual([drag.fromX, drag.fromY, drag.toX, drag.toY], [0.5 * 375, 0.8 * 667, 0.5 * 375, 0.2 * 667]);
  assert.equal(drag.duration, 0.06);
  assert.equal(history.find(h => h.type === "keys").value[0], "ab\b");
  assert.equal(history.filter(h => h.type === "screenshot").length <= 1, true, "no screenshot polling while streaming");
});

test("two viewers share one upstream video connection; a watcher sees frames but cannot input", async () => {
  const controller = await openClient("test-limited"); // a VA, the only role a watcher may observe
  const watcher = await openClient("test-va");
  await select(controller, "stream-wda");
  const controlStream = await startStream(controller, "stream-wda");

  watcher.send({ type: "watch_device", deviceId: "stream-wda" });
  await watcher.message(m => m.type === "watch_started", "watch_started");
  const watchStream = await startStream(watcher, "stream-wda");
  assert.equal(watchStream.mode, "watch");

  await controller.until(() => controller.frames.some(f => f.streamId === controlStream.streamId), { label: "controller frames" });
  await watcher.until(() => watcher.frames.filter(f => f.streamId === watchStream.streamId).length >= 3, { label: "watcher frames" });
  assert.equal((await fakeStats()).active, 1, "one upstream connection for both viewers");

  watcher.send({ type: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2 });
  const denied = await watcher.message(m => m.type === "error" && m.code === "watch_read_only", "read-only rejection");
  assert.match(denied.message, /read-only/i);
  assert.equal((await fakeHistory()).filter(h => h.type === "drag").length, 0);
});

test("releasing the phone ends the stream and, after the grace period, the upstream connection", async () => {
  const client = await openClient();
  await select(client, "stream-wda");
  const started = await startStream(client, "stream-wda");
  await client.until(() => client.frames.some(f => f.streamId === started.streamId), { label: "frames flowing" });
  assert.ok((await fakeStats()).active >= 1);

  client.send({ type: "release_device", deviceId: "stream-wda" });
  await sleep(100);
  const count = client.frames.length;
  await sleep(300);
  assert.equal(client.frames.length, count, "no frames after release");
  let active = 1;
  for (let i = 0; i < 40 && active !== 0; i += 1) { active = (await fakeStats()).active; if (active) await sleep(100); }
  assert.equal(active, 0, "upstream closed after the last viewer left");
  assert.equal(streamHub.stats("stream-wda").state, "idle");
});

test("stop_stream stops frames without releasing the phone", async () => {
  const client = await openClient();
  await select(client, "mock-1");
  const started = await startStream(client, "mock-1");
  await client.until(() => client.frames.some(f => f.streamId === started.streamId), { label: "frames" });
  client.send({ type: "stop_stream" });
  await sleep(150);
  const count = client.frames.length;
  const screenshotsBefore = client.messages.filter(m => m.type === "frame").length;
  client.send({ type: "tap", x: 0.9, y: 0.9, requestId: 77 });
  await client.until(() => client.messages.filter(m => m.type === "frame").length > screenshotsBefore, { label: "screenshot after tap (screenshot mode again)" });
  await sleep(200);
  assert.equal(client.frames.length, count, "no video after stop_stream");
  assert.equal(client.messages.some(m => m.type === "action_ack" && m.requestId === 77), false, "no stream ack once streaming stopped");
});

test("start_stream is refused for a phone you neither control nor watch", async () => {
  const client = await openClient();
  client.send({ type: "start_stream", deviceId: "stream-wda" });
  const error = await client.message(m => m.type === "error" && m.code === "stream_denied", "stream_denied");
  assert.equal(error.deviceId, "stream-wda");
  assert.equal(client.frames.length, 0);
});

test("a phone with no video port reports stream_unsupported so the client can fall back", async () => {
  const client = await openClient();
  await select(client, "plain-wda");
  client.send({ type: "start_stream", deviceId: "plain-wda" });
  await client.message(m => m.type === "stream_unsupported" && m.deviceId === "plain-wda", "stream_unsupported");
});

test("losing access mid-stream stops the video at once and releases the phone", async () => {
  const client = await openClient("test-limited");
  await select(client, "stream-wda");
  const started = await startStream(client, "stream-wda");
  await client.until(() => client.frames.some(f => f.streamId === started.streamId), { label: "frames" });

  operators.get("test-limited").allowedDevices = ["mock-1"]; // access to the streaming phone withdrawn
  await client.message(m => m.type === "error" && m.code === "device_access_revoked", "revocation notice");
  await sleep(100);
  const count = client.frames.length;
  await sleep(300);
  assert.equal(client.frames.length, count, "no video after access was revoked");
  assert.notEqual(devices.get("stream-wda").status, "in-use");
});

test("closing the browser tab tears the stream down", async () => {
  const client = await openClient();
  await select(client, "stream-wda");
  await startStream(client, "stream-wda");
  await client.until(() => client.frames.length > 0, { label: "frames" });
  client.close();
  let active = 1;
  for (let i = 0; i < 40 && active !== 0; i += 1) { active = (await fakeStats()).active; if (active) await sleep(100); }
  assert.equal(active, 0);
});
