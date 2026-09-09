import { test } from "node:test";
import assert from "node:assert/strict";
import { runResearchStep } from "../../src/researchWorker.js";
import { TASK_STATES } from "../../src/taskSpec.js";

function setup({ screen = "feed", confidence = 0.9, policy = "ALLOW_AUTONOMOUS", revokeDuringDetection = false } = {}) {
  const task = { id: "task-1", state: TASK_STATES.RUNNING, goal: "Find useful posts", createdBy: "admin",
    deviceSelector: { deviceId: "dev-1" }, accountSelector: { platform: "instagram" }, allowedActions: [] };
  let lease = true;
  const calls = [];
  const device = { id: "dev-1", async getUiTree() { return { screen: "feed" }; } };
  const provider = { async observeAndPlan() { return { screen_state: screen, goal_progress: "working",
    action: "scroll_next", target: "feed", reason: "continue", confidence }; } };
  const skill = { name: "fake", platform: "instagram", skillVersion: "1", appVersion: "1", supportedActions: ["scroll_next"],
    async detectState() { calls.push("detect"); return "feed"; },
    async availableActions() { calls.push("available"); if (revokeDuringDetection) lease = false; return ["scroll_next"]; },
    async execute() { calls.push("execute"); return { swiped: true }; },
    async verify() { calls.push("verify"); return true; }, async recover() { calls.push("recover"); return {}; } };
  const taskQueue = { getTask: () => task, checkpoints: [], results: [], checkpoint(id, data) { this.checkpoints.push([id, data]); },
    async reportResult(id, outcome, options) { this.results.push([id, outcome, options]); task.state = outcome; } };
  const deviceLease = { canAiAct: () => lease, pending: null, registerPendingAiAction(id, promise) { this.pending = [id, promise]; },
    clearPendingAiAction(id, promise) { if (this.pending?.[0] === id && this.pending?.[1] === promise) this.pending = null; } };
  const accountWorkspaces = new Map([["account-a", "client-a"]]);
  const accountPolicies = new Map([["account-a", { scroll_next: policy }]]);
  return { task, device, provider, skill, taskQueue, deviceLease, accountWorkspaces, accountPolicies, calls,
    canAccessAccount: () => true, accountId: "account-a", workspaceId: "client-a" };
}

test("a verified read-only action is lease-registered and checkpointed", async () => {
  const ctx = setup();
  const result = await runResearchStep(ctx);
  assert.equal(result.outcome, "VERIFIED");
  assert.deepEqual(ctx.calls, ["detect", "available", "execute", "verify"]);
  assert.equal(ctx.deviceLease.pending, null);
  assert.equal(ctx.taskQueue.checkpoints.length, 1);
  assert.equal(ctx.taskQueue.checkpoints[0][1].action, "scroll_next");
});

test("a task cancelled while model planning is in flight is never overwritten by a late result", async () => {
  const ctx = setup({ screen: "captcha" });
  ctx.provider.observeAndPlan = async () => {
    ctx.task.state = TASK_STATES.CANCELLED;
    return { screen_state: "captcha", goal_progress: "blocked", action: "observe", target: null, reason: "challenge", confidence: 0.9 };
  };
  const result = await runResearchStep(ctx);
  assert.equal(result.outcome, TASK_STATES.CANCELLED);
  assert.equal(ctx.taskQueue.results.length, 0);
});

for (const input of [{ screen: "captcha" }, { screen: "feed", confidence: 0.2 }]) {
  test(`challenge/low-confidence decision hands off through the existing queue (${JSON.stringify(input)})`, async () => {
    const ctx = setup(input);
    const result = await runResearchStep(ctx);
    assert.equal(result.outcome, TASK_STATES.NEEDS_HUMAN);
    assert.equal(ctx.taskQueue.results[0][1], TASK_STATES.NEEDS_HUMAN);
    assert.equal(ctx.calls.length, 0);
  });
}

test("approval-required work hands off and disabled work never reaches a skill", async () => {
  const approval = setup({ policy: "REQUIRE_APPROVAL" });
  assert.equal((await runResearchStep(approval)).outcome, TASK_STATES.NEEDS_HUMAN);
  assert.equal(approval.calls.length, 0);
  const disabled = setup({ policy: "DISABLED" });
  assert.equal((await runResearchStep(disabled)).outcome, TASK_STATES.FAILED_FINAL);
  assert.equal(disabled.calls.length, 0);
  assert.equal(disabled.taskQueue.results[0][1], TASK_STATES.FAILED_FINAL);
});

