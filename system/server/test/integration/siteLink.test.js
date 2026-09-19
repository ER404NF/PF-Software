import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { WdaDevice } from "../../src/wdaDevice.js";
import { MockDevice } from "../../src/mockDevice.js";
import { SiteAgent } from "../../src/siteAgent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../../fixtures/fake-wda-server.js");
const TEST_PASSWORD = "test-password";

const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-sites-"));
process.env.FILE_STORE_DIR = path.join(tmpStorageRoot, "files");
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(tmpStorageRoot, "model-selections.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(tmpStorageRoot, "assignments.json");
process.env.SITE_STORE_PATH = path.join(tmpStorageRoot, "sites.json");
process.env.MEDIA_DEVICE_QUOTA_BYTES = "64";
process.env.MEDIA_GLOBAL_QUOTA_BYTES = "128";
process.env.MEDIA_MIN_FREE_BYTES = "0";
process.env.STREAM_IDLE_CLOSE_MS = "150";

const { server, wss, devices, deviceHealth, deviceLease, auditLog, siteStore, siteLinkHub } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");

let httpUrl;
let relayUrl;
let fakeWdaChild;
let FAKE_URL;
let CONTROL_PORT;
let VIDEO_PORT;
const openClients = [];
const agents = [];
let site;
let token;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, { timeoutMs = 6000, label = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function loginCookie(username) {
  const res = await fetch(`${httpUrl}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: HTTP ${res.status}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  await res.json();
  return cookie;
}

async function openClient(username = "hub-admin") {
  const ws = new WebSocket(relayUrl, { headers: { Cookie: await loginCookie(username) } });
  const messages = [];
  const frames = [];
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      const buffer = Buffer.from(raw);
      frames.push({ kind: buffer[0], streamId: buffer.readUInt32BE(1), payload: buffer.subarray(5) });
    } else messages.push(JSON.parse(raw.toString()));
  });
  const client = {
    ws, messages, frames,
    send: message => ws.send(JSON.stringify(message)),
    until: (predicate, label) => until(predicate, { label }),
    message: (predicate, label) => until(() => messages.find(predicate), { label }),
  };
  openClients.push(client);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  await client.message(m => m.type === "device_list", "device_list");
  return client;
}

async function adminApi(method, route, body) {
  const cookie = await loginCookie("hub-admin");
  const res = await fetch(`${httpUrl}${route}`, {
    method, headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function spawnFakeWda() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fixturePath, "0", "0"], { stdio: "pipe" });
    let buffer = "";
    const onData = chunk => {
      buffer += chunk.toString();
      const control = buffer.match(/\[fake-wda\] listening on http:\/\/127\.0\.0\.1:(\d+)/);
      const video = buffer.match(/\[fake-wda\] mjpeg listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (control && video) { proc.stdout.off("data", onData); resolve({ proc, control: Number(control[1]), video: Number(video[1]) }); }
    };
    proc.stdout.on("data", onData);
    proc.on("error", reject);
  });
}

const fakeHistory = () => fetch(`${FAKE_URL}/debug/history`).then(r => r.json()).then(b => b.history);

// A site's local phones: one simulator and one (fake) WDA phone with a video port.
function siteDevices() {
  const mock = new MockDevice("mock-a", "Site simulator");
  const wda = new WdaDevice("wda-a", "Site iPhone", { port: CONTROL_PORT, mjpegPort: VIDEO_PORT, timeoutMs: 1000 });
  return { mock, wda, map: new Map([[mock.id, mock], [wda.id, wda]]) };
}

function startAgent({ agentToken = token, siteId = site.id, map = siteDevices().map } = {}) {
  const agent = new SiteAgent({
    hubUrl: httpUrl, siteId, token: agentToken, devices: map,
    reconnectMinMs: 50, reconnectMaxMs: 200, summaryIntervalMs: 100, readinessIntervalMs: 200,
  });
  agents.push(agent);
  agent.start();
  return agent;
}

const remoteId = localId => `${site.id}__${localId}`;

before(async () => {
  const fake = await spawnFakeWda();
  fakeWdaChild = fake.proc;
  CONTROL_PORT = fake.control;
  VIDEO_PORT = fake.video;
  FAKE_URL = `http://127.0.0.1:${CONTROL_PORT}`;
  for (const [username, role, allowedDevices] of [
    ["hub-admin", "admin", null],
    ["hub-va", "va", ["mock-1"]],
  ]) operators.set(username, { username, passwordHash: hashPassword(TEST_PASSWORD), allowedDevices, role });
  await new Promise(resolve => server.listen(0, resolve));
  httpUrl = `http://127.0.0.1:${server.address().port}`;
  relayUrl = `ws://127.0.0.1:${server.address().port}`;
  ({ site, token } = siteStore.create({ name: "Bucharest", timeZone: "Europe/Bucharest" }));
});

after(async () => {
  for (const agent of agents) agent.stop();
  for (const client of openClients) client.ws.close();
  operators.delete("hub-admin");
  operators.delete("hub-va");
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fakeWdaChild.kill();
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const agent of agents.splice(0)) agent.stop();
  for (const client of openClients.splice(0)) {
    if (client.ws.readyState !== WebSocket.CLOSED) await new Promise(resolve => { client.ws.once("close", resolve); client.ws.close(); });
  }
  await until(() => !siteLinkHub.isOnline(site.id), { label: "previous agent to disconnect" });
  await fetch(`${FAKE_URL}/debug/reset`, { method: "POST" });
  deviceHealth.clear();
  deviceLease.reset();
  for (const device of devices.values()) if (device.status === "in-use") device.status = "idle";
  await sleep(200);
});

test("an agent that presents the site token links up and its phones join the fleet under the site's name", async () => {
  startAgent();
  await until(() => siteLinkHub.isOnline(site.id), { label: "site online" });
  const mock = await until(() => devices.get(remoteId("mock-a")), { label: "remote simulator registered" });
  await until(() => devices.get(remoteId("wda-a"))?.status === "idle", { label: "remote WDA phone ready" });
  assert.equal(mock.status, "idle");
  assert.equal(mock.siteName, "Bucharest");
  assert.equal(mock.timeZone, "Europe/Bucharest");
  assert.equal(devices.get(remoteId("wda-a")).supportsStream, true);
  assert.equal(devices.get(remoteId("mock-a")).supportsStream, true);

  const client = await openClient();
  const list = (await client.message(m => m.type === "device_list" && m.devices.some(d => d.id === remoteId("mock-a")), "fleet with the remote phone")).devices;
  const summary = list.find(d => d.id === remoteId("mock-a"));
  assert.equal(summary.hostLabel, "Bucharest", "phones are grouped under their site");
  assert.equal(summary.siteId, site.id);
  assert.equal(summary.siteOnline, true);
  assert.equal(summary.monitor.adapter, "mock");
  assert.equal(list.find(d => d.id === remoteId("wda-a")).monitor.adapter, "wda");
  assert.ok(auditLog.listEvents().some(event => event.type === "site_connected" && event.detail?.siteId === site.id));
});

test("a wrong, missing or foreign token is refused at the door", async () => {
  const other = siteStore.create({ name: "Somewhere Else" });
  for (const attempt of [
    { agentToken: "pfs_" + "x".repeat(43) },
    { agentToken: other.token }, // another site's valid token
    { agentToken: "not-a-token" },
    { siteId: "no-such-site" },
  ]) {
    const refused = await new Promise(resolve => {
      const socket = new WebSocket(`${relayUrl}/agent-link`, {
        headers: { "x-site-id": attempt.siteId ?? site.id, authorization: `Bearer ${attempt.agentToken ?? token}` },
      });
      socket.on("open", () => { socket.close(); resolve(false); });
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode));
      socket.on("error", () => {});
    });
    assert.equal(refused, 401, JSON.stringify(attempt));
  }
  assert.equal(siteLinkHub.isOnline(site.id), false);
  siteStore.remove(other.site.id);
});

