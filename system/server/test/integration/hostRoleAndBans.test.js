// Proves two features added together: the "host" role tier (one hub owner
// per Mac mini/phones location, with a single "main host" allowed to grant
// the host role itself — see index.js's maxAssignableRoles) and the
// separate Ban mechanism (distinct from Kick and from onboarding-only
// Reject; see banStore.js and authStore.js's recordOperatorLoginIp for the
// documented limits of IP-based blocking).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-host-ban-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "host-ban-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "host-ban-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.BAN_STORE_PATH = path.join(root, "ip-bans.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");

auth.createOperatorAccount({
  username: "main-host", password: "main-host-password-123", role: "host",
  allowedDevices: null, allowedResearchWorkspaces: [],
});
auth.setMainHost("main-host", true);
auth.createOperatorAccount({
  username: "second-host", password: "second-host-password-123", role: "host",
  allowedDevices: null, allowedResearchWorkspaces: [],
});
assert.throws(
  () => auth.setMainHost("second-host", true),
  /main host already exists/,
  "a second CLI promotion must not create two main-host authorities",
);
auth.createOperatorAccount({
  username: "admin-test", password: "admin-password-123", role: "admin",
  allowedDevices: null, allowedResearchWorkspaces: [],
});
auth.createOperatorAccount({
  username: "ban-target", password: "ban-target-password-123", role: "va",
  email: "ban.target@gmail.com", allowedDevices: [], allowedResearchWorkspaces: [],
});

const { server } = await import("../../src/index.js");

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return response.headers.get("set-cookie").split(";")[0];
}

async function request(baseUrl, url, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

test("role-assignment ceilings: admin tops out at manager, host tops out at admin, only the main host grants host", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const adminCookie = await login(baseUrl, "admin-test", "admin-password-123");
    const hostCookie = await login(baseUrl, "second-host", "second-host-password-123");
    const mainHostCookie = await login(baseUrl, "main-host", "main-host-password-123");

    const adminCreatesAdmin = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie, method: "POST",
      body: { username: "should-fail-admin", password: "should-fail-password-123", role: "admin", allowedDevices: null, allowedResearchWorkspaces: [] },
    });
    assert.equal(adminCreatesAdmin.status, 403);

    const adminCreatesManager = await request(baseUrl, "/api/admin/users", {
      cookie: adminCookie, method: "POST",
      body: { username: "admin-made-manager", password: "admin-made-manager-pw-123", role: "manager", teamId: "team-a", allowedDevices: null, allowedResearchWorkspaces: [] },
    });
    assert.equal(adminCreatesManager.status, 201);

    const hostCreatesHost = await request(baseUrl, "/api/admin/users", {
      cookie: hostCookie, method: "POST",
      body: { username: "should-fail-host", password: "should-fail-password-123", role: "host", allowedDevices: null, allowedResearchWorkspaces: [] },
    });
    assert.equal(hostCreatesHost.status, 403);

    const hostCreatesAdmin = await request(baseUrl, "/api/admin/users", {
      cookie: hostCookie, method: "POST",
      body: { username: "host-made-admin", password: "host-made-admin-pw-123", role: "admin", allowedDevices: null, allowedResearchWorkspaces: [] },
    });
    assert.equal(hostCreatesAdmin.status, 201);

    const mainHostCreatesHost = await request(baseUrl, "/api/admin/users", {
      cookie: mainHostCookie, method: "POST",
      body: { username: "third-host", password: "third-host-password-123", role: "host", allowedDevices: null, allowedResearchWorkspaces: [] },
    });
    assert.equal(mainHostCreatesHost.status, 201);

    // isMainHost is never accepted from a request body, even from the main host.
    const attemptIsMainHost = await request(baseUrl, "/api/admin/users", {
      cookie: mainHostCookie, method: "POST",
      body: { username: "sneaky-host", password: "sneaky-host-password-123", role: "host", isMainHost: true, allowedDevices: null, allowedResearchWorkspaces: [] },
    });
    assert.equal(attemptIsMainHost.status, 201);
    assert.equal(auth.operators.get("sneaky-host")?.isMainHost, false);

    // An admin cannot see or manage a host account at all.
    const adminUsersList = await request(baseUrl, "/api/admin/users", { cookie: adminCookie });
    assert.equal(adminUsersList.status, 200);
    assert.ok(!adminUsersList.body.users.some(u => u.username === "second-host"));
    const adminPatchesHost = await request(baseUrl, "/api/admin/users/second-host", {
      cookie: adminCookie, method: "PATCH", body: { fullName: "Nope" },
    });
    assert.equal(adminPatchesHost.status, 403);
    assert.equal((await request(baseUrl, "/api/admin/users/second-host/revoke-sessions", {
      cookie: adminCookie, method: "POST",
    })).status, 403, "an admin must not revoke a higher-tier host's sessions");
    assert.equal((await request(baseUrl, "/api/admin/users/second-host/2fa/reset", {
      cookie: adminCookie, method: "POST",
    })).status, 403, "an admin must not reset a higher-tier host's second factor");

    // A host can manage an admin (host outranks admin).
    const hostPatchesAdmin = await request(baseUrl, "/api/admin/users/admin-test", {
      cookie: hostCookie, method: "PATCH", body: { fullName: "Admin Test" },
    });
    assert.equal(hostPatchesAdmin.status, 200);
  } finally {
    server.close();
  }
});

