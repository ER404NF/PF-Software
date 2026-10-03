// P6 step 1 (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md): fuzz the
// admin-authenticated routes that weren't already covered by P2's fuzzing
// pass (requestErrors.test.js only covers the three unauthenticated routes —
// /api/login, /api/signup, /api/setup/create-admin). This session added a
// "banned" account status, a `reason` field, and role-assignment ceilings on
// top of the pre-existing /api/admin/users routes; none of that had a
// hostile-input pass of its own yet. Every route here must answer with a
// clean 4xx, never a 500 — same method and bar as requestErrors.test.js and
// cloudApiFuzz.test.js.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-admin-users-fuzz-"));
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
process.env.FILE_STORE_DIR = path.join(root, "files");
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.SESSION_SECRET = "admin-users-fuzz-test-secret";
process.env.TWO_FACTOR_MASTER_KEY = "admin-users-fuzz-test-two-factor-key-123456";
process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
process.env.BAN_STORE_PATH = path.join(root, "ip-bans.json");
process.env.AUTO_DISCOVER_IOS_DEVICES = "false";

const auth = await import("../../src/authStore.js");
auth.createOperatorAccount({
  username: "fuzz-host", password: "fuzz-host-password-123", role: "host",
  allowedDevices: null, allowedResearchWorkspaces: [],
});
auth.setMainHost("fuzz-host", true);
auth.createOperatorAccount({
  username: "fuzz-target", password: "fuzz-target-password-123", role: "va",
  email: "fuzz.target@gmail.com", allowedDevices: [], allowedResearchWorkspaces: [],
});

const { server } = await import("../../src/index.js");

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

const loginResponse = await fetch(`${baseUrl}/api/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "fuzz-host", password: "fuzz-host-password-123" }),
});
assert.equal(loginResponse.status, 200, await loginResponse.text());
const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

function send(route, method, body) {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body,
  });
}

function assertClean(response, label) {
  assert.ok(response.status >= 400 && response.status < 500,
    `expected a clean 4xx for ${label}, got ${response.status}`);
}

const jsonRoutes = [
  ["/api/admin/users", "POST"],
  ["/api/admin/users/fuzz-target", "PATCH"],
  ["/api/admin/users/fuzz-target/status", "PATCH"],
  ["/api/admin/users/fuzz-target/rename", "PATCH"],
];

for (const [route, method] of jsonRoutes) {
  test(`${method} ${route}: malformed JSON is a clean 4xx, never a 500`, async () => {
    assertClean(await send(route, method, '{"a":'), `${method} ${route} malformed`);
  });

  test(`${method} ${route}: a bare null body is a clean 4xx`, async () => {
    assertClean(await send(route, method, "null"), `${method} ${route} null`);
  });

  test(`${method} ${route}: an oversized body is a clean 4xx (413)`, async () => {
    const response = await send(route, method, JSON.stringify({ text: "A".repeat(2_000_000) }));
    assert.equal(response.status, 413);
  });

  test(`${method} ${route}: a bare array instead of an object is a clean 4xx`, async () => {
    assertClean(await send(route, method, "[1,2,3]"), `${method} ${route} array`);
  });
}

// Fields this session actually added — the real value of this pass, beyond
// the generically-already-covered malformed-JSON case above.
test("POST /api/admin/users: hostile role values never reach role-ceiling logic as a crash", async () => {
  for (const role of [{}, [], 42, null, "__proto__", "constructor"]) {
    const response = await send("/api/admin/users", "POST", JSON.stringify({
      username: "hostile-role-target", password: "hostile-role-password-123", role,
      allowedDevices: null, allowedResearchWorkspaces: [],
    }));
    assertClean(response, `role=${JSON.stringify(role)}`);
  }
});

test("PATCH /api/admin/users/:username/status: hostile status values never reach the account-status logic as a crash", async () => {
  for (const status of [{}, [], 42, null, "__proto__", "approved; DROP TABLE operators"]) {
    const response = await send("/api/admin/users/fuzz-target/status", "PATCH", JSON.stringify({ status }));
    assertClean(response, `status=${JSON.stringify(status)}`);
  }
});

// Found by this fuzz pass: the atomic account-status mutation had no length
// cap on `reason`, unlike every other free-text field in authStore.js
// (fullName, passwords, etc.). An unbounded string would previously have
// been written straight into operators.config.json. BAN_REASON_MAX_LENGTH
// now rejects it before any durable status change.
test("PATCH /api/admin/users/:username/status: an oversized ban reason is a clean 400, not silently accepted", async () => {
  const hugeReason = await send("/api/admin/users/fuzz-target/status", "PATCH", JSON.stringify({
    status: "banned", reason: "R".repeat(100_000),
  }));
  assertClean(hugeReason, "huge reason");
  assert.equal(hugeReason.status, 400);
});

// A non-string reason (wrong shape, not just wrong length) is rejected before
// the account status changes. This preserves an all-or-nothing admin mutation.
test("PATCH /api/admin/users/:username/status: a non-string ban reason is rejected atomically", async () => {
  for (const reason of [{}, [], 42, { toString: () => { throw new Error("hostile toString"); } }]) {
    const response = await send("/api/admin/users/fuzz-target/status", "PATCH", JSON.stringify({ status: "banned", reason }));
    assert.equal(response.status, 400, `expected 400 for reason=${JSON.stringify(reason)}`);
    assert.equal(auth.operators.get("fuzz-target")?.accountStatus ?? "approved", "approved");
  }
});

test("prototype-pollution-shaped bodies never crash any admin route", async () => {
  const payload = JSON.stringify({ "__proto__": { polluted: true }, "constructor": { "prototype": { polluted: true } } });
  for (const [route, method] of jsonRoutes) {
    assertClean(await send(route, method, payload), `${method} ${route} proto-pollution`);
  }
  // The polluted key must never actually reach Object.prototype.
  assert.equal(({}).polluted, undefined);
});

test("isMainHost in a request body is silently ignored, never a crash or a real grant", async () => {
  const response = await send("/api/admin/users", "POST", JSON.stringify({
    username: "isMainHost-fuzz-target", password: "isMainHost-fuzz-password-123", role: "va",
    isMainHost: true, allowedDevices: [], allowedResearchWorkspaces: [],
  }));
  assert.equal(response.status, 201);
  assert.equal(auth.operators.get("isMainHost-fuzz-target")?.isMainHost, false);
});

after(() => new Promise(resolve => server.close(resolve)));