test("an operator controls a remote simulator through the hub: tap opens the app, drag scrolls, video streams back", async () => {
  const local = siteDevices();
  startAgent({ map: local.map });
  await until(() => devices.get(remoteId("mock-a"))?.status === "idle", { label: "remote simulator ready" });
  const client = await openClient();

  client.send({ type: "select_device", deviceId: remoteId("mock-a") });
  const first = await client.message(m => m.type === "frame" && m.deviceId === remoteId("mock-a"), "first screenshot via the site");
  assert.match(first.data, />Home</);

  client.send({ type: "start_stream", deviceId: remoteId("mock-a") });
  const started = await client.message(m => m.type === "stream_started", "stream_started");
  await client.until(() => client.frames.some(f => f.streamId === started.streamId && f.kind === 3), "SVG video from the site");

  client.send({ type: "tap", x: 70 / 375, y: 120 / 667, requestId: 5 });
  await client.message(m => m.type === "action_ack" && m.requestId === 5, "tap acknowledged");
  assert.equal(local.mock.screen, "app", "the tap reached the phone at the site");
  await client.until(() => client.frames.some(f => /Instagram \(mock\)/.test(f.payload.toString())), "the video shows the opened app");

  client.send({ type: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.3, requestId: 6 });
  await client.message(m => m.type === "action_ack" && m.requestId === 6, "drag acknowledged");
  assert.ok(local.mock.scrollY > 0, "the feed scrolled at the site");

  client.send({ type: "type_text", text: "hi\b", requestId: 7 });
  await client.message(m => m.type === "action_ack" && m.requestId === 7, "text acknowledged");
  assert.equal(local.mock.typedText, "h");

  client.send({ type: "home", requestId: 8 });
  await client.message(m => m.type === "action_ack" && m.requestId === 8, "home acknowledged");
  assert.equal(local.mock.screen, "home");
  const audited = auditLog.listEvents().filter(event => event.deviceId === remoteId("mock-a")).map(event => event.type);
  for (const type of ["device_selected", "action_tap", "action_drag", "action_type_text", "action_home"]) assert.ok(audited.includes(type), type);
});

