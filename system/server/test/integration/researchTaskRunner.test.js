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

function setup({ provider = null, skill = createInstagramSkill({ appVersion: "fixture-1" }) } = {}) {
  const device = new MockDevice("mock-1", "Mock");
  const devices = new Map([[device.id, device]]);
  const queue = createTaskQueue({ devices, deviceLease, storePath: path.join(root, "tasks.json") });
  const workspaceMap = new Map([["account-a", "client-a"]]);
  const policies = new Map([["account-a", { open_feed: "ALLOW_AUTONOMOUS", observe: "ALLOW_AUTONOMOUS" }]]);
  const runs = [];
  const runner = createResearchTaskRunner({ taskQueue: queue, devices, deviceLease,
    accountWorkspaces: workspaceMap, accountPolicies: policies,
    providerForTask: () => provider, skillForPlatform: () => skill,
    operatorForUsername: () => ({ username: "admin" }),
    workspaceForOperatorAccount: () => "client-a", stepDelayMs: 0, sleep: async () => {},
    createRunRecord(workspaceId, accountId, input) {
      const run = { id: `run-${runs.length + 1}`, workspaceId, accountId, ...input, candidates: [] };
      runs.push(run); return run;
    },
    appendCandidateRecord(workspaceId, accountId, runId, candidate) {
      const run = runs.find((entry) => entry.id === runId);
      const recorded = { id: `candidate-${run.candidates.length + 1}`, ...candidate };
      run.candidates.push(recorded); return recorded;
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
  assert.equal(queue.getTask(task.id).checkpoints.some((entry) => entry.data?.recordType === "content_candidate"), true);
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
    operatorForUsername: () => ({ username: "admin" }), workspaceForOperatorAccount: () => "client-a",
    stepDelayMs: 0, sleep: async () => { selected = "second"; },
    createRunRecord: () => ({ id: "run-switch" }), appendCandidateRecord: () => ({ id: "unused" }) });
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
