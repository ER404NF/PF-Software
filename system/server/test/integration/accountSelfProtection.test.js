// Protecting accounts from lock-out and from the wrong person: nobody can turn off or re-rank the account they
// are signed in with, the last active admin/host cannot be removed, and an account can be deleted only by someone
// who outranks it (everyone can still delete their own through the privacy page).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-self-protection-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "self-protection-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "self-protection-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.BAN_STORE_PATH = path.join(root, "ip-bans.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");
const { assertPlainOperatorText } = await import("../helpers/plainText.js");
const PASSWORD = "protection-test-password-1";

function make(username, role, extra = {}) {
  auth.createOperatorAccount({ username, password: PASSWORD, role, allowedDevices: role === "va" ? [] : null, allowedResearchWorkspaces: [], ...extra });
}
make("main-host", "host");
auth.setMainHost("main-host", true);
make("second-host", "host");
make("admin-1", "admin");
make("admin-2", "admin");
make("admin-3", "admin");
make("mgr-a", "manager", { teamId: "team-a", allowedDevices: ["mock-1"] });
make("mgr-a2", "manager", { teamId: "team-a", allowedDevices: ["mock-1"] });
make("mgr-b", "manager", { teamId: "team-b", allowedDevices: ["mock-1"] });
make("va-a", "va", { teamId: "team-a" });
make("va-a2", "va", { teamId: "team-a" });
make("va-b", "va", { teamId: "team-b" });
make("va-none", "va");

const { server, wss } = await import("../../src/index.js");
let baseUrl;
const cookies = {};

async function login(username) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${username}: ${JSON.stringify(body)}`);
  return response.headers.get("set-cookie").split(";")[0];
}

async function request(url, { as, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(as ? { Cookie: cookies[as] } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const del = (target, as, confirmUsername = target) => request(`/api/admin/users/${target}`, { as, method: "DELETE", body: { confirmUsername } });
const patch = (target, as, body) => request(`/api/admin/users/${target}`, { as, method: "PATCH", body });

test("setup", async () => {
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["main-host", "second-host", "admin-1", "mgr-a", "mgr-a2", "va-a"]) cookies[name] = await login(name);
});

test("nobody can turn off or re-rank the account they are signed in with", async () => {
  const off = await patch("second-host", "second-host", { active: false });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, "SELF_CHANGE_BLOCKED");
  assertPlainOperatorText(off.body.error, "self deactivate");
  const rank = await patch("second-host", "second-host", { role: "admin" });
  assert.equal(rank.status, 409);
  assert.equal(rank.body.code, "SELF_CHANGE_BLOCKED");
  assert.equal((await request("/api/me", { as: "second-host" })).status, 200, "the session is untouched");
  // other changes to your own account are fine
  const rename = await patch("second-host", "second-host", { fullName: "Second Host" });
  assert.equal(rename.status, 200);
});

test("another administrator can still change an admin (it is only your own account that is protected)", async () => {
  const response = await patch("admin-3", "admin-1", { fullName: "Third Admin" });
  assert.equal(response.status, 200);
});

test("the users list tells the editor why a row is locked and whether it can be deleted", async () => {
  const { body } = await request("/api/admin/users", { as: "second-host" });
  const row = name => body.users.find(user => user.username === name);
  assert.equal(row("second-host").protection.self, true);
  assert.equal(row("second-host").protection.canDelete, false);
  assert.match(row("second-host").protection.reason, /can't change your own role/);
  assert.equal(row("admin-1").protection.self, false);
  assert.equal(row("admin-1").protection.canDelete, true);
  assert.equal(row("admin-1").protection.reason, null);
  assert.equal(row("main-host").protection.canDelete, false);
  assert.match(row("main-host").protection.deleteReason, /main host account can't be deleted/);
  for (const user of body.users) assertPlainOperatorText(user.protection.reason ?? "ok", `${user.username} reason`);
});

test("deletion hierarchy: a host deletes an admin; the account is locked at once and its sessions end", async () => {
  cookies["admin-2"] = await login("admin-2");
  const result = await del("admin-2", "second-host");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "account_locked");
  assert.equal((await request("/api/me", { as: "admin-2" })).status, 401, "the deleted account's session is gone");
  const login2 = await fetch(`${baseUrl}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin-2", password: PASSWORD }) });
  assert.notEqual(login2.status, 200, "and it cannot sign in again");
  const { body } = await request("/api/admin/users", { as: "second-host" });
  const row = body.users.find(user => user.username === "admin-2");
  assert.equal(row.privacyDeletionState, "requested");
  assert.equal(row.protection.canDelete, false);
  assert.match(row.protection.deleteReason, /already being deleted/);
  await new Promise(resolve => setTimeout(resolve, 100));
  const audit = fs.readFileSync(process.env.AUDIT_LOG_PATH, "utf8");
  assert.match(audit, /account_deleted_by_authority/);
});

