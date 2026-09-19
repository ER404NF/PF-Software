import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-research-ops-"));
Object.assign(process.env, {
  SESSION_STORE_DIR: path.join(root, "sessions"),
  AUDIT_LOG_PATH: path.join(root, "audit.log"),
  QUEUE_STORE_PATH: path.join(root, "queue.json"),
  RESEARCH_STORE_DIR: path.join(root, "research"),
  RESEARCH_EVIDENCE_DIR: path.join(root, "evidence"),
  RESEARCH_CONFIG_PATH: path.join(root, "research.config.json"),
  OPERATORS_CONFIG_PATH: path.join(root, "operators.config.json"),
  FILE_STORE_DIR: path.join(root, "files"),
  SITE_STORE_PATH: path.join(root, "sites.json"),
  APPROVAL_STORE_PATH: path.join(root, "approvals.json"),
  COMMENT_LEDGER_PATH: path.join(root, "ledger.json"),
  COMMENT_TEMPLATES_PATH: path.join(root, "templates.json"),
  ACTION_POLICY_OVERRIDES_PATH: path.join(root, "policy.json"),
  INTERVENTION_STORE_PATH: path.join(root, "interventions.json"),
  MODEL_SELECTION_STORE_PATH: path.join(root, "models.json"),
  ASSIGNMENT_STORE_PATH: path.join(root, "assignments.json"),
  SESSION_SECRET: "isolated-test-secret",
});
fs.writeFileSync(process.env.RESEARCH_CONFIG_PATH, JSON.stringify({ accounts: [
  { id: "account-a", workspaceId: "client-a", platform: "instagram", deviceId: "mock-1" },
  { id: "account-b", workspaceId: "client-b", platform: "x" },
] }));
const { hashPassword, operators } = await import("../../src/authStore.js");
const passwordHash = hashPassword("test-password");
fs.writeFileSync(process.env.OPERATORS_CONFIG_PATH, JSON.stringify({ operators: [
  { username: "va", passwordHash, role: "va", allowedDevices: ["mock-1"], allowedResearchWorkspaces: ["client-a"] },
  { username: "manager", passwordHash, role: "manager", allowedDevices: null, allowedResearchWorkspaces: ["client-a"] },
  { username: "boss", passwordHash, role: "admin", allowedResearchWorkspaces: ["client-a"] },
  { username: "boss-b", passwordHash, role: "admin", allowedResearchWorkspaces: ["client-b"] },
] }));
const loaded = await import("../../src/authStore.js?research-ops-config");
for (const [id, operator] of loaded.operators) operators.set(id, operator);
const { server, wss, approvalStore, policyStore, templateLibrary, interventionQueue, auditLog, fleetPolicy } = await import("../../src/index.js");
const { finalizeRun, createRun } = await import("../../src/researchStore.js");

