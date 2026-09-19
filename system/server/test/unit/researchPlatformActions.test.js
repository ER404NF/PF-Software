import { test } from "node:test";
import assert from "node:assert/strict";
import { runResearchStep } from "../../src/researchWorker.js";
import { TASK_STATES } from "../../src/taskSpec.js";
import { ApprovalStore } from "../../src/approvalStore.js";
import { CommentLedger } from "../../src/commentGuard.js";
import { TemplateLibrary } from "../../src/commentTemplates.js";

const URL_1 = "https://www.instagram.com/p/AAA/";
const CANDIDATE = { id: "cand-1", canonical_url: URL_1, text_extract: "Sunrise over the harbour with fishing boats", tags: ["harbour"], source_handle: "@port" };

function setup({ action = "platform_save", policy = "ALLOW_AUTONOMOUS", comment = null, executeOutcome = "VERIFIED",
  recorded = true, verifyResult = true } = {}) {
  const events = [];
  const mirrored = [];
  const audit = [];
  const task = { id: "task-1", state: TASK_STATES.RUNNING, goal: "Collect harbour content", createdBy: "boss",
    deviceSelector: { deviceId: "dev-1" }, accountSelector: { platform: "instagram" }, allowedActions: [] };
  const decision = { screen_state: "post", goal_progress: "working", action, target: URL_1, reason: "great match", confidence: 0.9,
    ...(comment ? { comment } : {}) };
  const skill = {
    name: "fake", platform: "instagram", skillVersion: "1", appVersion: "1", supportedActions: [action],
    async detectState() { return "post"; },
    async availableActions() { return [action]; },
    async execute() { events.push("execute"); return { kind: "toggle", outcome: executeOutcome }; },
    async verify() { events.push("verify"); return verifyResult; },
    async recover() { return {}; },
  };
  const taskQueue = { getTask: () => task, results: [], checkpoints: [], checkpoint(id, data) { this.checkpoints.push(data); },
    async reportResult(id, outcome, options) { this.results.push([outcome, options?.detail]); task.state = outcome; } };
  const deviceLease = { getAiToken: () => "lease", canAiAct: () => true, registerPendingAiAction() {}, clearPendingAiAction() {} };
  const ledger = new CommentLedger();
  const originalRecord = ledger.record.bind(ledger);
  ledger.record = entry => { events.push("ledger"); return originalRecord(entry); };
  const ctx = {
    task, device: { id: "dev-1", async getUiTree() { return { screen: "post" }; } },
    provider: { async observeAndPlan() { return { ...decision }; } },
    skill, taskQueue, deviceLease,
    accountWorkspaces: new Map([["acct", "ws"]]),
    accountPolicies: new Map([["acct", { [action]: policy }]]),
    canAccessAccount: () => true, accountId: "acct", workspaceId: "ws",
    approvals: new ApprovalStore(), commentLedger: ledger, templates: new TemplateLibrary(),
    auditLog: { logEvent: event => audit.push(event) },
    locateCandidate: target => (recorded && target === URL_1 ? { runId: "run-1", candidate: CANDIDATE } : null),
    recordPlatformAction: (workspaceId, account, runId, candidateId, entry) => { mirrored.push({ workspaceId, account, runId, candidateId, ...entry }); return { added: true }; },
  };
  return { ...ctx, ctx, events, mirrored, audit, decision };
}

test("a DISABLED platform action is rejected before it can reach the Device API", async () => {
  for (const action of ["platform_save", "like", "upvote", "repost", "comment_generated"]) {
    const env = setup({ action, policy: "DISABLED", comment: action.startsWith("comment") ? { text: "Harbour boats", source: "generated" } : null });
    const result = await runResearchStep(env.ctx);
    assert.equal(result.outcome, TASK_STATES.FAILED_FINAL, action);
    assert.deepEqual(env.events, [], `${action}: nothing executed`);
    assert.deepEqual(env.mirrored, []);
  }
});

