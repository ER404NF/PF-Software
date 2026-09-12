import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createTaskQueue } from "../../src/taskQueue.js";
import { createResearchTaskRunner } from "../../src/researchTaskRunner.js";
import { createInstagramSkill } from "../../src/platformSkills/instagramSkill.js";
import { MockDevice } from "../../src/mockDevice.js";
import * as deviceLease from "../../src/deviceLease.js";
import { TASK_STATES } from "../../src/taskSpec.js";

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-research-runner-")); deviceLease.reset(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function setup({ operatorForUsername = () => ({ username: "admin", role: "admin", allowedDevices: null }), sleep = async () => {}, provider = null, skill = createInstagramSkill({ appVersion: "fixture-1" }) } = {}) {
  const device = new MockDevice("mock-1", "Mock");
  const devices = new Map([[device.id, device]]);
  const queue = createTaskQueue({ devices, deviceLease, storePath: path.join(root, "tasks.json") });
  const workspaceMap = new Map([["account-a", "client-a"]]);
  const policies = new Map([["account-a", { open_feed: "ALLOW_AUTONOMOUS", observe: "ALLOW_AUTONOMOUS" }]]);
  const runs = [];
  const runner = createResearchTaskRunner({ taskQueue: queue, devices, deviceLease,
    accountWorkspaces: workspaceMap, accountPolicies: policies,
    providerForTask: () => provider, skillForPlatform: () => skill,
    operatorForUsername,
    workspaceForOperatorAccount: () => "client-a", stepDelayMs: 0, sleep,
    createRunRecord(workspaceId, accountId, input) {
      const run = { id: `run-${runs.length + 1}`, workspaceId, accountId, ...input, candidates: [] };
      runs.push(run); return run;
    },
    appendCandidateRecord(workspaceId, accountId, runId, candidate) {
      const run = runs.find((entry) => entry.id === runId);
      const recorded = { id: `candidate-${run.candidates.length + 1}`, ...candidate };
      run.candidates.push(recorded); return recorded;
    },
    finalizeRunRecord(workspaceId, accountId, runId, final) {
      const run = runs.find((entry) => entry.id === runId);
      Object.assign(run, final, { completedAt: "2026-09-09T00:00:00.000Z" });
      return run;
    },
    saveEvidenceRecord() { return { ref: "/api/research/account-a/evidence/evidence-fixture.png" }; } });
  runner.start();
  return { device, queue, runner, runs };
}

test("scheduler dispatch runs bounded research steps until the provider reports completion", async () => {
  let call = 0;
  const provider = { async observeAndPlan() {
    call += 1;
    return call === 1
      ? { screen_state: "springboard", goal_progress: "working", action: "open_feed", target: "instagram", reason: "open", confidence: 0.99 }
      : { screen_state: "feed", goal_progress: "complete", action: "observe", target: null, reason: "done", confidence: 0.99 };
  } };
  const { queue, runner, device } = setup({ provider });
  const task = queue.addTask({ kind: "research", goal: "Inspect feed", createdBy: "admin",
    accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["open_feed", "observe"] });
  await runner.waitForTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SUCCEEDED);
  assert.equal(queue.getTask(task.id).checkpoints.filter((entry) => entry.data?.verified).length, 2);
  assert.equal(queue.getTask(task.id).checkpoints.some((entry) => entry.data?.recordType === "research_run_started"), true);
  assert.equal(device.openApp, "instagram");
  assert.equal(deviceLease.getMode(device.id), "AI_IDLE");
});

test("missing provider fails a dispatched research task instead of leaving it RUNNING", async () => {
  const { queue, runner } = setup();
  const task = queue.addTask({ kind: "research", goal: "Inspect feed", createdBy: "admin",
    accountSelector: { platform: "instagram", accountId: "account-a" } });
  await runner.waitForTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.FAILED_FINAL);
  assert.match(queue.getTask(task.id).result.detail, /no model provider/);
});

test("an immediately redispatched retry stays attached to a worker", async () => {
  let calls = 0;
  const provider = { async observeAndPlan() {
    calls += 1;
    if (calls === 1) throw new Error("temporary model outage");
    return { screen_state: "springboard", goal_progress: "complete", action: "observe",
      target: null, reason: "recovered", confidence: 0.99 };
  } };
  const { queue, runner } = setup({ provider });
  const task = queue.addTask({ kind: "research", goal: "Retry safely", createdBy: "admin",
    accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["observe"],
    retryPolicy: { maxRetries: 1, backoffMs: 0 } });
  await runner.waitForTask(task.id);
  assert.equal(calls, 2);
  assert.equal(queue.getTask(task.id).retryCount, 1);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SUCCEEDED);
  assert.equal(deviceLease.getMode("mock-1"), "AI_IDLE");
});