test("a remote WDA phone is driven with exact device points and streams its live video", async () => {
  startAgent();
  await until(() => devices.get(remoteId("wda-a"))?.status === "idle", { label: "remote WDA ready" });
  const client = await openClient();
  client.send({ type: "select_device", deviceId: remoteId("wda-a") });
  await client.message(m => m.type === "frame" && m.deviceId === remoteId("wda-a"), "first screenshot");
  client.send({ type: "start_stream", deviceId: remoteId("wda-a") });
  const started = await client.message(m => m.type === "stream_started", "stream_started");
  await client.until(() => client.frames.filter(f => f.streamId === started.streamId && f.kind === 2).length >= 4, "PNG frames relayed from the site");

  client.send({ type: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, holdMs: 60, requestId: 9 });
  await client.message(m => m.type === "action_ack" && m.requestId === 9, "drag acknowledged");
  client.send({ type: "long_press", x: 0.25, y: 0.5, durationMs: 900, requestId: 10 });
  await client.message(m => m.type === "action_ack" && m.requestId === 10, "long press acknowledged");
  const history = await fakeHistory();
  const drag = history.find(entry => entry.type === "drag");
  assert.deepEqual([drag.fromX, drag.fromY, drag.toX, drag.toY], [0.5 * 375, 0.8 * 667, 0.5 * 375, 0.2 * 667]);
  assert.equal(drag.duration, 0.06);
  const press = history.find(entry => entry.type === "long-press");
  assert.deepEqual([press.x, press.y, press.duration], [0.25 * 375, 0.5 * 667, 0.9]);
});

