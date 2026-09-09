import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-research-access-"));
process.env.SESSION_STORE_DIR = path.join(root, "sessions");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
process.env.RESEARCH_STORE_DIR = path.join(root, "research");
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
process.env.RESEARCH_CONFIG_PATH = path.join(root, "research.config.json");
process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.config.json");
process.env.SESSION_SECRET = "isolated-test-secret";
fs.writeFileSync(process.env.RESEARCH_CONFIG_PATH, JSON.stringify({ accounts: [
  { id: "account-a", workspaceId: "client-a", platform: "instagram" },
  { id: "account-b", workspaceId: "client-b", platform: "x" },
] }));
const { hashPassword, operators } = await import("../../src/authStore.js");
const passwordHash = hashPassword("test-password");
// Exercise actual configuration loading, not just injection into the registry.
// authStore was loaded for hashing above; a query import loads the fixture below.
fs.writeFileSync(process.env.OPERATORS_CONFIG_PATH, JSON.stringify({ operators: [
  { username: "a", passwordHash, role: "va", allowedDevices: ["mock-1"], allowedResearchWorkspaces: ["client-a"] },
  { username: "b", passwordHash, role: "admin", allowedDevices: ["mock-2"], allowedResearchWorkspaces: ["client-b"] },
  { username: "legacy", passwordHash, role: "admin" },
] }));
const loaded = await import("../../src/authStore.js?research-config-test");
for (const [id, operator] of loaded.operators) operators.set(id, operator);
const { server, wss } = await import("../../src/index.js");
const { parseResearchAccounts } = await import("../../src/researchAccess.js");
const { saveResearchEvidence } = await import("../../src/researchEvidenceStore.js");
let base;
const cookies = {};
async function request(user, route, method = "GET", body) {
  const res = await fetch(`${base}${route}`, { method,
    headers: { "Content-Type": "application/json", ...(cookies[user] ? { Cookie: cookies[user] } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const username of ["a", "b", "legacy"]) {
    const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "test-password" }) });
    assert.equal(res.status, 200);
    await res.json();
    cookies[username] = res.headers.get("set-cookie").split(";")[0];
  }
});
after(async () => {
  wss.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test("operators can create/read/review only their workspace's research, including restricted admins", async () => {
  for (const [owner, other, account, workspaceId] of [["a", "b", "account-a", "client-a"], ["b", "a", "account-b", "client-b"]]) {
    const url = `/api/research/${account}/runs`;
    const created = await request(owner, url, "POST", { platform: "x", overview: "private research", workspaceId: "spoofed",
      account: "spoofed", candidates: [{ url: "https://example.com/post" }] });
    assert.equal(created.status, 200);
    const run = created.body.run;
    assert.equal(run.workspaceId, workspaceId);
    assert.equal(run.account, account);
    const detail = `${url}/${run.id}`;
    const candidate = `${detail}/candidates/${run.candidates[0].id}`;
    assert.equal((await request(owner, url)).body.runs.length, 1);
    assert.equal((await request(owner, detail)).status, 200);
    for (const unauthorized of [other, "legacy"]) {
      assert.equal((await request(unauthorized, url)).status, 403);
      assert.equal((await request(unauthorized, detail)).status, 403);
      assert.equal((await request(unauthorized, url, "POST", { platform: "x", overview: "intrusion" })).status, 403);
      assert.equal((await request(unauthorized, candidate, "PATCH", { status: "removed" })).status, 403);
    }
    assert.equal((await request(owner, detail)).body.run.candidates[0].status, "pending");
    assert.equal((await request(owner, candidate, "PATCH", { status: "confirmed" })).status, 200);
    assert.ok(fs.existsSync(path.join(process.env.RESEARCH_STORE_DIR, workspaceId, `${account}.json`)));
  }
  const audit = fs.readFileSync(process.env.AUDIT_LOG_PATH, "utf8");
  assert.match(audit, /research_access_denied/);
  assert.match(audit, /research_run_created/);
  assert.match(audit, /client-a/);
});

test("unknown accounts fail closed and unauthenticated requests remain 401", async () => {
  assert.equal((await request("a", "/api/research/unregistered/runs")).status, 403);
  assert.equal((await request(null, "/api/research/account-a/runs")).status, 401);
});

test("account discovery only lists authorized accounts and rejects anonymous requests", async () => {
  assert.deepEqual((await request("a", "/api/research")).body.accounts,
    [{ id: "account-a", workspaceId: "client-a", platform: "instagram" }]);
  assert.deepEqual((await request("legacy", "/api/research")).body.accounts, []);
  assert.equal((await request(null, "/api/research")).status, 401);
});

test("stored evidence bytes use the same account authorization boundary", async () => {
  const saved = saveResearchEvidence("client-a", "account-a", {
    kind: "image", mime: "image/png", data: Buffer.from("evidence-bytes").toString("base64"),
  });
  const route = `${base}/api/research/account-a/evidence/${saved.id}`;
  const allowed = await fetch(route, { headers: { Cookie: cookies.a } });
  assert.equal(allowed.status, 200);
  assert.equal(Buffer.from(await allowed.arrayBuffer()).toString(), "evidence-bytes");
  assert.equal((await fetch(route, { headers: { Cookie: cookies.b } })).status, 403);
  assert.equal((await fetch(`${base}/api/research/account-a/evidence/evidence-00000000-0000-0000-0000-000000000000.png`,
    { headers: { Cookie: cookies.a } })).status, 404);
});

test("malformed run metadata returns 400 without writing a run", async () => {
  const route = "/api/research/account-a/runs";
  const before = (await request("a", route)).body.runs.length;
  assert.equal((await request("a", route, "POST", { platform: {}, overview: "test" })).status, 400);
  assert.equal((await request("a", route, "POST", { platform: "x", overview: ["test"] })).status, 400);
  assert.equal((await request("a", route)).body.runs.length, before);
});

test("workspace revocation and operator removal apply to an already logged-in session", async () => {
  const operator = operators.get("a");
  try {
    // Revoking a grant on an operator who still exists is a 403: a known,
    // still-valid identity forbidden from this specific research account.
    operator.allowedResearchWorkspaces = [];
    assert.equal((await request("a", "/api/research/account-a/runs")).status, 403);
    operator.allowedResearchWorkspaces = ["client-a"];
    assert.equal((await request("a", "/api/research/account-a/runs")).status, 200);
    // Removing the operator entirely is a 401, not 403: requireAuth itself
    // now re-resolves the operator from the live registry on every request
    // (see requireAuth's comment in index.js and resolveOperator's in
    // authStore.js) and fails closed before the request ever reaches
    // researchWorkspaceFor's workspace-grant check — "this identity no
    // longer exists" is an authentication problem, not merely a permission
    // one. This is a deliberate improvement, not a relaxation: previously,
    // a deleted operator's already-open session (and, before this same fix,
    // its role/allowedDevices too) kept working against everything EXCEPT
    // the research-ownership boundary, which was the only route that
    // happened to re-check the live registry per-request.
    operators.delete("a");
    assert.equal((await request("a", "/api/research/account-a/runs")).status, 401);
  } finally { operators.set("a", operator); }
});

test("ownership config rejects ambiguous owners, malformed IDs, platforms and implicit defaults", () => {
  for (const config of [{}, { accounts: [{ id: "a" }] },
    { accounts: [{ id: "a", workspaceId: "one" }] },
    { accounts: [{ id: "a", workspaceId: "../b", platform: "instagram" }] },
    { accounts: [{ id: "a", workspaceId: "Client-A", platform: "instagram" }] },
    { accounts: [{ id: "con", workspaceId: "one", platform: "instagram" }] },
    { accounts: [{ id: "a", workspaceId: "one", platform: "tiktok" }] },
    { accounts: [{ id: "a", workspaceId: "one", platform: "instagram" },
      { id: "a", workspaceId: "two", platform: "reddit" }] }]) {
    assert.throws(() => parseResearchAccounts(config));
  }
});