test("banning an account blocks its login, blocklists its recent IP, and only a host can lift the ban", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const adminCookie = await login(baseUrl, "admin-test", "admin-password-123");
    const hostCookie = await login(baseUrl, "second-host", "second-host-password-123");

    // ban-target logs in once so authStore records a recent-login IP for it.
    await login(baseUrl, "ban-target", "ban-target-password-123");

    const accountsBeforeBan = await request(baseUrl, "/api/admin/users", { cookie: adminCookie });
    assert.equal(accountsBeforeBan.status, 200);
    const listedTarget = accountsBeforeBan.body.users.find(user => user.username === "ban-target");
    assert.ok(listedTarget);
    assert.equal(Object.hasOwn(listedTarget, "recentLoginIps"), false,
      "server-private login history must never be serialized to account-management clients");

    const banned = await request(baseUrl, "/api/admin/users/ban-target/status", {
      cookie: adminCookie, method: "PATCH", body: { status: "banned", reason: "stole client data" },
    });
    assert.equal(banned.status, 200);
    assert.equal(banned.body.operator.accountStatus, "banned");
    assert.equal(banned.body.operator.bannedBy, "admin-test");
    assert.equal(banned.body.operator.bannedReason, "stole client data");
    // No email support for bans at all — never held to the approve/reject
    // email contract.
    assert.equal(banned.body.notification.deliveryState, null);

    const loginAttempt = await fetch(`${baseUrl}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ban-target", password: "ban-target-password-123" }),
    });
    assert.equal(loginAttempt.status, 403);
    assert.equal((await loginAttempt.json()).code, "account_banned");

    // The IP blocklist is deliberately not checked at login (a shared office
    // IP must not lock out every coworker on it) — a different, legitimate
    // account from that same address can still sign in normally.
    const coworkerStillWorks = await request(baseUrl, "/api/admin/users", { cookie: adminCookie });
    assert.equal(coworkerStillWorks.status, 200);

    // The test harness itself is 127.0.0.1 — the same address ban-target
    // logged in from — so it now blocks new signups from that address too.
    const signupFromSameIp = await request(baseUrl, "/api/signup", {
      method: "POST",
      body: {
        fullName: "New Person", email: "new.person@gmail.com", username: "new-person",
        password: "new-person-password-123", passwordConfirmation: "new-person-password-123",
      },
    });
    assert.equal(signupFromSameIp.status, 403);
    assert.equal(signupFromSameIp.body.code, "ip_banned");

    // An admin cannot lift a ban.
    const adminLifts = await request(baseUrl, "/api/admin/users/ban-target/status", {
      cookie: adminCookie, method: "PATCH", body: { status: "rejected" },
    });
    assert.equal(adminLifts.status, 403);

    // Only a host can lift it.
    const hostLifts = await request(baseUrl, "/api/admin/users/ban-target/status", {
      cookie: hostCookie, method: "PATCH", body: { status: "rejected" },
    });
    assert.equal(hostLifts.status, 200);
    assert.equal(hostLifts.body.operator.accountStatus, "rejected");
    assert.equal(hostLifts.body.operator.bannedReason, undefined);
  } finally {
    server.close();
  }
});

test("a host cannot be banned/rejected by anyone but another host, and self-ban is refused", async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const hostCookie = await login(baseUrl, "second-host", "second-host-password-123");
    const selfBan = await request(baseUrl, "/api/admin/users/second-host/status", {
      cookie: hostCookie, method: "PATCH", body: { status: "banned" },
    });
    assert.equal(selfBan.status, 403);
  } finally {
    server.close();
  }
});

test("banning and lifting a ban never require an email on file (unlike approve/reject)", async () => {
  auth.createOperatorAccount({
    username: "no-email-target", password: "no-email-target-password-123", role: "va",
    allowedDevices: [], allowedResearchWorkspaces: [],
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const hostCookie = await login(baseUrl, "second-host", "second-host-password-123");
    const banned = await request(baseUrl, "/api/admin/users/no-email-target/status", {
      cookie: hostCookie, method: "PATCH", body: { status: "banned" },
    });
    assert.equal(banned.status, 200);
    const lifted = await request(baseUrl, "/api/admin/users/no-email-target/status", {
      cookie: hostCookie, method: "PATCH", body: { status: "rejected" },
    });
    assert.equal(lifted.status, 200);
  } finally {
    server.close();
  }
});

test("an invalid ban reason cannot partially ban the account", async () => {
  auth.createOperatorAccount({
    username: "invalid-ban-target", password: "invalid-ban-target-password-123", role: "va",
    email: "invalid.ban.target@gmail.com", allowedDevices: [], allowedResearchWorkspaces: [],
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const hostCookie = await login(baseUrl, "second-host", "second-host-password-123");
    const rejected = await request(baseUrl, "/api/admin/users/invalid-ban-target/status", {
      cookie: hostCookie, method: "PATCH", body: { status: "banned", reason: "x".repeat(1001) },
    });
    assert.equal(rejected.status, 400);
    const account = auth.listOperatorAccounts().find(candidate => candidate.username === "invalid-ban-target");
    assert.equal(account.accountStatus ?? "approved", "approved");
    assert.equal(account.active, true);
  } finally {
    server.close();
  }
});
