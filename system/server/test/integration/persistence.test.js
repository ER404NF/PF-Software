// The actual MS4 testing-gate scenario: kill and restart the relay as a real
// process (not an in-process import — a real restart, since that's the
// thing being proven) and confirm state reconciles sanely across it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { hashPassword } from "../../src/authStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, "../../src/index.js");

let tmpDir;
let env;
let child;
let baseUrl;

// The first start asks the OS for an ephemeral port (PORT=0) rather than
// using a fixed one — a fixed port here previously caused real, if
// infrequent, flakiness from lingering TIME_WAIT sockets under many rapid
// `npm test` runs in a row. The restart deliberately reuses that exact same
// port explicitly (not 0 again) — landing on the same port after restarting
// is the actual thing this test is proving, so it can't be left to chance.
function startRelay(port = 0) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [indexPath], { env: { ...env, PORT: String(port) }, stdio: "pipe" });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/running at http:\/\/localhost:(\d+)/);
      if (match) {
        proc.stdout.off("data", onData);
        resolve({ proc, port: Number(match[1]) });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("error", reject);
  });
}

async function waitForReady(retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/me`);
      if (res.status === 401) return; // server is up and answering, just not logged in yet
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay did not become ready in time");
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-persistence-"));
  const operatorsConfigPath = path.join(tmpDir, "operators.config.json");
  fs.writeFileSync(
    operatorsConfigPath,
    JSON.stringify({
      operators: [{ username: "restart-va", passwordHash: hashPassword("restart-pass"), allowedDevices: null, role: "admin" }],
    })
  );

  env = {
    ...process.env,
    OPERATORS_CONFIG_PATH: operatorsConfigPath,
    SESSION_STORE_DIR: path.join(tmpDir, "sessions"),
    AUDIT_LOG_PATH: path.join(tmpDir, "audit.log"),
    SESSION_SECRET: "fixed-test-secret-for-this-run",
  };
});

after(() => {
  if (child) child.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a session and the audit log both survive a real relay restart", async () => {
  const first = await startRelay(0);
  child = first.proc;
  baseUrl = `http://127.0.0.1:${first.port}`;
  await waitForReady();

  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "restart-va", password: "restart-pass" }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get("set-cookie").split(";")[0];
  // fetch() resolves once headers arrive, but the session write to disk is
  // only guaranteed complete once the body is too (see client/app.js's login
  // handler for the full explanation) — matters even more here than usual,
  // since this test's whole point is proving that exact write survived.
  await loginRes.json();

  const meBefore = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(meBefore.status, 200);

  const auditBefore = await fetch(`${baseUrl}/api/audit`, { headers: { Cookie: cookie } });
  const { events: eventsBefore } = await auditBefore.json();
  assert.ok(eventsBefore.some((e) => e.type === "login_success" && e.operator === "restart-va"));

  // The actual restart — explicitly back on the exact same port, which is
  // the scenario this test exists to prove works.
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  const second = await startRelay(first.port);
  child = second.proc;
  await waitForReady();

  // Same cookie, new process — this only works because sessions are file-
  // backed (FileSessionStore), not express-session's default in-memory store.
  const meAfter = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(meAfter.status, 200);
  const profile = await meAfter.json();
  assert.equal(profile.username, "restart-va");
  assert.equal(profile.role, "admin");
  assert.equal(profile.allowedDevices, null);
  assert.ok(profile.capabilities.includes("security:manage"));

  // The pre-restart login event is still there — the audit file wasn't
  // truncated or replaced by the new process starting up.
  const auditAfter = await fetch(`${baseUrl}/api/audit`, { headers: { Cookie: cookie } });
  const { events: eventsAfter } = await auditAfter.json();
  assert.ok(eventsAfter.some((e) => e.type === "login_success" && e.operator === "restart-va"));
  assert.ok(eventsAfter.length >= eventsBefore.length);

  // Devices reset to idle on a fresh process — correct, not a bug: a restart
  // drops every WebSocket connection along with it, so there is no dangling
  // "in-use" claim to incorrectly preserve or incorrectly lose.
  const filesRes = await fetch(`${baseUrl}/api/devices/mock-1/files`, { headers: { Cookie: cookie } });
  assert.equal(filesRes.status, 200);
});