test("lease revocation during state detection prevents the device action and creates no checkpoint", async () => {
  const ctx = setup({ revokeDuringDetection: true });
  const result = await runResearchStep(ctx);
  assert.equal(result.outcome, TASK_STATES.NEEDS_HUMAN);
  assert.equal(ctx.calls.includes("execute"), false);
  assert.equal(ctx.taskQueue.checkpoints.length, 0);
});

test("provider/observation and skill failures leave no zombie RUNNING task", async () => {
  const providerFailure = setup();
  providerFailure.provider.observeAndPlan = async () => { throw new Error("provider offline"); };
  assert.equal((await runResearchStep(providerFailure)).outcome, TASK_STATES.FAILED_RETRYABLE);
  assert.equal(providerFailure.taskQueue.results[0][1], TASK_STATES.FAILED_RETRYABLE);

  const skillFailure = setup();
  skillFailure.skill.execute = async () => { throw new Error("device action failed"); };
  assert.equal((await runResearchStep(skillFailure)).outcome, TASK_STATES.FAILED_RETRYABLE);
  assert.equal(skillFailure.taskQueue.results[0][1], TASK_STATES.FAILED_RETRYABLE);

  const recoveryFailure = setup();
  recoveryFailure.skill.execute = async () => { throw new Error("device action failed"); };
  recoveryFailure.skill.recover = async () => { throw new Error("recovery failed"); };
  const recoveryResult = await runResearchStep(recoveryFailure);
  assert.equal(recoveryResult.outcome, TASK_STATES.FAILED_RETRYABLE);
  assert.equal(recoveryResult.recoveryError, "recovery failed");
  assert.equal(recoveryFailure.taskQueue.results[0][1], TASK_STATES.FAILED_RETRYABLE);
});

test("account access is checked at entry and again immediately before execution", async () => {
  const denied = setup();
  denied.canAccessAccount = () => false;
  await assert.rejects(() => runResearchStep(denied), /authorization is not active/);

  let allowedNow = true;
  const revoked = setup();
  revoked.canAccessAccount = () => allowedNow;
  revoked.provider.observeAndPlan = async () => {
    allowedNow = false;
    return { screen_state: "feed", goal_progress: "working", action: "scroll_next", target: "feed", reason: "continue", confidence: 0.9 };
  };
  const result = await runResearchStep(revoked);
  assert.equal(result.outcome, TASK_STATES.FAILED_FINAL);
  assert.equal(revoked.calls.includes("execute"), false);
  assert.equal(revoked.taskQueue.results[0][1], TASK_STATES.FAILED_FINAL);
});

test("access or lease revocation during a failed action cannot trigger recovery input", async () => {
  let accountAllowed = true;
  const accountRevoked = setup();
  accountRevoked.canAccessAccount = () => accountAllowed;
  let accountRecoveryCalls = 0;
  accountRevoked.skill.execute = async () => { accountAllowed = false; throw new Error("interrupted"); };
  accountRevoked.skill.recover = async () => { accountRecoveryCalls += 1; return {}; };
  const accountResult = await runResearchStep(accountRevoked);
  assert.equal(accountResult.outcome, TASK_STATES.FAILED_FINAL);
  assert.equal(accountRecoveryCalls, 0);

  const leaseRevoked = setup();
  let leaseRecoveryCalls = 0;
  leaseRevoked.skill.execute = async () => {
    leaseRevoked.deviceLease.canAiAct = () => false;
    throw new Error("interrupted");
  };
  leaseRevoked.skill.recover = async () => { leaseRecoveryCalls += 1; return {}; };
  const leaseResult = await runResearchStep(leaseRevoked);
  assert.equal(leaseResult.outcome, TASK_STATES.NEEDS_HUMAN);
  assert.equal(leaseRecoveryCalls, 0);
});

test("worker rejects mismatched devices and missing active leases before observation", async () => {
  const mismatched = setup();
  mismatched.device.id = "dev-2";
  await assert.rejects(() => runResearchStep(mismatched), /does not match/);
  const noLease = setup({ revokeDuringDetection: true });
  noLease.deviceLease.canAiAct = () => false;
  await assert.rejects(() => runResearchStep(noLease), /lease is not active/);
});