test("two operators share one upstream stream from a remote phone", async () => {
  startAgent();
  await until(() => devices.get(remoteId("wda-a"))?.status === "idle", { label: "remote WDA ready" });
  operators.get("hub-va").allowedDevices = [remoteId("wda-a")];
  const controller = await openClient("hub-va");
  controller.send({ type: "select_device", deviceId: remoteId("wda-a") });
  await controller.message(m => m.type === "frame", "controller frame");
  controller.send({ type: "start_stream", deviceId: remoteId("wda-a") });
  await controller.message(m => m.type === "stream_started", "controller stream");

  const watcher = await openClient("hub-admin");
  watcher.send({ type: "watch_device", deviceId: remoteId("wda-a") });
  await watcher.message(m => m.type === "watch_started", "watch started");
  watcher.send({ type: "start_stream", deviceId: remoteId("wda-a") });
  const watchStream = await watcher.message(m => m.type === "stream_started", "watcher stream");
  await watcher.until(() => watcher.frames.filter(f => f.streamId === watchStream.streamId).length >= 3, "watcher frames");
  const stats = await fetch(`${FAKE_URL}/debug/stream-stats`).then(r => r.json());
  assert.equal(stats.active, 1, "one video connection at the site serves both operators");
  operators.get("hub-va").allowedDevices = ["mock-1"];
});

test("a site that drops offline takes its phones offline; when it returns, control and video resume", async () => {
  const local = siteDevices();
  const agent = startAgent({ map: local.map });
  await until(() => devices.get(remoteId("wda-a"))?.status === "idle", { label: "remote WDA ready" });
  const client = await openClient();
  client.send({ type: "select_device", deviceId: remoteId("wda-a") });
  await client.message(m => m.type === "frame", "first screenshot");
  client.send({ type: "start_stream", deviceId: remoteId("wda-a") });
  const started = await client.message(m => m.type === "stream_started", "stream_started");
  await client.until(() => client.frames.some(f => f.streamId === started.streamId), "frames flowing");

  // The site's network drops.
  for (const socket of agent.ws ? [agent.ws] : []) socket.terminate();
  await client.message(m => m.type === "stream_state" && m.state === "reconnecting", "viewer told the video is reconnecting");
  // The agent's own reconnect timer brings the link back.
  await until(() => siteLinkHub.isOnline(site.id), { label: "site back online" });
  const before = client.frames.length;
  await client.until(() => client.frames.length >= before + 3, "video resumed on its own after the site reconnected");

  client.send({ type: "tap", x: 0.5, y: 0.5, requestId: 21 });
  await client.message(m => m.type === "action_ack" && m.requestId === 21, "control works again");
});

test("while the site is unreachable, an action fails cleanly and the phone shows offline", async () => {
  const agent = startAgent();
  await until(() => devices.get(remoteId("mock-a"))?.status === "idle", { label: "remote simulator ready" });
  const client = await openClient();
  client.send({ type: "select_device", deviceId: remoteId("mock-a") });
  await client.message(m => m.type === "frame", "first screenshot");
  agent.stop();
  await until(() => !siteLinkHub.isOnline(site.id), { label: "site offline" });
  client.send({ type: "tap", x: 0.5, y: 0.5, requestId: 30 });
  const error = await client.message(m => m.type === "error" && m.deviceId === remoteId("mock-a"), "an error the operator can read");
  assert.match(error.message, /Couldn't reach/);
  const list = await client.message(m => m.type === "device_list" && m.devices.find(d => d.id === remoteId("mock-a"))?.siteOnline === false, "fleet shows the site offline");
  assert.equal(list.devices.find(d => d.id === remoteId("mock-a")).siteOnline, false);
});

test("rotating the token cuts off the old agent at once and only the new token works", async () => {
  startAgent();
  await until(() => siteLinkHub.isOnline(site.id), { label: "site online" });
  const rotated = await adminApi("POST", `/api/admin/sites/${site.id}/rotate-token`);
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.token, /^pfs_/);
  await until(() => !siteLinkHub.isOnline(site.id), { label: "old agent cut off" });
  await sleep(400);
  assert.equal(siteLinkHub.isOnline(site.id), false, "the old token cannot reconnect");
  token = rotated.body.token;
  startAgent({ agentToken: token });
  await until(() => siteLinkHub.isOnline(site.id), { label: "new token accepted" });
});

test("only a site's own phones can be registered by its agent; a phone id cannot shadow a hub phone", async () => {
  const map = new Map([["mock-1", new MockDevice("mock-1", "Impostor")]]);
  startAgent({ map });
  await until(() => devices.get(remoteId("mock-1")), { label: "namespaced remote phone" });
  assert.notEqual(devices.get("mock-1")?.label, "Impostor", "the hub's own mock-1 is untouched");
  assert.equal(devices.get(remoteId("mock-1")).siteId, site.id);
});