test("an admin deletes a manager, but not another admin or a host", async () => {
  assert.equal((await del("mgr-b", "admin-1")).status, 200);
  const peer = await del("admin-3", "admin-1");
  assert.equal(peer.status, 403);
  assert.match(peer.body.error, /below your own role/);
  const above = await del("second-host", "admin-1");
  assert.equal(above.status, 403);
});

test("a manager deletes members of their own team only, never a peer or another team", async () => {
  assert.equal((await del("va-a2", "mgr-a")).status, 200);
  const otherTeam = await del("va-b", "mgr-a");
  assert.equal(otherTeam.status, 403);
  assert.match(otherTeam.body.error, /outside your team/);
  const peer = await del("mgr-a2", "mgr-a");
  assert.equal(peer.status, 403);
  assert.match(peer.body.error, /below your own role/);
});

test("your own account is deleted through the privacy page, never through this route", async () => {
  const own = await del("second-host", "second-host");
  assert.equal(own.status, 409);
  assert.match(own.body.error, /Privacy, then Delete my account/);
});

test("the main host account is never deletable", async () => {
  const response = await del("main-host", "second-host");
  assert.equal(response.status, 409);
  assert.match(response.body.error, /main host account can't be deleted/);
});

test("typing the username is required, unknown accounts are 404, and people without the capability are refused", async () => {
  const missing = await request("/api/admin/users/va-none", { as: "second-host", method: "DELETE", body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "CONFIRMATION_REQUIRED");
  assert.equal((await del("va-none", "second-host", "someone-else")).status, 400);
  assert.equal((await del("no-such-person", "second-host")).status, 404);
  assert.equal((await del("va-none", "va-a")).status, 403, "a VA cannot delete anyone");
  const anonymous = await fetch(`${baseUrl}/api/admin/users/va-none`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmUsername: "va-none" }) });
  assert.equal(anonymous.status, 401);
});

test("the last active admin or host cannot be turned off, demoted or deleted — whichever of the two it is", async () => {
  // leave exactly one administrator-level account: second-host (main-host and the admins are switched off)
  for (const name of ["main-host", "admin-1", "admin-3"]) auth.updateOperatorAccount(name, { active: false }, { actor: "second-host" });
  assert.throws(() => auth.updateOperatorAccount("second-host", { active: false }, { actor: "someone-else" }), error => error.code === "LAST_ADMINISTRATOR" && /last active admin/.test(error.message));
  assert.throws(() => auth.updateOperatorAccount("second-host", { role: "manager", teamId: "team-a" }, { actor: "someone-else" }), error => error.code === "LAST_ADMINISTRATOR");
  assertPlainOperatorText(auth.LAST_ADMINISTRATOR_MESSAGE, "last admin");
  const { body } = await request("/api/admin/users", { as: "second-host" });
  assert.equal(body.users.find(user => user.username === "second-host").protection.lastAdministrator, true);
  // a lone Host cannot delete their own account either, and is told what to do
  assert.throws(() => auth.requestOperatorDeletion("second-host", PASSWORD), error => error.code === "LAST_ADMINISTRATOR" && /only admin or host/.test(error.message));
  // an admin counts too: make the survivor an admin and the same rule holds
  auth.updateOperatorAccount("admin-1", { active: true }, { actor: "second-host" });
  auth.updateOperatorAccount("second-host", { active: false }, { actor: "admin-1" });
  assert.throws(() => auth.updateOperatorAccount("admin-1", { active: false }, { actor: "someone-else" }), error => error.code === "LAST_ADMINISTRATOR");
  assert.throws(() => auth.requestOperatorDeletionByAuthority("admin-1", { actor: "someone-else" }), error => error.code === "LAST_ADMINISTRATOR");
});

test("anyone who is not the last administrator can still delete their own account", () => {
  auth.updateOperatorAccount("second-host", { active: true }, { actor: "admin-1" });
  const result = auth.requestOperatorDeletion("second-host", PASSWORD);
  assert.equal(result.privacyDeletionState, "requested");
});

test("teardown", async () => {
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});
