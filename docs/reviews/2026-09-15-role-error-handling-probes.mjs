// Run from repository root:
//   node docs/reviews/2026-09-15-role-error-handling-probes.mjs
//   node docs/reviews/2026-09-15-role-error-handling-probes.mjs --serve
// All writes use one disposable OS temporary directory. No physical devices,
// provider APIs, email delivery, or configured application storage are used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "../../system/node_modules/ws/wrapper.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-role-errors-"));
const file = (...parts) => path.join(root, ...parts);
process.env.OPERATORS_CONFIG_PATH = file("operators.json");
process.env.FILE_STORE_DIR = file("media");
process.env.SESSION_STORE_DIR = file("sessions");
process.env.AUDIT_LOG_PATH = file("audit.log");
process.env.QUEUE_STORE_PATH = file("queue.json");
process.env.MODEL_SELECTION_STORE_PATH = file("models.json");
process.env.ASSIGNMENT_STORE_PATH = file("assignments.json");
process.env.RESEARCH_STORE_DIR = file("research");
process.env.RESEARCH_EVIDENCE_DIR = file("evidence");
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = file("notifications.json");
process.env.SESSION_SECRET = "role-error-probe-session-secret-123456789";
process.env.TWO_FACTOR_MASTER_KEY = "role-error-probe-two-factor-key-123456789";
process.env.ACCOUNT_NOTIFICATION_ENCRYPTION_KEY = "role-error-probe-notification-key-123456";
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";
process.env.DEVICE_CONFIG_PATH = file("devices.json");

fs.writeFileSync(process.env.DEVICE_CONFIG_PATH, JSON.stringify({ devices: [{
  id: "mock-1",
  label: "Fail-closed test phone",
  type: "mock",
  hostLabel: "local-fixture",
  network: {
    egress: "cellular-sim",
    simIccid: "8901000000000000999",
    controlIface: "usb",
    failPolicy: "fail-closed",
    checkUrl: "http://127.0.0.1:9/network-check-fixture",
  },
}] }, null, 2));

const auth = await import("../../system/server/src/authStore.js");
const { encryptTotpSecret, recoveryCodeDigest } = await import("../../system/server/src/twoFactor.js");
const password = "Role-fixture-password-123!";
const people = [
  { username: "admin-browser", role: "admin", allowedDevices: null },
  { username: "manager-browser", role: "manager", teamId: "team-a", allowedDevices: ["mock-1"] },
  { username: "va-browser", role: "va", teamId: "team-a", allowedDevices: ["mock-1"] },
  { username: "creator-browser", role: "content_creator", teamId: "team-a", allowedDevices: ["mock-1"] },
  { username: "editor-browser", role: "editor", teamId: "team-a", allowedDevices: ["mock-1"] },
];
for (const person of people) auth.createOperatorAccount({
  ...person,
  password,
  fullName: person.username.replace("-browser", " Test"),
  email: `${person.username.replace("-", "")}@gmail.com`,
  allowedResearchWorkspaces: [],
});
auth.createOperatorAccount({
  username: "two-factor-probe",
  password,
  role: "va",
  allowedDevices: [],
  allowedResearchWorkspaces: [],
  twoFactorRequired: true,
});
const totpSecret = "JBSWY3DPEHPK3PXP";
auth.configureOperatorTwoFactor(
  "two-factor-probe",
  encryptTotpSecret(totpSecret, process.env.TWO_FACTOR_MASTER_KEY),
  Array.from({ length: 5 }, (_, index) => recoveryCodeDigest(`AAAA-BBBB-000${index}`)),
);

const { server, wss, devices, deviceLease } = await import("../../system/server/src/index.js");

function cookieOf(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? null;
}

async function request(baseUrl, pathname, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { /* empty response */ }
  return { status: response.status, body: parsed, cookie: cookieOf(response) ?? cookie };
}

async function login(baseUrl, username, suppliedPassword = password, cookie = null) {
  return request(baseUrl, "/api/login", {
    cookie,
    method: "POST",
    body: { username, password: suppliedPassword },
  });
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), timeoutMs);
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