test("operators without a grant for a remote phone cannot open it", async () => {
  startAgent();
  await until(() => devices.get(remoteId("mock-a"))?.status === "idle", { label: "remote simulator ready" });
  const client = await openClient("hub-va"); // only allowed mock-1
  client.send({ type: "select_device", deviceId: remoteId("mock-a") });
  const denied = await client.message(m => m.type === "error" && m.deviceId === remoteId("mock-a"), "denial");
  assert.equal(denied.code, "device_open_denied");
});

test("site administration API: create, list with live status, update, delete removes the phones", async () => {
  const created = await adminApi("POST", "/api/admin/sites", { name: "Rome Studio", timeZone: "Europe/Rome" });
  assert.equal(created.status, 201);
  assert.equal(created.body.site.id, "rome-studio");
  assert.match(created.body.token, /^pfs_/);
  assert.equal(created.body.hubUrl, httpUrl);
  assert.equal("tokenHash" in created.body.site, false);

  const list = await adminApi("GET", "/api/admin/sites");
  const entry = list.body.sites.find(candidate => candidate.id === "rome-studio");
  assert.equal(entry.online, false);
  assert.equal(entry.timeZone, "Europe/Rome");
  assert.equal(list.body.defaultTimeZone, "America/Los_Angeles");

  assert.equal((await adminApi("POST", "/api/admin/sites", { name: "Rome Studio" })).status, 409);
  assert.equal((await adminApi("POST", "/api/admin/sites", { name: "x" })).status, 400);
  assert.equal((await adminApi("PATCH", "/api/admin/sites/rome-studio", { timeZone: "Nowhere/Land" })).status, 400);
  assert.equal((await adminApi("PATCH", "/api/admin/sites/rome-studio", { name: "Rome HQ" })).body.site.name, "Rome HQ");

  const romeAgent = new SiteAgent({ hubUrl: httpUrl, siteId: "rome-studio", token: created.body.token, devices: new Map([["m1", new MockDevice("m1", "Rome sim")]]), reconnectMinMs: 50, summaryIntervalMs: 100 });
  agents.push(romeAgent);
  romeAgent.start();
  await until(() => devices.get("rome-studio__m1"), { label: "Rome phone registered" });
  assert.equal((await adminApi("DELETE", "/api/admin/sites/rome-studio")).status, 200);
  assert.equal(devices.has("rome-studio__m1"), false, "removing a site removes its phones");
  assert.equal((await adminApi("DELETE", "/api/admin/sites/rome-studio")).status, 404);
  const events = auditLog.listEvents().map(event => event.type);
  for (const type of ["site_created", "site_updated", "site_removed"]) assert.ok(events.includes(type), type);
});

test("only an admin may manage sites", async () => {
  const cookie = await loginCookie("hub-va");
  for (const [method, route] of [["GET", "/api/admin/sites"], ["POST", "/api/admin/sites"], ["DELETE", `/api/admin/sites/${site.id}`]]) {
    const res = await fetch(`${httpUrl}${route}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: method === "POST" ? "{}" : undefined });
    assert.equal(res.status, 403, `${method} ${route}`);
  }
});

test("an agent whose hub is down stays alive and retries until the hub appears (the process must not exit)", async () => {
  // Run a real agent process against a port nothing listens on; it must still be running after a while.
  const child = spawn(process.execPath, [path.join(__dirname, "../../src/agentMain.js")], {
    env: { ...process.env, HUB_URL: "http://127.0.0.1:9", SITE_ID: "ghost", SITE_TOKEN: "pfs_x", AUTO_DISCOVER_IOS_DEVICES: "false", DEVICE_CONFIG_PATH: path.join(tmpStorageRoot, "none.json") },
    stdio: "pipe",
  });
  let exited = false;
  child.on("exit", () => { exited = true; });
  await sleep(1800);
  assert.equal(exited, false, "the agent kept running while the hub was unreachable");
  child.kill();
});