test("a verified candidate is written to the task's durable research run", async () => {
  let call = 0;
  const provider = { async observeAndPlan() {
    call += 1;
    if (call === 1) return { screen_state: "springboard", goal_progress: "working", action: "open_feed",
      target: "instagram", reason: "open", confidence: 0.99 };
    return call === 2
      ? { screen_state: "feed", goal_progress: "candidate_found", action: "observe", target: null,
        reason: "useful post", confidence: 0.99,
        candidate: { platform_content_id: "post-1", canonical_url: "https://example.com/post-1", tags: ["hook"] } }
      : { screen_state: "feed", goal_progress: "complete", action: "observe", target: null, reason: "done", confidence: 0.99 };
  } };
  const { queue, runner, runs } = setup({ provider });
  const task = queue.addTask({ kind: "research", goal: "Collect a post", createdBy: "admin",
    accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["open_feed", "observe"] });
  await runner.waitForTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SUCCEEDED);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].candidates[0].platform_content_id, "post-1");
  assert.equal(runs[0].candidates[0].task_id, task.id);
  assert.deepEqual(runs[0].candidates[0].evidence_refs,
    ["/api/research/account-a/evidence/evidence-fixture.png"]);
  assert.equal(runs[0].overview, "done");
  assert.equal(runs[0].outcome, TASK_STATES.SUCCEEDED);
  assert.equal(queue.getTask(task.id).checkpoints.some((entry) => entry.data?.recordType === "content_candidate"), true);
  assert.equal(queue.getTask(task.id).checkpoints.some((entry) => entry.data?.recordType === "research_run_completed"), true);
});

test("the next decision uses a provider selected while the task is running", async () => {
  const calls = [];
  let selected = "first";
  const providerMap = {
    first: { async observeAndPlan() { calls.push("first"); return {
      screen_state: "springboard", goal_progress: "working", action: "open_feed", target: "instagram",
      reason: "open", confidence: 0.99 }; } },
    second: { async observeAndPlan() { calls.push("second"); return {
      screen_state: "feed", goal_progress: "complete", action: "observe", target: null,
      reason: "done", confidence: 0.99 }; } },
  };
  const device = new MockDevice("mock-1", "Mock");
  const devices = new Map([[device.id, device]]);
  const queue = createTaskQueue({ devices, deviceLease, storePath: path.join(root, "switch-tasks.json") });
  const runner = createResearchTaskRunner({ taskQueue: queue, devices, deviceLease,
    accountWorkspaces: new Map([["account-a", "client-a"]]),
    accountPolicies: new Map([["account-a", { open_feed: "ALLOW_AUTONOMOUS", observe: "ALLOW_AUTONOMOUS" }]]),
    providerForTask: () => providerMap[selected], skillForPlatform: () => createInstagramSkill({ appVersion: "fixture-1" }),
    operatorForUsername: () => ({ username: "admin", role: "admin", allowedDevices: null }), workspaceForOperatorAccount: () => "client-a",
    stepDelayMs: 0, sleep: async () => { selected = "second"; },
    createRunRecord: () => ({ id: "run-switch" }), appendCandidateRecord: () => ({ id: "unused" }),
    finalizeRunRecord: () => ({ id: "run-switch" }) });
  runner.start();
  const task = queue.addTask({ kind: "research", goal: "Switch providers", createdBy: "admin",
    accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["open_feed", "observe"] });
  await runner.waitForTask(task.id);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SUCCEEDED);
});

test("generic tasks are ignored by the research runner", () => {
  const { queue, runner } = setup();
  const task = queue.addTask({ goal: "Human-defined generic task", createdBy: "admin" });
  assert.equal(task.kind, "generic");
  assert.equal(runner.waitForTask(task.id), null);
  assert.equal(task.state, TASK_STATES.RUNNING);
});