await new Promise(resolve => server.listen(process.argv.includes("--serve") ? 4188 : 0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

if (process.argv.includes("--serve")) {
  console.log(`Role browser fixture: ${baseUrl}`);
  console.log(`Accounts: ${people.map(person => person.username).join(", ")}`);
  console.log(`Fixture password: ${password}`);
  console.log(`Temporary fixture directory: ${root}`);
} else {
  const results = [];
  try {
    // 1. Password guessing is never throttled, even for one username and IP.
    const guesses = [];
    for (let index = 0; index < 8; index += 1) {
      guesses.push((await login(baseUrl, "admin-browser", `wrong-password-${index}`)).status);
    }
    assert.deepEqual(guesses, Array(8).fill(401));
    results.push(`1 login throttle: ${guesses.length} rapid failures all returned 401; none returned 429`);

    // 2. Re-submitting the correct password resets the per-session 2FA budget.
    let challenge = await login(baseUrl, "two-factor-probe");
    assert.equal(challenge.status, 202);
    for (let index = 0; index < 4; index += 1) {
      const wrong = await request(baseUrl, "/api/2fa/verify", {
        cookie: challenge.cookie,
        method: "POST",
        body: { code: "000000" },
      });
      assert.equal(wrong.status, 401);
    }
    challenge = await login(baseUrl, "two-factor-probe", password, challenge.cookie);
    assert.equal(challenge.status, 202);
    const secondSet = [];
    for (let index = 0; index < 4; index += 1) {
      secondSet.push((await request(baseUrl, "/api/2fa/verify", {
        cookie: challenge.cookie,
        method: "POST",
        body: { code: "000000" },
      })).status);
    }
    assert.deepEqual(secondSet, [401, 401, 401, 401]);
    results.push("2 2FA attempts: four failures + password re-login + four more failures; no lockout");

    // 3. The normal Admin create-user contract silently creates password-only users.
    const admin = await login(baseUrl, "admin-browser");
    assert.equal(admin.status, 200);
    const created = await request(baseUrl, "/api/admin/users", {
      cookie: admin.cookie,
      method: "POST",
      body: {
        fullName: "Created Editor",
        email: "creatededitor@gmail.com",
        username: "created-editor",
        password,
        role: "editor",
        active: true,
        allowedDevices: ["mock-1"],
        allowedResearchWorkspaces: [],
        teamId: "team-a",
      },
    });
    assert.equal(created.status, 201);
    const createdLogin = await login(baseUrl, "created-editor");
    assert.equal(createdLogin.status, 200);
    assert.equal(createdLogin.body.requiresTwoFactor, undefined);
    results.push("3 Admin-created editor: immediate password-only login returned 200, no 2FA challenge");

    // 4. Content Creator and Editor receive assignments but cannot progress them.
    const manager = await login(baseUrl, "manager-browser");
    for (const username of ["creator-browser", "editor-browser"]) {
      const assignment = await request(baseUrl, "/api/assignments", {
        cookie: manager.cookie,
        method: "POST",
        body: { assignee: username, instructions: `Complete fixture work for ${username}` },
      });
      assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
      const worker = await login(baseUrl, username);
      const progress = await request(baseUrl, `/api/assignments/${assignment.body.assignment.id}`, {
        cookie: worker.cookie,
        method: "PATCH",
        body: { status: "in_progress" },
      });
      assert.equal(progress.status, 403);
    }
    results.push("4 assignment progress: Content Creator and Editor both received own work; both got 403 on Start");

    // 5. Anonymous signup has no burst control and durably accepts each unique identity.
    const signups = [];
    for (let index = 0; index < 4; index += 1) {
      signups.push((await request(baseUrl, "/api/signup", {
        method: "POST",
        body: {
          fullName: ["Signup Probe Alpha", "Signup Probe Bravo", "Signup Probe Charlie", "Signup Probe Delta"][index],
          email: `signup.probe.${index}@gmail.com`,
          username: `signup-probe-${index}`,
          password,
          passwordConfirmation: password,
        },
      })).status);
    }
    assert.deepEqual(signups, [201, 201, 201, 201]);
    results.push("5 signup throttle: four rapid anonymous applications all returned 201 and were persisted");

    // 6. A phone action can succeed, then be presented as a phone failure when refresh fails.
    let renderCount = 0;
    let tapCount = 0;
    const partialDevice = {
      id: "partial-action",
      label: "Partial action fixture",
      status: "idle",
      async render() {
        renderCount += 1;
        if (renderCount > 1) throw Object.assign(new Error("fixture screenshot failed"), { code: "ECONNRESET" });
        return { kind: "svg", data: "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>" };
      },
      async tap() { tapCount += 1; },
      async swipe() {},
      async typeText() {},
      async pressHome() {},
    };
    devices.set(partialDevice.id, partialDevice);
    const liveVa = auth.operators.get("va-browser");
    liveVa.allowedDevices.push(partialDevice.id);
    const va = await login(baseUrl, "va-browser");
    const ws = new WebSocket(baseUrl.replace("http", "ws"), { headers: { Cookie: va.cookie } });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const firstFrame = waitForMessage(ws, message => message.type === "frame" && message.deviceId === partialDevice.id);
    ws.send(JSON.stringify({ type: "select_device", deviceId: partialDevice.id }));
    await firstFrame;
    const actionError = waitForMessage(ws, message => message.type === "error" && message.deviceId === partialDevice.id);
    ws.send(JSON.stringify({ type: "tap", deviceId: partialDevice.id, x: 0.5, y: 0.5 }));
    const reported = await actionError;
    assert.equal(tapCount, 1);
    assert.match(reported.message, /Couldn't reach/);
    results.push(`6 partial action: tap calls=${tapCount}; response after refresh failure="${reported.message}"`);
    ws.close();
    devices.delete(partialDevice.id);
    deviceLease.reset();

    // 7. Malformed active/accountStatus values pass startup validation and normalize open.
    const malformed = {
      operators: [{
        username: "malformed-status",
        passwordHash: auth.hashPassword(password),
        role: "va",
        allowedDevices: [],
        active: "false",
        accountStatus: "pendng",
      }],
    };
    assert.doesNotThrow(() => auth.validateOperatorConfig(malformed));
    const savedOperators = [...auth.operators.entries()];
    fs.writeFileSync(process.env.OPERATORS_CONFIG_PATH, JSON.stringify(malformed));
    auth.operators.clear();
    // Re-import with a unique query to execute the actual loader against the malformed file.
    const reloaded = await import(`../../system/server/src/authStore.js?probe=${Date.now()}`);
    assert.equal(reloaded.authenticate("malformed-status", password)?.username, "malformed-status");
    auth.operators.clear();
    for (const [key, value] of savedOperators) auth.operators.set(key, value);
    results.push("7 malformed operator: active=\"false\" + accountStatus=\"pendng\" authenticated as active/approved");

    // 8. Duplicate task IDs in a persisted snapshot dispatch as two active tasks.
    const { createTaskSpec } = await import("../../system/server/src/taskSpec.js");
    const { createTaskQueue } = await import("../../system/server/src/taskQueue.js");
    const queueLease = await import(`../../system/server/src/deviceLease.js`);
    queueLease.reset();
    const duplicateId = "task_duplicate_fixture";
    const first = { ...createTaskSpec({ goal: "first duplicate" }), id: duplicateId };
    const second = { ...createTaskSpec({ goal: "second duplicate" }), id: duplicateId };
    const duplicatePath = file("duplicate-queue.json");
    fs.writeFileSync(duplicatePath, JSON.stringify({ version: 2, paused: false, humanHolds: [], tasks: [first, second] }));
    const queueDevices = new Map([
      ["queue-a", { id: "queue-a", status: "idle" }],
      ["queue-b", { id: "queue-b", status: "idle" }],
    ]);
    const duplicateQueue = createTaskQueue({ devices: queueDevices, deviceLease: queueLease,
      storePath: duplicatePath, dispatchOnCreate: true });
    const duplicateTasks = duplicateQueue.listTasks();
    assert.deepEqual(duplicateTasks.map(task => task.state), ["RUNNING", "RUNNING"]);
    assert.equal(new Set(duplicateTasks.map(task => task.deviceSelector.deviceId)).size, 2);
    results.push("8 duplicate queue ID: two records with one ID both became RUNNING on different phones");
    queueLease.reset();

    // 9-12. Static UI contract checks support the role-surface analysis.
    const clientSource = fs.readFileSync(new URL("../../system/client/app.js", import.meta.url), "utf8");
    const htmlSource = fs.readFileSync(new URL("../../system/client/index.html", import.meta.url), "utf8");
    assert.equal(clientSource.includes("/network-check"), false);
    assert.equal(htmlSource.includes("network-check"), false);
    results.push("9 fail-closed recovery: client contains no /network-check request or network-check control");
    assert.match(clientSource, /currentOperator\?\.role === "va" && assignment\.assignee === currentOperator\.username/);
    results.push("10 assignment UI: own Start/Complete controls are hard-coded to exact role va");
    assert.match(clientSource, /await runAiWorkspaceCommand\(text\);[\s\S]{0,180}aiChatInputEl\.value = ""/);
    results.push("11 AI command failure: chat input is cleared after every attempt, including rejected/unconfirmed commands");
    const researchSource = fs.readFileSync(new URL("../../system/client/research.js", import.meta.url), "utf8");
    assert.match(researchSource, /async function researchFetch[\s\S]{0,120}await fetch/);
    assert.equal(researchSource.includes("requestJson("), false);
    results.push("12 research errors: panel bypasses the shared timeout/typed request handler and parses every response as JSON");

    console.log(results.join("\n"));
    console.log(`Temporary fixture directory: ${root}`);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