let base;
const cookies = {};
async function request(user, route, method = "GET", body) {
  const res = await fetch(`${base}${route}`, { method,
    headers: { "Content-Type": "application/json", ...(cookies[user] ? { Cookie: cookies[user] } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const username of ["va", "manager", "boss", "boss-b"]) {
    const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "test-password" }) });
    assert.equal(res.status, 200, username);
    await res.json();
    cookies[username] = res.headers.get("set-cookie").split(";")[0];
  }
});
after(async () => {
  wss.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- policy ---------------------------------------------------------------------------------

test("every account action starts DISABLED; only an administrator of that workspace can change one, and it takes effect at once", async () => {
  const before = await request("va", "/api/research/account-a/policies");
  assert.equal(before.status, 200);
  assert.ok(before.body.policies.length >= 20);
  assert.ok(before.body.policies.every(item => item.policy === "DISABLED"), "nothing is enabled by default");

  for (const denied of ["va", "manager"]) {
    assert.equal((await request(denied, "/api/research/account-a/policies/like", "PUT", { policy: "ALLOW_AUTONOMOUS" })).status, 403, denied);
  }
  assert.equal((await request("boss-b", "/api/research/account-a/policies/like", "PUT", { policy: "ALLOW_AUTONOMOUS" })).status, 403, "another client's admin");
  assert.equal((await request("boss", "/api/research/account-a/policies/like", "PUT", { policy: "SOMETIMES" })).status, 400);
  assert.equal((await request("boss", "/api/research/account-a/policies/launch_rocket", "PUT", { policy: "DISABLED" })).status, 400);

  const changed = await request("boss", "/api/research/account-a/policies/like", "PUT", { policy: "REQUIRE_APPROVAL" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.policy.policy, "REQUIRE_APPROVAL");
  const after = await request("va", "/api/research/account-a/policies");
  assert.equal(after.body.policies.find(item => item.action === "like").policy, "REQUIRE_APPROVAL");
  assert.equal(policyStore.effective(new Map()).get("account-a").like, "REQUIRE_APPROVAL");
  assert.ok(auditLog.listEvents().some(event => event.type === "action_policy_changed" && event.operator === "boss" && event.detail.action === "like"));
});

// ---- templates ------------------------------------------------------------------------------

test("preset comments: administrators manage them per workspace, everyone with research access can read them, no leakage", async () => {
  assert.equal((await request("va", "/api/research/account-a/templates", "POST", { text: "Thanks for sharing!" })).status, 403);
  const created = await request("boss", "/api/research/account-a/templates", "POST", { text: "Thanks for sharing!", tags: ["generic"] });
  assert.equal(created.status, 201);
  assert.equal(created.body.template.workspaceId, "client-a");
  assert.equal((await request("boss", "/api/research/account-a/templates", "POST", { text: "thanks for sharing!" })).status, 400, "duplicate");
  assert.equal((await request("boss", "/api/research/account-a/templates", "POST", { text: "see https://spam.example" })).status, 400, "no links");
  assert.equal((await request("va", "/api/research/account-a/templates")).body.templates.length, 1);
  assert.equal((await request("boss-b", "/api/research/account-b/templates")).body.templates.length, 0, "another client sees none of them");
  assert.equal((await request("boss-b", "/api/research/account-a/templates")).status, 403);
  assert.equal((await request("boss", `/api/research/account-a/templates/${created.body.template.id}`, "DELETE")).status, 200);
  assert.equal((await request("boss", `/api/research/account-a/templates/${created.body.template.id}`, "DELETE")).status, 404);
  assert.equal(templateLibrary.list("client-a").length, 0);
});

// ---- approvals ------------------------------------------------------------------------------

test("approvals: a manager or admin decides, a VA cannot, each decision is audited and final, and clients are isolated", async () => {
  const ask = { workspaceId: "client-a", accountId: "account-a", action: "comment_generated", target: "https://www.instagram.com/p/AAA/", commentText: "Lovely harbour", requestedBy: "va", taskId: "task-1" };
  const pending = approvalStore.request(ask);
  const listed = await request("va", "/api/research/account-a/approvals?state=pending");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.approvals.map(item => item.id), [pending.id]);
  assert.equal(listed.body.approvals[0].commentText, "Lovely harbour");

  assert.equal((await request("va", `/api/research/account-a/approvals/${pending.id}/approve`, "POST")).status, 403, "a VA cannot approve");
  assert.equal((await request("boss-b", `/api/research/account-b/approvals/${pending.id}/approve`, "POST")).status, 404, "another client's account cannot see or decide it");
  assert.equal((await request("boss-b", `/api/research/account-a/approvals/${pending.id}/approve`, "POST")).status, 403);
  assert.equal((await request("manager", "/api/research/account-a/approvals/apr-nope/approve", "POST")).status, 404);

  const approved = await request("manager", `/api/research/account-a/approvals/${pending.id}/approve`, "POST", { reason: "on brand" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approval.state, "APPROVED");
  assert.equal(approved.body.approval.decidedBy, "manager");
  assert.equal(approvalStore.findApproved(ask).id, pending.id, "the worker will now find it");
  assert.equal((await request("boss", `/api/research/account-a/approvals/${pending.id}/reject`, "POST")).status, 409, "a decision is final");
  assert.ok(auditLog.listEvents().some(event => event.type === "approval_decided" && event.operator === "manager" && event.detail.approvalId === pending.id));

  const second = approvalStore.request({ ...ask, target: "https://www.instagram.com/p/BBB/" });
  const rejected = await request("boss", `/api/research/account-a/approvals/${second.id}/reject`, "POST", { reason: "off-topic" });
  assert.equal(rejected.body.approval.state, "REJECTED");
  assert.equal(approvalStore.findApproved({ ...ask, target: "https://www.instagram.com/p/BBB/" }), null);
});

// ---- reports --------------------------------------------------------------------------------

test("a finished session's report is readable by its workspace and nobody else", async () => {
  const run = createRun("client-a", "account-a", { platform: "instagram", timeWindow: {}, overview: "start", candidates: [] });
  assert.equal((await request("va", `/api/research/account-a/runs/${run.id}/report`)).body.report, null, "no report while the session is still running");
  assert.equal((await request("va", `/api/research/account-a/runs/${run.id}/report`)).body.finished, false);
  finalizeRun("client-a", "account-a", run.id, { overview: "done", outcome: "PARTIAL", session: { steps: 4, cost: { totalUsd: 0.2 }, stoppedBecause: "step budget reached (4)" } });
  const report = await request("manager", `/api/research/account-a/runs/${run.id}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.body.report.steps, 4);
  assert.equal(report.body.outcome, "PARTIAL");
  assert.equal(report.body.finished, true);
  assert.equal((await request("va", "/api/research/account-a/runs/run-missing/report")).status, 404);
  assert.equal((await request("boss-b", `/api/research/account-a/runs/${run.id}/report`)).status, 403);
});

// ---- fleet monitor + interventions ---------------------------------------------------------------

test("the AI fleet monitor is for managers and admins and shows only the accounts they may see", async () => {
  assert.equal((await request("va", "/api/fleet/ai")).status, 403);
  const monitor = await request("manager", "/api/fleet/ai");
  assert.equal(monitor.status, 200);
  assert.deepEqual(monitor.body.workers, []);
  assert.equal(monitor.body.activeWorkers, 0);
  assert.deepEqual(monitor.body.interventions, { open: 0, claimed: 0 });
  assert.equal(fleetPolicy.settings.affinity["account-a"], "mock-1", "the research config pinned account-a to mock-1");
});

test("interventions: managers see and work their clients' items only; claiming is exclusive; resolving closes the item", async () => {
  const mine = interventionQueue.open({ taskId: "task-a", accountId: "account-a", workspaceId: "client-a", platform: "instagram", deviceId: "mock-1", reason: "security or account challenge: captcha" });
  const theirs = interventionQueue.open({ taskId: "task-b", accountId: "account-b", workspaceId: "client-b", platform: "x", reason: "model confidence 0.2 is below 0.6" });
  assert.equal((await request("va", "/api/fleet/interventions")).status, 403);

  const seen = await request("manager", "/api/fleet/interventions");
  assert.deepEqual(seen.body.interventions.map(item => item.id), [mine.id], "client B's item is invisible");
  assert.equal(seen.body.interventions[0].kind, "challenge");
  assert.equal((await request("manager", `/api/fleet/interventions/${theirs.id}/claim`, "POST")).status, 404);

  assert.equal((await request("manager", `/api/fleet/interventions/${mine.id}/claim`, "POST")).body.intervention.claimedBy, "manager");
  const conflict = await request("boss", `/api/fleet/interventions/${mine.id}/claim`, "POST");
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /Already claimed by manager/);
  assert.equal((await request("manager", "/api/fleet/ai")).body.interventions.claimed, 1);

  const resolved = await request("manager", `/api/fleet/interventions/${mine.id}/resolve`, "POST", { resolution: "solved the captcha by hand" });
  assert.equal(resolved.body.intervention.state, "RESOLVED");
  assert.equal(resolved.body.intervention.resolution, "solved the captcha by hand");
  assert.deepEqual((await request("manager", "/api/fleet/interventions")).body.interventions, []);
  assert.deepEqual((await request("boss-b", "/api/fleet/interventions")).body.interventions.map(item => item.id), [theirs.id]);
});

// ---- MS13: search, near-duplicates, analytics ---------------------------------------------------

test("search finds recorded posts by what they say, finds near-duplicates, and never crosses clients", async () => {
  const { appendCandidate } = await import("../../src/researchStore.js");
  const run = createRun("client-a", "account-a", { platform: "instagram", timeWindow: {}, overview: "search fixtures", candidates: [] });
  const harbour = appendCandidate("client-a", "account-a", run.id, { canonical_url: "https://www.instagram.com/p/H1/", text_extract: "Sunrise over the harbour with fishing boats and gulls", ai_summary: "harbour sunrise" });
  const repost = appendCandidate("client-a", "account-a", run.id, { canonical_url: "https://www.instagram.com/p/H2/", text_extract: "Sunrise over the harbour with fishing boats and gulls", ai_summary: "harbour sunrise repost" });
  appendCandidate("client-a", "account-a", run.id, { canonical_url: "https://www.instagram.com/p/C1/", text_extract: "Cast iron cornbread recipe with honey butter" });
  const other = createRun("client-b", "account-b", { platform: "x", timeWindow: {}, overview: "other client", candidates: [] });
  appendCandidate("client-b", "account-b", other.id, { canonical_url: "https://x.com/i/status/1", text_extract: "harbour secrets of another client" });

  const found = await request("va", "/api/research/account-a/search?q=harbour%20sunrise");
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.results.map(item => item.candidate.canonical_url).sort(), ["https://www.instagram.com/p/H1/", "https://www.instagram.com/p/H2/"]);
  assert.ok(found.body.results.every(item => !/another client/.test(JSON.stringify(item))), "nothing from client B");

  const similar = await request("manager", `/api/research/account-a/search?similarTo=${harbour.id}`);
  assert.equal(similar.status, 200);
  assert.deepEqual(similar.body.matches.map(item => item.candidate.id), [repost.id]);
  assert.ok(similar.body.matches[0].similarity >= 0.6);

  assert.equal((await request("va", "/api/research/account-a/search")).status, 400, "a query is required");
  assert.equal((await request("va", "/api/research/account-a/search?similarTo=cand-missing")).status, 404);
  assert.equal((await request("boss-b", "/api/research/account-a/search?q=harbour")).status, 403, "another client cannot search this account");
});

test("fleet analytics: managers see their own clients' intervention statistics and the optimization status", async () => {
  interventionQueue.open({ taskId: "task-analytics", accountId: "account-a", workspaceId: "client-a", platform: "instagram", deviceId: "mock-1", reason: "security or account challenge: captcha" });
  assert.equal((await request("va", "/api/fleet/analytics")).status, 403);
  const mine = await request("manager", "/api/fleet/analytics");
  assert.equal(mine.status, 200);
  assert.ok(mine.body.interventions.open >= 1);
  assert.equal(mine.body.interventions.byPlatform.x, undefined, "client B's platform is not counted");
  assert.deepEqual(mine.body.optimizations.enabled, [], "optimizations are off unless configured");
  assert.deepEqual(mine.body.optimizations.routing.byTier, { local: 0, cheap: 0, strong: 0 });
});