for (const rapidResume of [false, true]) {
  test(`pause during planning retains the worker (rapid resume: ${rapidResume})`, async () => {
    let releaseModel, modelEntered;
    const planning = new Promise(resolve => { modelEntered = resolve; });
    const pendingModel = new Promise(resolve => { releaseModel = resolve; });
    let releaseSleep;
    const sleeping = new Promise(resolve => { releaseSleep = resolve; });
    let calls = 0;
    const provider = { async observeAndPlan() {
      if (++calls === 1) { modelEntered(); await pendingModel; }
      return { screen_state: "springboard", goal_progress: "complete", action: "observe",
        target: null, reason: "done", confidence: 0.99 };
    } };
    const { queue, runner } = setup({ provider, sleep: () => sleeping });
    const task = queue.addTask({ kind: "research", goal: "Pause safely", createdBy: "admin",
      accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["observe"] });
    const worker = runner.waitForTask(task.id);
    try {
      await planning;
      queue.pauseTask(task.id);
      if (rapidResume) queue.resumeTask(task.id);
      releaseModel();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(runner.waitForTask(task.id), worker, "worker must remain attached to paused/resumed task");
      assert.equal(calls, 1);
      if (!rapidResume) queue.resumeTask(task.id);
      releaseSleep();
      await worker;
      assert.equal(calls, 2, "resuming must obtain a fresh decision");
      assert.equal(queue.getTask(task.id).state, TASK_STATES.SUCCEEDED);
    } finally {
      queue.cancelTask(task.id);
      releaseModel();
      releaseSleep();
      await worker;
    }
  });
}

test("a paused research task resumes with a worker after restart", async () => {
  const device = new MockDevice("mock-1", "Mock");
  const originalQueue = createTaskQueue({ devices: new Map([[device.id, device]]), deviceLease,
    storePath: path.join(root, "tasks.json") });
  const task = originalQueue.addTask({ kind: "research", goal: "Resume after restart", createdBy: "admin",
    accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["observe"] });
  originalQueue.pauseTask(task.id);
  deviceLease.reset();
  let calls = 0;
  const { queue, runner } = setup({ provider: { async observeAndPlan() {
    calls++;
    return { screen_state: "springboard", goal_progress: "complete", action: "observe",
      target: null, reason: "done", confidence: 0.99 };
  } } });
  assert.equal(queue.getTask(task.id).state, TASK_STATES.PAUSED);
  assert.equal(deviceLease.getMode(device.id), "AI_PAUSED");
  assert.equal(calls, 0);
  queue.resumeTask(task.id);
  const worker = runner.waitForTask(task.id);
  assert.ok(worker, "resume must launch the recovered task's worker");
  await worker;
  assert.equal(calls, 1);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SUCCEEDED);
});

test("revoking device access during model planning blocks research input", async () => {
  const operator = { username: "admin", role: "admin", allowedDevices: ["mock-1"] };
  const { queue, runner, device } = setup({ operatorForUsername: () => operator, provider: { async observeAndPlan() {
    operator.allowedDevices = [];
    return { screen_state: "feed", goal_progress: "complete", action: "observe", target: null, reason: "done", confidence: 0.99 };
  } } });
  let actions = 0;
  device.swipe = async () => { actions++; };
  device.pressHome = async () => { actions++; };
  const task = queue.addTask({ kind: "research", goal: "Revoked", createdBy: "admin", accountSelector: { platform: "instagram", accountId: "account-a" } });
  await runner.waitForTask(task.id);
  assert.equal(actions, 0);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.FAILED_FINAL);
});

test("cancellation during evidence capture cannot finalize research as successful", async () => {
  const { queue, runner, runs, device } = setup({ provider: { async observeAndPlan() {
    return { screen_state: "springboard", goal_progress: "complete", action: "observe", target: null,
      reason: "candidate", confidence: 0.99, candidate: { canonical_url: "https://example.com/cancelled" } };
  } } });
  let task;
  device.render = async () => { queue.cancelTask(task.id); return { kind: "image", mime: "image/png", data: "eA==" }; };
  task = queue.addTask({ kind: "research", goal: "cancel evidence", createdBy: "admin",
    accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["observe"] });
  await runner.waitForTask(task.id);
  assert.equal(task.state, TASK_STATES.CANCELLED);
  assert.equal(runs[0].outcome, TASK_STATES.CANCELLED);
  assert.equal(runs[0].candidates.length, 0);
});

test("cancellation between steps finalizes the existing research run", async () => {
  let task, queueRef;
  const { queue, runner, runs } = setup({ provider: { async observeAndPlan() {
    return { screen_state: "springboard", goal_progress: "working", action: "observe", target: null, reason: "candidate",
      confidence: 0.99, candidate: { canonical_url: "https://example.com/interrupted" } };
  } }, sleep: async () => { queueRef.cancelTask(task.id); } });
  queueRef = queue;
  task = queue.addTask({ kind: "research", goal: "between steps", createdBy: "admin", accountSelector: { platform: "instagram", accountId: "account-a" } });
  await runner.waitForTask(task.id);
  assert.equal(task.state, TASK_STATES.CANCELLED);
  assert.equal(runs.length, 1); assert.equal(runs[0].outcome, TASK_STATES.CANCELLED);
  assert.ok(runs[0].completedAt); assert.equal(runs[0].candidates.length, 1);
});
