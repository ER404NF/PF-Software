import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-privacy-routes-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.PRIVACY_REQUEST_STORE_PATH = path.join(root, "privacy-requests.json");
process.env.PRIVACY_DELETION_POLICY_JSON = JSON.stringify({ version: 1, enabled: true, categories: {
  access: "revoke", account: "anonymize", assignments: "anonymize_owned", tasks: "anonymize_owned",
  media: "retain", shared_records: "retain", audit: "retain",
} });
process.env.SESSION_SECRET = "privacy-lifecycle-test-secret";
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");
auth.createOperatorAccount({
  username: "privacy-admin",
  password: "privacy-admin-password",
  role: "admin",
  allowedDevices: null,
});
auth.createOperatorAccount({
  username: "privacy-va",
  password: "privacy-va-password",
  role: "va",
  allowedDevices: [],
  email: "privacy.va@gmail.com",
});
const { server, wss, privacyRequestStore, auditLog, assignmentStore, taskQueue } = await import("../../src/index.js");
let baseUrl;

before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, await response.text());
  return response.headers.get("set-cookie").split(";")[0];
}

async function jsonRequest(url, { cookie = null, body = null } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

test("the public deletion-request intake does not enumerate accounts or retain an unknown raw identifier", async () => {
  const knownIdentifier = "privacy.va+request@gmail.com";
  const known = await jsonRequest("/api/privacy/deletion-requests", { body: { identifier: knownIdentifier } });
  const unknownIdentifier = "not.an.account@gmail.com";
  const unknown = await jsonRequest("/api/privacy/deletion-requests", { body: { identifier: unknownIdentifier } });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(known.body, unknown.body);

  const requests = privacyRequestStore.list();
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(request => request.accountUsername === "privacy-va").length, 1);
  assert.equal(requests.filter(request => request.accountUsername === null).length, 1);
  const storedRequests = fs.readFileSync(process.env.PRIVACY_REQUEST_STORE_PATH, "utf8");
  assert.doesNotMatch(storedRequests, /not\.an\.account@gmail\.com/);
  assert.doesNotMatch(storedRequests, /notanaccount@gmail\.com/);

  const publicPage = await fetch(`${baseUrl}/account-deletion.html`);
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /Request account deletion/);

  // The per-identifier limiter is deliberately identical for known and
  // unknown accounts and prevents one caller from growing the queue freely.
  assert.equal((await jsonRequest("/api/privacy/deletion-requests", { body: { identifier: knownIdentifier } })).status, 202);
  assert.equal((await jsonRequest("/api/privacy/deletion-requests", { body: { identifier: knownIdentifier } })).status, 202);
  const throttled = await jsonRequest("/api/privacy/deletion-requests", { body: { identifier: knownIdentifier } });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.body.code, "RATE_LIMITED");
});

