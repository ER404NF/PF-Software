import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-account-post-commit-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "account-post-commit-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "account-post-commit-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "notifications.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");
const { totpCode } = await import("../../src/twoFactor.js");
auth.createOperatorAccount({
  username: "admin-test", password: "admin-test-password-123", role: "admin",
  allowedDevices: null, allowedResearchWorkspaces: [], twoFactorRequired: false,
});
auth.createOperatorAccount({
  username: "post-commit-target", password: "post-commit-target-password-123", role: "va",
  allowedDevices: [], allowedResearchWorkspaces: [], twoFactorRequired: false,
});
auth.createOperatorAccount({
  username: "denied-self-target", password: "denied-self-target-password-123", role: "va",
  allowedDevices: [], allowedResearchWorkspaces: [], twoFactorRequired: false,
});

const { server, wss, auditLog } = await import("../../src/index.js");

async function request(baseUrl, url, { cookie, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function login(baseUrl, username, password) {
  const response = await request(baseUrl, "/api/login", { method: "POST", body: { username, password } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.headers.get("set-cookie").split(";")[0];
}

test("committed account mutations remain successful and enforce revocation when audit storage fails", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalAuditWrite = auditLog.logEvent;
  try {
    const adminCookie = await login(baseUrl, "admin-test", "admin-test-password-123");
    const targetCookie = await login(baseUrl, "post-commit-target", "post-commit-target-password-123");
    const deniedSelfCookie = await login(baseUrl, "denied-self-target", "denied-self-target-password-123");
    auditLog.logEvent = () => { throw new Error("injected account audit failure"); };

    const deniedSelfEscalation = await request(baseUrl, "/api/admin/users/denied-self-target/status", {
      cookie: deniedSelfCookie, method: "PATCH", body: { status: "approved" },
    });
    assert.equal(deniedSelfEscalation.status, 403, "audit failure must not replace a capability denial");
    assert.equal(auth.operators.get("denied-self-target").active, false,
      "self-escalation response must still deactivate the caller during an audit outage");
    assert.equal((await request(baseUrl, "/api/me", { cookie: deniedSelfCookie })).status, 401);

    const created = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie, method: "POST",
      body: {
        username: "created-during-audit-outage", password: "created-during-audit-outage-123",
        role: "va", allowedDevices: [], allowedResearchWorkspaces: [],
      },
    });
    assert.equal(created.status, 201);

    const brokenBroadcastClient = {
      OPEN: 1,
      readyState: 1,
      currentOperator: () => auth.operators.get("admin-test"),
      releaseUnauthorizedWatch() {},
      send() { throw new Error("injected stale WebSocket send failure"); },
    };
    wss.clients.add(brokenBroadcastClient);
    try {
      const createdWithBrokenPeer = await request(baseUrl, "/api/admin/users", {
        cookie: adminCookie, method: "POST",
        body: {
          username: "created-during-broadcast-outage", password: "created-during-broadcast-outage-123",
          role: "va", allowedDevices: [], allowedResearchWorkspaces: [],
        },
      });
      assert.equal(createdWithBrokenPeer.status, 201,
        "a stale WebSocket peer must not make a committed account creation look failed");
    } finally {
      wss.clients.delete(brokenBroadcastClient);
    }

    const updated = await request(baseUrl, "/api/admin/users/post-commit-target", {
      cookie: adminCookie, method: "PATCH", body: { fullName: "Updated Target" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.operator.fullName, "Updated Target");

    const revoked = await request(baseUrl, "/api/admin/users/post-commit-target/revoke-sessions", {
      cookie: adminCookie, method: "POST",
    });
    assert.equal(revoked.status, 200);
    assert.equal((await request(baseUrl, "/api/me", { cookie: targetCookie })).status, 401);

    const reset = await request(baseUrl, "/api/admin/users/post-commit-target/2fa/reset", {
      cookie: adminCookie, method: "POST",
    });
    assert.equal(reset.status, 200);
    assert.equal(auth.operators.get("post-commit-target").twoFactorRequired, true);

    const rejectedLogin = await request(baseUrl, "/api/login", {
      method: "POST", body: { username: "post-commit-target", password: "wrong-password" },
    });
    assert.equal(rejectedLogin.status, 401, "audit failure must not replace an authentication rejection");

    const crossOrigin = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie, method: "POST", headers: { Origin: "https://attacker.invalid" },
      body: {
        username: "must-not-be-created", password: "must-not-be-created-password-123",
        role: "va", allowedDevices: [], allowedResearchWorkspaces: [],
      },
    });
    assert.equal(crossOrigin.status, 403, "audit failure must not replace the CSRF rejection");
    assert.equal(auth.operators.has("must-not-be-created"), false);

    const pendingTwoFactor = await request(baseUrl, "/api/login", {
      method: "POST",
      body: { username: "post-commit-target", password: "post-commit-target-password-123" },
    });
    assert.equal(pendingTwoFactor.status, 202);
    const enrollmentCookie = pendingTwoFactor.headers.get("set-cookie").split(";")[0];
    const setup = await request(baseUrl, "/api/2fa/setup", { cookie: enrollmentCookie, method: "POST" });
    assert.equal(setup.status, 200);
    const confirmed = await request(baseUrl, "/api/2fa/confirm", {
      cookie: enrollmentCookie, method: "POST", body: { code: totpCode(setup.body.secret) },
    });
    assert.equal(confirmed.status, 200, "committed two-factor enrollment must survive an audit outage");
    const acknowledged = await request(baseUrl, "/api/2fa/acknowledge-recovery", {
      cookie: enrollmentCookie, method: "POST",
    });
    assert.equal(acknowledged.status, 200, "recovery-code acknowledgement must survive an audit outage");

    await request(baseUrl, "/api/logout", { cookie: enrollmentCookie, method: "POST" });
    const secondFactorLogin = await request(baseUrl, "/api/login", {
      method: "POST",
      body: { username: "post-commit-target", password: "post-commit-target-password-123" },
    });
    assert.equal(secondFactorLogin.status, 202);
    const verificationCookie = secondFactorLogin.headers.get("set-cookie").split(";")[0];
    const invalidSecondFactorStatuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      invalidSecondFactorStatuses.push((await request(baseUrl, "/api/2fa/verify", {
        cookie: verificationCookie, method: "POST", body: { code: "000000" },
      })).status);
    }
    assert.deepEqual(invalidSecondFactorStatuses, [401, 401, 401, 401, 429]);

    const invalidLoginStatuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      invalidLoginStatuses.push((await request(baseUrl, "/api/login", {
        method: "POST", body: { username: "unknown-during-audit-outage", password: "wrong-password" },
      })).status);
    }
    assert.deepEqual(invalidLoginStatuses, [401, 401, 401, 401, 429, 429]);

    const logout = await request(baseUrl, "/api/logout", { cookie: adminCookie, method: "POST" });
    assert.equal(logout.status, 200, "logout must survive an audit outage after destroying the session");
    assert.equal((await request(baseUrl, "/api/me", { cookie: adminCookie })).status, 401);
  } finally {
    auditLog.logEvent = originalAuditWrite;
    server.close();
  }
});
