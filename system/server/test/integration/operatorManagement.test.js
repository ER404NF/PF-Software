import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-operator-admin-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "operator-management-test-secret";

const auth = await import("../../src/authStore.js");
auth.createOperatorAccount({
  username: "admin-test",
  password: "admin-password-123",
  role: "admin",
  allowedDevices: null,
  allowedResearchWorkspaces: [],
});
auth.createOperatorAccount({
  username: "manager-test",
  password: "manager-password-123",
  role: "manager",
  allowedDevices: ["mock-1"],
  allowedResearchWorkspaces: [],
});

const { server, wss } = await import("../../src/index.js");

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return response.headers.get("set-cookie").split(";")[0];
}

async function request(baseUrl, url, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timed out waiting for WebSocket message; saw ${JSON.stringify(seen)}`));
    }, timeoutMs);
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      seen.push(message);
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

async function openSocket(address, cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

test("admin user APIs persist safe accounts, enforce role/resource rules, and revoke sessions", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const adminCookie = await login(baseUrl, "admin-test", "admin-password-123");
    const managerCookie = await login(baseUrl, "manager-test", "manager-password-123");

    const forbidden = await request(baseUrl, "/api/admin/users", { cookie: managerCookie });
    assert.equal(forbidden.status, 403);

    const unknownDevice = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie,
      method: "POST",
      body: {
        username: "bad-grant",
        password: "long-enough-password",
        role: "va",
        allowedDevices: ["does-not-exist"],
        allowedResearchWorkspaces: [],
      },
    });
    assert.equal(unknownDevice.status, 400);

    const vaWithoutGrant = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie,
      method: "POST",
      body: {
        username: "no-device-va",
        password: "no-device-va-password",
        role: "va",
        allowedResearchWorkspaces: [],
      },
    });
    assert.equal(vaWithoutGrant.status, 201);
    assert.deepEqual(vaWithoutGrant.body.operator.allowedDevices, []);
    const noDeviceCookie = await login(baseUrl, "no-device-va", "no-device-va-password");
    const noDeviceProfile = await request(baseUrl, "/api/me", { cookie: noDeviceCookie });
    assert.deepEqual(noDeviceProfile.body.allowedDevices, []);

    const granted = await request(baseUrl, "/api/admin/users/no-device-va", {
      cookie: adminCookie,
      method: "PATCH",
      body: { allowedDevices: ["mock-1"] },
    });
    assert.equal(granted.status, 200);
    const vaWs = await openSocket(address, noDeviceCookie);
    const selected = waitForMessage(vaWs,
      message => message.type === "frame" && message.deviceId === "mock-1");
    vaWs.send(JSON.stringify({ type: "select_device", deviceId: "mock-1" }));
    await selected;

    const accessRevoked = waitForMessage(vaWs,
      message => message.type === "error" && message.code === "device_access_revoked");
    const grantProfile = waitForMessage(vaWs,
      message => message.type === "operator_profile" && message.operator?.allowedDevices?.length === 0);
    const grantRemoved = await request(baseUrl, "/api/admin/users/no-device-va", {
      cookie: adminCookie,
      method: "PATCH",
      body: { allowedDevices: [] },
    });
    assert.equal(grantRemoved.status, 200);
    assert.equal((await accessRevoked).deviceId, "mock-1");
    const updatedVaProfile = (await grantProfile).operator;
    assert.equal(updatedVaProfile.role, "va");
    assert.deepEqual(updatedVaProfile.allowedDevices, []);
    assert.equal("passwordHash" in updatedVaProfile, false);

    const managerWs = await openSocket(address, managerCookie);
    const managerSelected = waitForMessage(managerWs,
      message => message.type === "frame" && message.deviceId === "mock-1");
    managerWs.send(JSON.stringify({ type: "select_device", deviceId: "mock-1" }));
    await managerSelected;
    managerWs.close();
    vaWs.close();

    const unrestrictedManager = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie,
      method: "POST",
      body: {
        username: "demotion-target",
        password: "demotion-target-password",
        role: "manager",
        allowedDevices: null,
        allowedResearchWorkspaces: [],
      },
    });
    assert.equal(unrestrictedManager.status, 201);
    assert.equal(unrestrictedManager.body.operator.allowedDevices, null);
    const demotionCookie = await login(baseUrl, "demotion-target", "demotion-target-password");
    const demotionWs = await openSocket(address, demotionCookie);
    const demotionProfile = waitForMessage(demotionWs,
      message => message.type === "operator_profile" && message.operator?.role === "va");
    const demoted = await request(baseUrl, "/api/admin/users/demotion-target", {
      cookie: adminCookie,
      method: "PATCH",
      body: { role: "va" },
    });
    assert.equal(demoted.status, 200);
    assert.deepEqual(demoted.body.operator.allowedDevices, []);
    const liveDemotion = (await demotionProfile).operator;
    assert.deepEqual(liveDemotion.allowedDevices, []);
    assert.equal(liveDemotion.capabilities.includes("queue:manage"), false);
    assert.equal(liveDemotion.capabilities.includes("device:control"), true);
    demotionWs.close();

    const created = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie,
      method: "POST",
      body: {
        username: "new-editor",
        password: "new-editor-password",
        role: "editor",
        allowedDevices: ["mock-1"],
        allowedResearchWorkspaces: [],
      },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.operator, {
      username: "new-editor",
      role: "editor",
      active: true,
      allowedDevices: ["mock-1"],
      allowedResearchWorkspaces: [],
    });
    assert.equal("passwordHash" in created.body.operator, false);
    const persisted = fs.readFileSync(process.env.OPERATORS_CONFIG_PATH, "utf8");
    assert.doesNotMatch(persisted, /new-editor-password/);
    assert.match(persisted, /"passwordHash"/);

    const editorCookie = await login(baseUrl, "new-editor", "new-editor-password");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Cookie: editorCookie } });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const closed = new Promise(resolve => ws.once("close", (code) => resolve(code)));

    const deactivated = await request(baseUrl, "/api/admin/users/new-editor", {
      cookie: adminCookie,
      method: "PATCH",
      body: { active: false },
    });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.operator.active, false);
    assert.equal(await closed, 1008);
    assert.equal((await request(baseUrl, "/api/me", { cookie: editorCookie })).status, 401);
    assert.equal(auth.operatorByUsername("new-editor"), null,
      "deactivated identities must also disappear from background-worker authorization");

    const reactivated = await request(baseUrl, "/api/admin/users/new-editor", {
      cookie: adminCookie,
      method: "PATCH",
      body: { active: true },
    });
    assert.equal(reactivated.status, 200);
    assert.equal((await request(baseUrl, "/api/me", { cookie: editorCookie })).status, 401,
      "reactivation must not resurrect a pre-deactivation session");
    const freshEditorCookie = await login(baseUrl, "new-editor", "new-editor-password");
    assert.equal(auth.operatorByUsername("new-editor")?.role, "editor");

    const revoked = await request(baseUrl, "/api/admin/users/new-editor/revoke-sessions", {
      cookie: adminCookie,
      method: "POST",
    });
    assert.equal(revoked.status, 200);
    assert.equal((await request(baseUrl, "/api/me", { cookie: freshEditorCookie })).status, 401);

    const beforePasswordChange = await login(baseUrl, "new-editor", "new-editor-password");
    const passwordChanged = await request(baseUrl, "/api/admin/users/new-editor", {
      cookie: adminCookie,
      method: "PATCH",
      body: { password: "replacement-password-456" },
    });
    assert.equal(passwordChanged.status, 200);
    assert.equal((await request(baseUrl, "/api/me", { cookie: beforePasswordChange })).status, 401);
    assert.equal((await request(baseUrl, "/api/login", {
      method: "POST",
      body: { username: "new-editor", password: "new-editor-password" },
    })).status, 401);
    await login(baseUrl, "new-editor", "replacement-password-456");

    const lastAdmin = await request(baseUrl, "/api/admin/users/admin-test", {
      cookie: adminCookie,
      method: "PATCH",
      body: { role: "manager" },
    });
    assert.equal(lastAdmin.status, 409);
    assert.match(lastAdmin.body.error, /last active admin/);

    const listed = await request(baseUrl, "/api/admin/users", { cookie: adminCookie });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.users.some(user => "passwordHash" in user), false);
    const editor = listed.body.users.find(user => user.username === "new-editor");
    assert.equal(typeof editor.presence.online, "boolean");
    assert.ok(Array.isArray(editor.assignments));
    assert.ok(Array.isArray(editor.recentAudit));
    assert.doesNotMatch(fs.readFileSync(process.env.OPERATORS_CONFIG_PATH, "utf8"), /replacement-password-456/);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
