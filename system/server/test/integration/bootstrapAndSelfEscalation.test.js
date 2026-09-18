// Covers two related, deliberately strict behaviors added alongside the
// downloadable-app work:
//   1. POST /api/setup/create-admin only ever works from loopback, only
//      while zero approved admins exist, and permanently 404s afterward.
//   2. Any authenticated operator caught targeting their OWN account on an
//      admin-only account route (or hitting the bootstrap endpoint after
//      lockout) is force-deactivated, force-signed-out, and the reason is
//      recorded — not just handed an ordinary 403.
// This file starts with zero operators configured (unlike
// operatorManagement.test.js, which seeds an admin at module load) so the
// "no admin yet" bootstrap window can actually be exercised.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-bootstrap-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "bootstrap-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "bootstrap-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");
const { totpCode } = await import("../../src/twoFactor.js");
const { server, isLoopbackAddress } = await import("../../src/index.js");

async function request(baseUrl, url, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

// Every operator created through the admin/bootstrap paths below requires
// 2FA enrollment on first login (twoFactorRequired defaults true) — mirrors
// operatorManagement.test.js's enrollAndLogin.
async function login(baseUrl, username, password) {
  const first = await request(baseUrl, "/api/login", { method: "POST", body: { username, password } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(first.body.requiresTwoFactorSetup, true);
  const cookie = first.headers.get("set-cookie").split(";")[0];
  const setup = await request(baseUrl, "/api/2fa/setup", { cookie, method: "POST" });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const confirmed = await request(baseUrl, "/api/2fa/confirm", {
    cookie, method: "POST", body: { code: totpCode(setup.body.secret) },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal((await request(baseUrl, "/api/2fa/acknowledge-recovery", { cookie, method: "POST" })).status, 200);
  return cookie;
}

test("isLoopbackAddress recognizes only loopback forms", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("localhost"), true);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
  assert.equal(isLoopbackAddress("203.0.113.9"), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(null), false);
});

test("flagAndDeactivateOperator deactivates, records the reason, and forces sign-out", () => {
  auth.createOperatorAccount({
    username: "flag-target", password: "flag-target-password-123", role: "va", allowedDevices: [],
  });
  try {
    const before = auth.operators.get("flag-target");
    const result = auth.flagAndDeactivateOperator("flag-target", "test reason");
    assert.equal(result.securityFlagReason, "test reason");
    assert.ok(result.securityFlaggedAt);
    const after = auth.operators.get("flag-target");
    assert.equal(after.active, false);
    assert.equal(after.authVersion, before.authVersion + 1);
    assert.equal(auth.flagAndDeactivateOperator("does-not-exist", "x"), null);
  } finally {
    // No delete helper exists for this store; leave the account deactivated
    // for the rest of this suite (harmless, isolated temp config).
  }
});

test("bootstrap creates the first admin, then locks out; self-escalation attempts are flagged and force-signed-out", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(auth.listOperatorAccounts().some(u => u.role === "admin"), false);

    const created = await request(baseUrl, "/api/setup/create-admin", {
      method: "POST",
      body: { username: "host-admin", password: "host-admin-password-123" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.operator.role, "admin");

    const lockedOut = await request(baseUrl, "/api/setup/create-admin", {
      method: "POST",
      body: { username: "second-admin", password: "second-admin-password-123" },
    });
    assert.equal(lockedOut.status, 404);

    const adminCookie = await login(baseUrl, "host-admin", "host-admin-password-123");

    // A non-admin trying to hit the account-management route to promote
    // themselves must be flagged/deactivated/signed-out, not just 403'd.
    const escalator = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie, method: "POST",
      body: { username: "escalator", password: "escalator-password-123", role: "va", allowedDevices: [] },
    });
    assert.equal(escalator.status, 201);
    const escalatorCookie = await login(baseUrl, "escalator", "escalator-password-123");

    const selfPromote = await request(baseUrl, "/api/admin/users/escalator", {
      cookie: escalatorCookie, method: "PATCH", body: { role: "admin" },
    });
    assert.equal(selfPromote.status, 403);
    const flaggedEscalator = auth.operators.get("escalator");
    assert.equal(flaggedEscalator.active, false);
    assert.match(flaggedEscalator.securityFlagReason, /own account/);

    // The same cookie must now be dead — deactivation forced a sign-out.
    const afterFlag = await request(baseUrl, "/api/me", { cookie: escalatorCookie });
    assert.equal(afterFlag.status, 401);

    // Escalating someone ELSE's account (not self) is an ordinary 403, no flag.
    const secondVa = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie, method: "POST",
      body: { username: "bystander", password: "bystander-password-123", role: "va", allowedDevices: [] },
    });
    assert.equal(secondVa.status, 201);
    const thirdVa = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie, method: "POST",
      body: { username: "other-actor", password: "other-actor-password-123", role: "va", allowedDevices: [] },
    });
    assert.equal(thirdVa.status, 201);
    const otherActorCookie = await login(baseUrl, "other-actor", "other-actor-password-123");
    const targetsSomeoneElse = await request(baseUrl, "/api/admin/users/bystander", {
      cookie: otherActorCookie, method: "PATCH", body: { role: "admin" },
    });
    assert.equal(targetsSomeoneElse.status, 403);
    assert.equal(auth.operators.get("other-actor").active, true);
    assert.equal(auth.operators.get("other-actor").securityFlagReason, null);

    // Hitting the bootstrap endpoint again after lockout, while authenticated
    // as a non-admin, is the same self-escalation signal.
    const fourthVa = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie, method: "POST",
      body: { username: "bootstrap-retry", password: "bootstrap-retry-password-123", role: "va", allowedDevices: [] },
    });
    assert.equal(fourthVa.status, 201);
    const retryCookie = await login(baseUrl, "bootstrap-retry", "bootstrap-retry-password-123");
    const retryBootstrap = await request(baseUrl, "/api/setup/create-admin", {
      cookie: retryCookie, method: "POST",
      body: { username: "sneaky-admin", password: "sneaky-admin-password-123" },
    });
    assert.equal(retryBootstrap.status, 404);
    const flaggedRetry = auth.operators.get("bootstrap-retry");
    assert.equal(flaggedRetry.active, false);
    assert.match(flaggedRetry.securityFlagReason, /bootstrap endpoint/);
    assert.equal(auth.listOperatorAccounts().some(u => u.username === "sneaky-admin"), false);
  } finally {
    server.close();
  }
});