test("a REQUIRE_APPROVAL action is held: nothing runs, a request is created, and it is audited", async () => {
  const env = setup({ policy: "REQUIRE_APPROVAL" });
  const result = await runResearchStep(env.ctx);
  assert.equal(result.outcome, TASK_STATES.NEEDS_HUMAN);
  assert.deepEqual(env.events, []);
  assert.match(env.taskQueue.results[0][1], /waiting for approval \(apr-/);
  assert.equal(env.approvals.list({ workspaceId: "ws" }).length, 1);
  assert.equal(env.approvals.list()[0].requestedBy, "boss");
  assert.ok(env.audit.some(event => event.type === "approval_requested" && event.detail.action === "platform_save"));
});

test("once approved, the same action runs exactly once, is audited and mirrored, and the approval is used up", async () => {
  const env = setup({ policy: "REQUIRE_APPROVAL" });
  await runResearchStep(env.ctx);
  const [approval] = env.approvals.list();
  env.approvals.decide(approval.id, { decision: "approve", decidedBy: "manager" });
  env.task.state = TASK_STATES.RUNNING; // the supervisor resumed the task

  const result = await runResearchStep(env.ctx);
  assert.equal(result.outcome, "VERIFIED");
  assert.deepEqual(env.events, ["execute", "verify"]);
  assert.equal(env.mirrored.length, 1);
  assert.deepEqual([env.mirrored[0].action, env.mirrored[0].status, env.mirrored[0].approval_id, env.mirrored[0].candidateId],
    ["platform_save", "VERIFIED", approval.id, "cand-1"]);
  const executed = env.audit.find(event => event.type === "platform_action");
  assert.equal(executed.detail.approvalId, approval.id);
  assert.equal(env.approvals.get(approval.id).state, "CONSUMED");

  env.task.state = TASK_STATES.RUNNING;
  const again = await runResearchStep(env.ctx);
  assert.equal(again.outcome, TASK_STATES.NEEDS_HUMAN, "the approval was single-use");
  assert.equal(env.events.filter(event => event === "execute").length, 1);
});

test("an approval for one wording never lets a different comment through", async () => {
  const env = setup({ action: "comment_generated", policy: "REQUIRE_APPROVAL", comment: { text: "Harbour boats are lovely", source: "generated" } });
  await runResearchStep(env.ctx);
  const [approval] = env.approvals.list();
  env.approvals.decide(approval.id, { decision: "approve", decidedBy: "manager" });
  env.task.state = TASK_STATES.RUNNING;
  env.ctx.provider = { async observeAndPlan() { return { ...env.decision, comment: { text: "Something totally different about the harbour", source: "generated" } }; } };
  const result = await runResearchStep(env.ctx);
  assert.equal(result.outcome, TASK_STATES.NEEDS_HUMAN);
  assert.deepEqual(env.events, []);
  assert.equal(env.approvals.list().length, 2, "a fresh request was opened for the new wording");
});

test("acting on content that has no research record yet is refused, and retried later rather than lost", async () => {
  const env = setup({ recorded: false });
  const result = await runResearchStep(env.ctx);
  assert.equal(result.outcome, TASK_STATES.FAILED_RETRYABLE);
  assert.match(env.taskQueue.results[0][1], /record it before acting/);
  assert.deepEqual(env.events, []);
});

test("re-running a save that is already in place is a NOOP: recorded as such, no second press", async () => {
  const env = setup({ executeOutcome: "NOOP" });
  const result = await runResearchStep(env.ctx);
  assert.equal(result.outcome, "VERIFIED");
  assert.equal(env.mirrored[0].status, "NOOP");
  assert.equal(env.audit.find(event => event.type === "platform_action").detail.status, "NOOP");
});

test("a comment that repeats an earlier one is not sent; a human is told why", async () => {
  const env = setup({ action: "comment_generated", policy: "ALLOW_AUTONOMOUS", comment: { text: "Harbour boats are lovely", source: "generated" } });
  env.commentLedger.record({ workspaceId: "ws", accountId: "acct", platform: "instagram", contentKey: "https://other.example/p/9", text: "Harbour boats are lovely!", source: "generated" });
  env.events.length = 0;
  const result = await runResearchStep(env.ctx);
  assert.equal(result.outcome, TASK_STATES.NEEDS_HUMAN);
  assert.match(env.taskQueue.results[0][1], /almost identical|exact comment/);
  assert.deepEqual(env.events, [], "never reached the phone");
  assert.ok(env.audit.some(event => event.type === "comment_rejected"));
});

test("a comment must be about the content it sits under", async () => {
  const env = setup({ action: "comment_generated", policy: "ALLOW_AUTONOMOUS", comment: { text: "Great content, keep it up my friend", source: "generated" } });
  const result = await runResearchStep(env.ctx);
  assert.equal(result.outcome, TASK_STATES.NEEDS_HUMAN);
  assert.match(env.taskQueue.results[0][1], /does not refer to the content/);
});

test("an allowed comment is written to the ledger BEFORE it is sent, then mirrored exactly as sent", async () => {
  const env = setup({ action: "comment_generated", policy: "ALLOW_AUTONOMOUS", comment: { text: "Harbour boats are lovely", source: "generated" } });
  env.events.length = 0;
  const result = await runResearchStep(env.ctx);
  assert.equal(result.outcome, "VERIFIED");
  assert.deepEqual(env.events, ["ledger", "execute", "verify"], "ledger first, so a retry can never double-post");
  assert.equal(env.mirrored[0].text, "Harbour boats are lovely");
  assert.equal(env.mirrored[0].source, "generated");
});

test("a preset comment must be an approved template word for word", async () => {
  const env = setup({ action: "comment_preset", policy: "ALLOW_AUTONOMOUS", comment: { text: "Thanks for sharing this!", source: "preset", template_id: "tpl-missing" } });
  assert.equal((await runResearchStep(env.ctx)).outcome, TASK_STATES.NEEDS_HUMAN, "unknown template");
  const template = env.templates.add({ workspaceId: "ws", text: "Thanks for sharing this!" });
  const ok = setup({ action: "comment_preset", policy: "ALLOW_AUTONOMOUS", comment: { text: "Thanks for sharing this!", source: "preset", template_id: "x" } });
  ok.templates.templates.push({ ...template, id: "x" });
  ok.ctx.templates = ok.templates;
  assert.equal((await runResearchStep(ok.ctx)).outcome, "VERIFIED");
});

test("a platform action that cannot be confirmed is never retried automatically; a human checks the account", async () => {
  const env = setup({ verifyResult: false });
  const result = await runResearchStep(env.ctx);
  assert.equal(result.outcome, TASK_STATES.NEEDS_HUMAN);
  assert.match(env.taskQueue.results[0][1], /could not be confirmed/);
  assert.ok(env.audit.some(event => event.type === "platform_action_unconfirmed"));
  assert.equal(env.mirrored.length, 0, "an unconfirmed action is not recorded as done");
});
