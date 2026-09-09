import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

function option(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${prefix}<number> is required`);
  return value;
}

const deviceCount = option("devices", 5);
const durationSec = option("duration-sec", 30 * 60);
const actionsPerSec = option("actions-per-sec", 2);
const maxErrorRate = option("max-error-rate", 0.01);
const maxHeapGrowthMb = option("max-heap-growth-mb", 64);
if (!Number.isInteger(deviceCount) || deviceCount < 1 || deviceCount > 100) throw new Error("--devices must be an integer from 1 to 100");
if (!(durationSec > 0 && actionsPerSec > 0)) throw new Error("duration and action rate must be positive");
if (!(maxErrorRate >= 0 && maxErrorRate <= 1)) throw new Error("--max-error-rate must be from 0 to 1");
if (maxHeapGrowthMb < 0) throw new Error("--max-heap-growth-mb must be non-negative");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-soak-"));
process.env.SESSION_STORE_DIR = path.join(temporaryRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(temporaryRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(temporaryRoot, "tasks.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(temporaryRoot, "models.json");
process.env.RESEARCH_STORE_DIR = path.join(temporaryRoot, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(temporaryRoot, "evidence");
process.env.SESSION_SECRET = "phone-farm-local-soak-fixture";

const [{ server, wss, devices, heartbeatTimer }, { operators, hashPassword }, { MockDevice }] = await Promise.all([
  import("../src/index.js"),
  import("../src/authStore.js"),
  import("../src/mockDevice.js"),
]);

const username = "local-soak-admin";
const password = "local-soak-password";
const deviceIds = Array.from({ length: deviceCount }, (_, index) => `soak-${index + 1}`);
for (const id of deviceIds) devices.set(id, new MockDevice(id, `Soak device ${id}`));
operators.set(username, {
  username,
  passwordHash: hashPassword(password),
  allowedDevices: deviceIds,
  allowedResearchWorkspaces: [],
  role: "admin",
});

let attempts = 0;
let errors = 0;
const clients = [];

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for relay response"));
    }, timeoutMs);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    }
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

async function connect(url, cookie, deviceId) {
  const ws = new WebSocket(url, { headers: { Cookie: cookie } });
  clients.push(ws);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const firstFrame = waitForMessage(ws, (message) => message.type === "frame" && message.deviceId === deviceId);
  ws.send(JSON.stringify({ type: "select_device", deviceId }));
  await firstFrame;
  return ws;
}

async function drive(ws, deviceId, deadline) {
  const pauseMs = Math.max(1, Math.floor(1000 / actionsPerSec));
  let sequence = 0;
  while (Date.now() < deadline) {
    const action = sequence % 3 === 0
      ? { type: "tap", x: 70 / 375, y: 120 / 667 }
      : sequence % 3 === 1 ? { type: "swipe", direction: "up" } : { type: "home" };
    attempts += 1;
    try {
      const response = waitForMessage(ws, (message) =>
        (message.type === "frame" || message.type === "error") && message.deviceId === deviceId);
      ws.send(JSON.stringify(action));
      const message = await response;
      if (message.type === "error") errors += 1;
    } catch {
      errors += 1;
    }
    sequence += 1;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}

let result;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const httpUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${httpUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) throw new Error(`soak login failed: HTTP ${login.status}`);
  await login.json();
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("soak login returned no session cookie");

  const wsUrl = `ws://127.0.0.1:${server.address().port}`;
  const connected = await Promise.all(deviceIds.map((id) => connect(wsUrl, cookie, id)));
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = new Date();
  const deadline = Date.now() + durationSec * 1000;
  await Promise.all(connected.map((ws, index) => drive(ws, deviceIds[index], deadline)));
  const heapAfter = process.memoryUsage().heapUsed;
  const errorRate = attempts ? errors / attempts : 1;
  const heapGrowthMb = (heapAfter - heapBefore) / (1024 * 1024);
  result = {
    passed: errorRate <= maxErrorRate && heapGrowthMb <= maxHeapGrowthMb,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    devices: deviceCount,
    durationSec,
    attempts,
    errors,
    errorRate,
    heapGrowthMb: Number(heapGrowthMb.toFixed(2)),
    thresholds: { maxErrorRate, maxHeapGrowthMb },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  for (const ws of clients) ws.terminate();
  clearInterval(heartbeatTimer);
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  for (const id of deviceIds) devices.delete(id);
  operators.delete(username);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

if (!result?.passed) process.exitCode = 1;
