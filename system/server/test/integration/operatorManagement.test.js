import { test, mock } from "node:test";
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
process.env.TWO_FACTOR_MASTER_KEY = "operator-management-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");
const { totpCode, encryptTotpSecret, generateTotpSecret } = await import("../../src/twoFactor.js");
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
  teamId: "team-a",
  allowedDevices: ["mock-1"],
  allowedResearchWorkspaces: [],
});

const { server, wss, taskQueue } = await import("../../src/index.js");
const testTotpSecrets = new Map();

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  if (response.status === 202 && body.requiresTwoFactor && testTotpSecrets.has(username)) {
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const verified = await fetch(`${baseUrl}/api/2fa/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ code: totpCode(testTotpSecrets.get(username)) }),
    });
    assert.equal(verified.status, 200, await verified.text());
    return cookie;
  }
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

async function enrollAndLogin(baseUrl, username, password) {
  const first = await fetch(`${baseUrl}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  assert.equal(first.status, 202);
  assert.equal((await first.json()).requiresTwoFactorSetup, true);
  const cookie = first.headers.get("set-cookie").split(";")[0];
  const setup = await request(baseUrl, "/api/2fa/setup", { cookie, method: "POST" });
  assert.equal(setup.status, 200);
  testTotpSecrets.set(username, setup.body.secret);
  const confirmed = await request(baseUrl, "/api/2fa/confirm", {
    cookie, method: "POST", body: { code: totpCode(setup.body.secret) },
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await request(baseUrl, "/api/2fa/acknowledge-recovery", { cookie, method: "POST" })).status, 200);
  return cookie;
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

    const managerScope = await request(baseUrl, "/api/admin/users", { cookie: managerCookie });
    assert.equal(managerScope.status, 200);
    assert.deepEqual(managerScope.body.users.map(user => user.username), ["manager-test"]);
    assert.deepEqual(managerScope.body.users[0].recentAudit, []);
    assert.equal(managerScope.body.users[0].canRename, false);
    assert.equal(managerScope.body.users[0].canReview, false);
    assert.match(managerScope.body.users[0].actionReason, /currently using/);
    assert.equal((await request(baseUrl, "/api/admin/users/manager-test/2fa/reset", {
      cookie: managerCookie, method: "POST",
    })).status, 403);

    const signup = await request(baseUrl, "/api/signup", {
      method: "POST",
      body: {
        fullName: "New Assistant",
        email: "new.assistant+farm@gmail.com",
        username: "new-assistant",
        password: "new-assistant-password",
        passwordConfirmation: "new-assistant-password",
      },
    });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.operator.accountStatus, "pending");
    assert.equal(signup.body.operator.email, "newassistant@gmail.com");
    assert.equal("passwordHash" in signup.body.operator, false);
    assert.equal((await request(baseUrl, "/api/login", {
      method: "POST", body: { username: "new-assistant", password: "new-assistant-password" },
    })).status, 403);

    const duplicateEmail = await request(baseUrl, "/api/signup", {
      method: "POST",
      body: {
        fullName: "Duplicate Assistant",
        email: "newassistant@gmail.com",
        username: "duplicate-assistant",
        password: "duplicate-password-123",
        passwordConfirmation: "duplicate-password-123",
      },
    });
    assert.equal(duplicateEmail.status, 409);

    const assignedTeam = await request(baseUrl, "/api/admin/users/new-assistant", {
      cookie: adminCookie,
      method: "PATCH",
      body: { teamId: "team-a" },
    });
    assert.equal(assignedTeam.status, 200);
    const scopedAfterAssignment = await request(baseUrl, "/api/admin/users", { cookie: managerCookie });
    assert.deepEqual(scopedAfterAssignment.body.users.map(user => user.username).sort(), ["manager-test", "new-assistant"]);

    const managerCannotMutateGrants = await request(baseUrl, "/api/admin/users/new-assistant", {
      cookie: managerCookie,
      method: "PATCH",
      body: { allowedDevices: ["mock-1"] },
    });
    assert.equal(managerCannotMutateGrants.status, 403);
    assert.equal((await request(baseUrl, "/api/admin/users/manager-test/status", {
      cookie: managerCookie, method: "PATCH", body: { status: "rejected" },
    })).status, 403);

    const originalNotificationRename = fs.renameSync.bind(fs);
    const notificationFailure = mock.method(fs, "renameSync", (from, to) => {
      if (path.resolve(to) === path.resolve(process.env.ACCOUNT_NOTIFICATION_STORE_PATH)) {
        throw new Error("injected notification write failure");
      }
      return originalNotificationRename(from, to);
    });
    let failedReview;
    try {
      failedReview = await request(baseUrl, "/api/admin/users/new-assistant/status", {
        cookie: managerCookie, method: "PATCH", body: { status: "approved" },
      });
    } finally { notificationFailure.mock.restore(); }
    assert.notEqual(failedReview.status, 200);
    assert.equal(auth.listOperatorAccounts().find(item => item.username === "new-assistant").accountStatus, "pending");

    const approved = await request(baseUrl, "/api/admin/users/new-assistant/status", {
      cookie: managerCookie,
      method: "PATCH",
      body: { status: "approved" },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.notification.deliveryState, "awaiting_sender_configuration");

    const firstLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "new-assistant", password: "new-assistant-password" }),
    });
    assert.equal(firstLogin.status, 202);
    assert.equal((await firstLogin.json()).requiresTwoFactorSetup, true);
    const pendingCookie = firstLogin.headers.get("set-cookie").split(";")[0];
    const setup = await request(baseUrl, "/api/2fa/setup", { cookie: pendingCookie, method: "POST" });
    assert.equal(setup.status, 200);
    const confirmed = await request(baseUrl, "/api/2fa/confirm", {
      cookie: pendingCookie,
      method: "POST",
      body: { code: totpCode(setup.body.secret) },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.recoveryCodes.length, 10);
    assert.equal("email" in confirmed.body.operator, false);
    assert.equal("twoFactorSecret" in confirmed.body.operator, false);
    assert.equal((await request(baseUrl, "/api/me", { cookie: pendingCookie })).status, 401);
    const receipt = await request(baseUrl, "/api/2fa/recovery-receipt", { cookie: pendingCookie });
    assert.equal(receipt.status, 200);
    assert.deepEqual(receipt.body.recoveryCodes, confirmed.body.recoveryCodes);
    assert.equal((await request(baseUrl, "/api/2fa/acknowledge-recovery", {
      cookie: pendingCookie, method: "POST",
    })).status, 200);
    assert.equal((await request(baseUrl, "/api/2fa/recovery-receipt", { cookie: pendingCookie })).status, 401);
    assert.equal((await request(baseUrl, "/api/me", { cookie: pendingCookie })).status, 200);

    auth.createOperatorAccount({ username: "two-factor-budget", password: "two-factor-budget-password",
      role: "va", allowedDevices: [], allowedResearchWorkspaces: [], twoFactorRequired: true });
    auth.configureOperatorTwoFactor("two-factor-budget",
      encryptTotpSecret(generateTotpSecret(), process.env.TWO_FACTOR_MASTER_KEY), Array(5).fill("unused-test-digest"));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const passwordStep = await fetch(`${baseUrl}/api/login`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "two-factor-budget", password: "two-factor-budget-password" }) });
      assert.equal(passwordStep.status, 202, `password challenge ${attempt}`);
      const challengeCookie = passwordStep.headers.get("set-cookie").split(";")[0];
      const rejectedCode = await request(baseUrl, "/api/2fa/verify", {
        cookie: challengeCookie, method: "POST", body: { code: "000000" },
      });
      assert.equal(rejectedCode.status, attempt === 5 ? 429 : 401, JSON.stringify(rejectedCode.body));
    }
    const exhaustedChallenge = await fetch(`${baseUrl}/api/login`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "two-factor-budget", password: "two-factor-budget-password" }) });
    assert.equal(exhaustedChallenge.status, 429, "a fresh password challenge cannot reset the 2FA budget");

    await request(baseUrl, "/api/logout", { cookie: pendingCookie, method: "POST" });
    const secondLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "new-assistant", password: "new-assistant-password" }),
    });
    assert.equal(secondLogin.status, 202);
    assert.equal((await secondLogin.json()).requiresTwoFactor, true);
    const verifyCookie = secondLogin.headers.get("set-cookie").split(";")[0];
    const verified = await request(baseUrl, "/api/2fa/verify", {
      cookie: verifyCookie, method: "POST", body: { code: totpCode(setup.body.secret) },
    });
    assert.equal(verified.status, 200);

    const ownedTask = taskQueue.addTask({ goal: "survive username rename", createdBy: "new-assistant",
      earliestStart: "2035-01-01T00:00:00.000Z", latestEnd: "2035-01-01T01:00:00.000Z" });
    const originalRename = fs.renameSync.bind(fs);
    const failedWrite = mock.method(fs, "renameSync", (from, to) => {
      if (path.resolve(to) === path.resolve(process.env.OPERATORS_CONFIG_PATH)) {
        throw new Error("injected operator rename write failure");
      }
      return originalRename(from, to);
    });
    let failedRename;
    try {
      failedRename = await request(baseUrl, "/api/admin/users/new-assistant/rename", {
        cookie: managerCookie, method: "PATCH", body: { username: "failed-rename" },
      });
    } finally { failedWrite.mock.restore(); }
    assert.notEqual(failedRename.status, 200);
    assert.ok(auth.operatorByUsername("new-assistant"));
    assert.equal(auth.operatorByUsername("failed-rename"), null);
    assert.equal(taskQueue.getTask(ownedTask.id).createdBy, "new-assistant");
    const renamed = await request(baseUrl, "/api/admin/users/new-assistant/rename", {
      cookie: managerCookie, method: "PATCH", body: { username: "assistant-renamed" },
    });
    assert.equal(renamed.status, 200);
    assert.equal(taskQueue.getTask(ownedTask.id).createdBy, "assistant-renamed");
    assert.equal((await request(baseUrl, "/api/me", { cookie: verifyCookie })).status, 401);
    assert.equal((await request(baseUrl, "/api/admin/users/manager-test/rename", {
      cookie: managerCookie, method: "PATCH", body: { username: "manager-self-renamed" },
    })).status, 403);

    const recoveryRequested = await request(baseUrl, "/api/recovery/request", {
      method: "POST", body: { identifier: "assistant-renamed" },
    });
    assert.equal(recoveryRequested.status, 200);
    const notificationList = await request(baseUrl, "/api/admin/account-notifications", { cookie: adminCookie });
    assert.equal(notificationList.status, 200);
    assert.equal(notificationList.body.notifications.some(item => "body" in item), false);
    assert.equal(notificationList.body.notifications.some(item => item.kind === "account_recovery"), true);
    const notificationStore = JSON.parse(fs.readFileSync(process.env.ACCOUNT_NOTIFICATION_STORE_PATH, "utf8"));
    const persistedRecovery = notificationStore.notifications.find(item => item.kind === "account_recovery");
    assert.equal("body" in persistedRecovery, false);
    assert.ok(persistedRecovery.securePayload);
    assert.doesNotMatch(fs.readFileSync(process.env.ACCOUNT_NOTIFICATION_STORE_PATH, "utf8"), /use this one-time recovery token/);
    auth.resetOperatorSecondFactor("assistant-renamed");
    const recoveryToken = auth.createEmailRecoveryToken("assistant-renamed").token;
    const retainedRecovery = auth.createEmailRecoveryToken("assistant-renamed");
    assert.equal(retainedRecovery.reused, true);
    assert.equal(retainedRecovery.token, null);
    const recovered = await request(baseUrl, "/api/recovery/complete", {
      method: "POST",
      body: {
        token: recoveryToken,
        password: "recovered-password-456",
        passwordConfirmation: "recovered-password-456",
      },
    });
    assert.equal(recovered.status, 200);
    const afterRecoveryLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "assistant-renamed", password: "recovered-password-456" }),
    });
    assert.equal(afterRecoveryLogin.status, 202);
    assert.equal((await afterRecoveryLogin.json()).requiresTwoFactorSetup, true);
    const recoveryLoginCookie = afterRecoveryLogin.headers.get("set-cookie").split(";")[0];
    assert.equal((await request(baseUrl, "/api/2fa/setup", { cookie: recoveryLoginCookie, method: "POST" })).status, 200);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const invalid = await request(baseUrl, "/api/2fa/confirm", {
        cookie: recoveryLoginCookie, method: "POST", body: { code: "invalid" },
      });
      assert.equal(invalid.status, attempt === 5 ? 429 : 401);
    }
    assert.equal((await request(baseUrl, "/api/2fa/setup", { cookie: recoveryLoginCookie, method: "POST" })).status, 401);

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
    const noDeviceCookie = await enrollAndLogin(baseUrl, "no-device-va", "no-device-va-password");
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
        teamId: "team-b",
        allowedDevices: null,
        allowedResearchWorkspaces: [],
      },
    });
    assert.equal(unrestrictedManager.status, 201);
    assert.equal(unrestrictedManager.body.operator.allowedDevices, null);
    const demotionCookie = await enrollAndLogin(baseUrl, "demotion-target", "demotion-target-password");
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
      twoFactorRequired: true,
      twoFactorEnabled: false,
      recoveryMethods: ["authenticator", "recovery_codes", "email", "admin_assisted"],
    });
    assert.equal("passwordHash" in created.body.operator, false);
    const persisted = fs.readFileSync(process.env.OPERATORS_CONFIG_PATH, "utf8");
    assert.doesNotMatch(persisted, /new-editor-password/);
    assert.match(persisted, /"passwordHash"/);

    const editorCookie = await enrollAndLogin(baseUrl, "new-editor", "new-editor-password");
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
      body: { role: "manager", teamId: "team-a" },
    });
    assert.equal(lastAdmin.status, 409);
    assert.match(lastAdmin.body.error, /last active admin/);

    const selfRejected = await request(baseUrl, "/api/admin/users/admin-test/status", {
      cookie: adminCookie,
      method: "PATCH",
      body: { status: "rejected" },
    });
    assert.equal(selfRejected.status, 403);
    assert.match(selfRejected.body.error, /account you are currently using/);
    assert.equal((await request(baseUrl, "/api/me", { cookie: adminCookie })).status, 200,
      "a rejected self-review request must leave the current session valid");

    const listedBeforeSecondAdmin = await request(baseUrl, "/api/admin/users", { cookie: adminCookie });
    const ownAdminCard = listedBeforeSecondAdmin.body.users.find(user => user.username === "admin-test");
    assert.equal(ownAdminCard.canReview, false);
    assert.match(ownAdminCard.actionReason, /currently using/);

    const secondAdmin = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie,
      method: "POST",
      body: {
        username: "second-admin",
        password: "second-admin-password",
        fullName: "Second Admin",
        email: "second.admin@gmail.com",
        role: "admin",
        allowedDevices: null,
        allowedResearchWorkspaces: [],
      },
    });
    assert.equal(secondAdmin.status, 201);
    const secondAdminRejected = await request(baseUrl, "/api/admin/users/second-admin/status", {
      cookie: adminCookie,
      method: "PATCH",
      body: { status: "rejected" },
    });
    assert.equal(secondAdminRejected.status, 200,
      "an admin may reject another admin when a second active admin remains");
    assert.equal((await request(baseUrl, "/api/me", { cookie: adminCookie })).status, 200);
    assert.throws(() => auth.setOperatorAccountStatus("admin-test", "rejected"), /last active admin/);
    assert.equal((await request(baseUrl, "/api/me", { cookie: adminCookie })).status, 200,
      "last-admin rejection must leave the account and its sessions unchanged");

    auth.createSignupAccount({ username: "expired-signup", password: "expired-signup-password",
      passwordConfirmation: "expired-signup-password", fullName: "Expired Signup", email: "expired.signup@gmail.com" });
    const signupConfig = JSON.parse(fs.readFileSync(process.env.OPERATORS_CONFIG_PATH, "utf8"));
    signupConfig.operators.find(item => item.username === "expired-signup").signupSubmittedAt = "2020-01-01T00:00:00.000Z";
    fs.writeFileSync(process.env.OPERATORS_CONFIG_PATH, JSON.stringify(signupConfig));
    const pruned = auth.prunePendingSignupAccounts({ maxAgeMs: 1_000, maxPending: 500, now: Date.now() });
    assert.ok(pruned.pruned >= 1);
    assert.equal(auth.listOperatorAccounts().some(item => item.username === "expired-signup"), false);

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
