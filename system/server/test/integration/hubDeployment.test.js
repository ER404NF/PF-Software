import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "../../src/index.js");

// Starts the server the way deploy/hub/Dockerfile does: a public https address, a real
// session secret, no mock phones, phones only from sites. If this stops booting, the
// container would crash-loop too.
function startHub(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-hub-"));
  const config = path.join(dir, "config");
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, "operators.config.json"), '{"operators":[]}');
  fs.writeFileSync(path.join(config, "devices.config.json"), '{"devices":[]}');
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      PUBLIC_BASE_URL: "https://phones.example.com",
      SESSION_SECRET: "s".repeat(48),
      AUTO_DISCOVER_IOS_DEVICES: "false",
      OPERATORS_CONFIG_PATH: path.join(config, "operators.config.json"),
      DEVICE_CONFIG_PATH: path.join(config, "devices.config.json"),
      FILE_STORE_DIR: path.join(dir, "storage"),
      SESSION_STORE_DIR: path.join(dir, "sessions"),
      AUDIT_LOG_PATH: path.join(dir, "audit.log"),
      QUEUE_STORE_PATH: path.join(dir, "tasks.json"),
      MODEL_SELECTION_STORE_PATH: path.join(dir, "models.json"),
      ASSIGNMENT_STORE_PATH: path.join(dir, "assignments.json"),
      SITE_STORE_PATH: path.join(dir, "sites.json"),
      ...extraEnv,
    },
    stdio: "pipe",
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hub did not start:\n${output}`)), 15000);
    const check = setInterval(() => {
      const match = output.match(/running at http:\/\/[^:]+:(\d+)/);
      if (match) { clearTimeout(timer); clearInterval(check); resolve(Number(match[1])); }
    }, 50);
    child.on("exit", code => { clearTimeout(timer); clearInterval(check); reject(new Error(`hub exited (${code}):\n${output}`)); });
  });
  return { child, ready, dir, output: () => output };
}

test("the hub boots in the production configuration the container uses and answers its health probe", async () => {
  const hub = startHub();
  try {
    const port = await hub.ready;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    // Nothing else is reachable without signing in.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/admin/sites`)).status, 401);
    // The login page and PWA files are public.
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    const manifest = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type"), /json/);
    assert.equal((await manifest.json()).display, "standalone");
    const worker = await fetch(`http://127.0.0.1:${port}/sw.js`);
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/icons/icon-192.png`)).headers.get("content-type"), "image/png");
  } finally {
    hub.child.kill();
    fs.rmSync(hub.dir, { recursive: true, force: true });
  }
});

test("the hub refuses to start with a weak session secret or without one", async () => {
  for (const secret of ["short", ""]) {
    const hub = startHub({ SESSION_SECRET: secret });
    await assert.rejects(hub.ready, /SESSION_SECRET/, `secret ${JSON.stringify(secret)}`);
    fs.rmSync(hub.dir, { recursive: true, force: true });
  }
});

test("the hub refuses to listen publicly without HTTPS cookies", async () => {
  const hub = startHub({ HOST: "0.0.0.0", PUBLIC_BASE_URL: "http://phones.example.com" });
  await assert.rejects(hub.ready, /HTTPS cookie/);
  fs.rmSync(hub.dir, { recursive: true, force: true });
});

test("an agent's site link works against a hub started this way (token auth, no operator session needed)", async () => {
  const hub = startHub();
  try {
    const port = await hub.ready;
    const { WebSocket } = await import("ws");
    const status = await new Promise(resolve => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/agent-link`, { headers: { "x-site-id": "nobody", authorization: "Bearer pfs_nope" } });
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode));
      socket.on("open", () => resolve("opened"));
      socket.on("error", () => {});
    });
    assert.equal(status, 401, "an unknown site is refused at the door, not treated as an operator");
  } finally {
    hub.child.kill();
    fs.rmSync(hub.dir, { recursive: true, force: true });
  }
});