test("an authenticated user can download a bounded secret-free export of account-owned records", async () => {
  const cookie = await login("privacy-va", "privacy-va-password");
  assignmentStore.create({ instructions: "Export my assignment", assignee: "privacy-va", createdBy: "privacy-admin" });
  assignmentStore.create({ instructions: "Do not export another assignment", assignee: "privacy-admin", createdBy: "privacy-va" });
  taskQueue.addTask({ goal: "Export my task", createdBy: "privacy-va" });
  taskQueue.addTask({ goal: "Do not export another task", createdBy: "privacy-admin" });
  auditLog.logEvent({ operator: "privacy-va", type: "privacy_export_fixture", detail: { privateText: "do-not-export-detail" } });

  const response = await fetch(`${baseUrl}/api/me/data-export`, { headers: { Cookie: cookie } });
  const rawBody = await response.text();
  assert.equal(response.status, 200, rawBody);
  assert.match(response.headers.get("content-disposition"), /phone-farm-privacy-va-data\.json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = JSON.parse(rawBody);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.account.username, "privacy-va");
  assert.equal(body.account.email, "privacyva@gmail.com");
  assert.equal(body.assignments.some(item => item.instructions === "Export my assignment"), true);
  assert.equal(body.assignments.some(item => item.instructions.includes("another")), false);
  assert.equal(body.tasks.some(item => item.goal === "Export my task"), true);
  assert.equal(body.tasks.some(item => item.goal.includes("another")), false);
  const serialized = JSON.stringify(body);
  for (const forbidden of ["passwordHash", "twoFactorSecret", "recoveryCodeDigests", "do-not-export-detail", "lookupDigest"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not be exported`);
  }
});

test("self-service deletion requires fresh credentials and immediately revokes every existing session", async () => {
  const firstCookie = await login("privacy-va", "privacy-va-password");
  const secondCookie = await login("privacy-va", "privacy-va-password");
  // Add reusable recovery material only after both sessions exist; deletion
  // must revoke it without making this test depend on a live TOTP setup flow.
  auth.configureOperatorTwoFactor("privacy-va", "encrypted-test-secret", ["1", "2", "3", "4", "5"]);
  auth.createEmailRecoveryToken("privacy-va");

  const requestsBeforeBadPassword = privacyRequestStore.list().length;
  const denied = await jsonRequest("/api/me/deletion-request", {
    cookie: firstCookie,
    body: { password: "wrong-password", confirmation: "DELETE MY ACCOUNT" },
  });
  assert.equal(denied.status, 403);
  assert.equal(auth.operators.get("privacy-va").active, true);
  assert.equal(privacyRequestStore.list().length, requestsBeforeBadPassword,
    "bad credentials must not create or fail a verified privacy request");

  const accepted = await jsonRequest("/api/me/deletion-request", {
    cookie: firstCookie,
    body: { password: "privacy-va-password", confirmation: "DELETE MY ACCOUNT" },
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.status, "account_locked");

  const stored = auth.operators.get("privacy-va");
  assert.equal(stored.active, false);
  assert.equal(stored.privacyDeletionState, "requested");
  assert.equal(stored.twoFactorSecret, null);
  assert.deepEqual(stored.recoveryCodeDigests, []);
  assert.equal(stored.recoveryTokenHash, null);

  for (const cookie of [firstCookie, secondCookie]) {
    const me = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
    assert.equal(me.status, 401);
  }
  const requests = privacyRequestStore.list();
  assert.equal(requests.length, 2, "verified username request must upgrade the earlier canonical-email request");
  assert.equal(requests.some(request => request.status === "account_locked"
    && request.accountUsername === "privacy-va"), true);
  assert.equal(auditLog.listEvents({ operator: "privacy-va" }).some(event => event.type === "account_deletion_requested"), true);
});

test("an admin can plan and idempotently complete the locked deletion without exposing record contents", async () => {
  const cookie = await login("privacy-admin", "privacy-admin-password");
  const request = privacyRequestStore.list().find(item => item.accountUsername === "privacy-va" && item.status === "account_locked");
  assert.ok(request);
  const planResponse = await fetch(`${baseUrl}/api/admin/privacy/deletion-requests/${request.id}/plan`, {
    headers: { Cookie: cookie },
  });
  const planText = await planResponse.text();
  assert.equal(planResponse.status, 200, planText);
  const plan = JSON.parse(planText);
  assert.equal(plan.categories.account.accounts, 1);
  assert.equal(plan.categories.assignments.matched >= 1, true);
  assert.equal(JSON.stringify(plan).includes("Export my assignment"), false);

  const processed = await jsonRequest(`/api/admin/privacy/deletion-requests/${request.id}/process`, { cookie });
  assert.equal(processed.status, 200);
  assert.equal(processed.body.status, "completed");
  const completedRequest = privacyRequestStore.getForProcessing(request.id);
  const tombstone = completedRequest.tombstone;
  assert.match(tombstone, /^deleted-[a-f0-9]{24}$/);
  assert.equal(auth.operators.has("privacy-va"), false);
  const stored = auth.operators.get(tombstone);
  assert.equal(stored.privacyDeletionState, "completed");
  assert.equal(stored.username, tombstone);
  assert.equal(stored.email, null);
  assert.equal(stored.fullName, null);
  assert.deepEqual(stored.allowedDevices, []);
  assert.equal(assignmentStore.list().some(item => item.assignee === "privacy-va" || item.createdBy === "privacy-va"), false);
  assert.equal(taskQueue.listTasks().some(item => item.createdBy === "privacy-va"), false);
  assert.equal(assignmentStore.list().some(item => item.assignee === tombstone || item.createdBy === tombstone), true);
  assert.equal(taskQueue.listTasks().some(item => item.createdBy === tombstone), true);
  assert.equal(completedRequest.status, "completed");
  assert.equal(Object.hasOwn(completedRequest, "accountUsername"), false);
  assert.equal(Object.hasOwn(completedRequest, "lookupDigest"), false);
  assert.equal(fs.readFileSync(process.env.OPERATORS_CONFIG_PATH, "utf8").includes('"username": "privacy-va"'), false);
  assert.equal(fs.readFileSync(process.env.PRIVACY_REQUEST_STORE_PATH, "utf8").includes('"accountUsername": "privacy-va"'), false);

  const repeated = await jsonRequest(`/api/admin/privacy/deletion-requests/${request.id}/process`, { cookie });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.status, "completed");
  assert.equal(repeated.body.claimed, false);
  assert.equal(privacyRequestStore.getForProcessing(request.id).tombstone, tombstone);
});

test("the last active admin and an unconfirmed request fail without changing account authority", async () => {
  const cookie = await login("privacy-admin", "privacy-admin-password");
  const unconfirmed = await jsonRequest("/api/me/deletion-request", {
    cookie,
    body: { password: "privacy-admin-password", confirmation: "delete" },
  });
  assert.equal(unconfirmed.status, 400);
  const blocked = await jsonRequest("/api/me/deletion-request", {
    cookie,
    body: { password: "privacy-admin-password", confirmation: "DELETE MY ACCOUNT" },
  });
  assert.equal(blocked.status, 409);
  assert.equal(auth.operators.get("privacy-admin").active, true);
  assert.equal(auth.operators.get("privacy-admin").privacyDeletionState, null);
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })).status, 200);
});

test("a tombstone collision fails closed before the file-backed account is renamed", async () => {
  auth.createOperatorAccount({
    username: "privacy-collision-va", password: "privacy-collision-password", role: "va", allowedDevices: [],
  });
  auth.requestOperatorDeletion("privacy-collision-va", "privacy-collision-password");
  const request = privacyRequestStore.createVerified({
    lookupDigest: crypto.createHash("sha256").update("privacy-collision-va").digest("hex"),
    accountUsername: "privacy-collision-va",
  });
  privacyRequestStore.markAccountLocked(request.id);
  const tombstone = `deleted-${crypto.createHmac("sha256", process.env.SESSION_SECRET)
    .update(`privacy-request:${request.id}`).digest("hex").slice(0, 24)}`;
  auth.createOperatorAccount({ username: tombstone, password: "collision-holder-password", role: "va", allowedDevices: [] });
  assert.throws(
    () => auth.finalizeOperatorPrivacyDeletion("privacy-collision-va", tombstone, request.id),
    error => error?.status === 409,
    "the file authority must reject a collision even if a preflight check races",
  );

  const cookie = await login("privacy-admin", "privacy-admin-password");
  const response = await jsonRequest(`/api/admin/privacy/deletion-requests/${request.id}/process`, { cookie });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.includes("privacy-collision-va"), false);
  assert.equal(auth.operators.has("privacy-collision-va"), true);
  assert.equal(auth.operators.get("privacy-collision-va").privacyDeletionState, "requested");
  assert.equal(privacyRequestStore.getForProcessing(request.id).status, "account_locked");
});
