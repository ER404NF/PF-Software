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
import { InterventionQueue } from "../../src/interventionQueue.js";
import { SpendTracker } from "../../src/fleetPolicy.js";

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-session-")); deviceLease.reset(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// A scripted "model": opens the feed, then keeps finding candidates.
function scriptedProvider({ failOnCall = null, candidates = 10, costUsd = 0.05 } = {}) {
  let call = 0;
  const provider = {
    calls: () => call,
    async observeAndPlan() {
      call += 1;
      if (failOnCall === call) throw new Error("temporary model outage");
      if (call === 1) {
        return { screen_state: "springboard", goal_progress: "working", action: "open_feed", target: "instagram", reason: "open", confidence: 0.95, usage: { cost_usd: costUsd } };
      }
      const index = call - 1;
      if (index > candidates) return { screen_state: "feed", goal_progress: "complete", action: "observe", target: null, reason: "nothing more", confidence: 0.95, usage: { cost_usd: costUsd } };
      return {
        screen_state: "feed", goal_progress: "working", action: "observe", target: null, reason: `harbour sunrise post ${index}`, confidence: 0.95, usage: { cost_usd: costUsd },
        candidate: { canonical_url: `https://www.instagram.com/p/POST${index}/`, source_handle: "@port", text_extract: "Sunrise over the harbour with boats",
          metrics: { likes: 5000, comments: 100, age_hours: 3 } },
      };
    },
  };
  return provider;
}

function setup({ provider, quota = {}, profile = { keywords: ["harbour", "sunrise"], minScore: 0.3 } } = {}) {
  const device = new MockDevice("mock-1", "Mock");
  const devices = new Map([[device.id, device]]);
  const queue = createTaskQueue({ devices, deviceLease, storePath: path.join(root, "tasks.json") });
  const runs = [];
  const interventions = new InterventionQueue();
  const spend = new SpendTracker();
  const runner = createResearchTaskRunner({
    taskQueue: queue, devices, deviceLease,
    accountWorkspaces: new Map([["account-a", "client-a"]]),
    accountPolicies: new Map([["account-a", { open_feed: "ALLOW_AUTONOMOUS", observe: "ALLOW_AUTONOMOUS" }]]),
    providerForTask: () => provider, skillForPlatform: () => createInstagramSkill({ appVersion: "fixture-1" }),
    operatorForUsername: () => ({ username: "admin", role: "admin", allowedDevices: null }),
    workspaceForOperatorAccount: () => "client-a", stepDelayMs: 0, sleep: async () => {},
    sessionQuotaForTask: () => quota, scoringProfileForTask: () => profile, interventions, spend,
    createRunRecord(workspaceId, accountId, input) { const run = { id: `run-${runs.length + 1}`, workspaceId, accountId, ...input, candidates: [] }; runs.push(run); return run; },
    appendCandidateRecord(workspaceId, accountId, runId, candidate) { const run = runs.find(entry => entry.id === runId); const recorded = { id: `cand-${run.candidates.length + 1}`, ...candidate }; run.candidates.push(recorded); return recorded; },
    finalizeRunRecord(workspaceId, accountId, runId, final) { const run = runs.find(entry => entry.id === runId); Object.assign(run, final, { completedAt: "2026-09-19T00:00:00.000Z" }); return run; },
    getRunRecord: (workspaceId, accountId, runId) => runs.find(entry => entry.id === runId) ?? null,
    saveEvidenceRecord() { return { ref: "/evidence/x.png" }; },
  });
  runner.start();
  const addTask = () => queue.addTask({ kind: "research", goal: "Collect harbour content", createdBy: "admin",
    accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["open_feed", "observe"],
    retryPolicy: { maxRetries: 2, backoffMs: 0 } });
  return { queue, runner, runs, interventions, spend, addTask };
}

test("SUCCEEDED: a session that reaches its candidate quota stops by itself and reports what it found, did and spent", async () => {
  const { queue, runner, runs, addTask, spend } = setup({ provider: scriptedProvider(), quota: { maxCandidates: 3 } });
  const task = addTask();
  await runner.waitForTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SUCCEEDED);
  assert.equal(runs[0].candidates.length, 3, "stopped at the quota, not at the model's whim");
  assert.equal(runs[0].outcome, "SUCCEEDED");
  const report = runs[0].session;
  assert.equal(report.stoppedBecause, "candidate quota reached (3)");
  assert.equal(report.candidates.kept, 3);
  assert.equal(report.steps, 4, "open the feed, then three candidate steps");
  assert.equal(report.cost.totalUsd, 0.2);
  assert.equal(report.cost.perCandidateUsd, 0.0667);
  assert.equal(report.actions.byType.observe, 3);
  assert.ok(report.latencyMs.p50 >= 0);
  assert.ok(runs[0].candidates.every(candidate => candidate.score > 0.5), "scored by the profile");
  assert.equal(spend.totalUsd(), 0.2, "the fleet's rolling spend saw it too");
});

test("candidates the profile scores too low are recorded but do not count towards the quota", async () => {
  const { queue, runner, runs, addTask } = setup({
    provider: scriptedProvider({ candidates: 4 }), quota: { maxCandidates: 2 },
    profile: { keywords: ["kitchen", "recipe", "pasta"], weights: { relevance: 1, engagement: 0, recency: 0 }, minScore: 0.5 },
  });
  const task = addTask();
  await runner.waitForTask(task.id);
  assert.equal(runs[0].candidates.length, 4, "everything seen is on record for review");
  assert.equal(runs[0].session.candidates.kept, 0);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SUCCEEDED, "ran to the model's own completion instead");
});

test("PARTIAL: a step budget ends a runaway session with the reason, keeping what it found", async () => {
  const { queue, runner, runs, addTask } = setup({ provider: scriptedProvider({ candidates: 50 }), quota: { maxSteps: 4, maxCandidates: 50 } });
  const task = addTask();
  await runner.waitForTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.PARTIAL);
  assert.equal(runs[0].outcome, TASK_STATES.PARTIAL);
  assert.equal(runs[0].session.steps, 4);
  assert.match(queue.getTask(task.id).result.detail, /step budget reached \(4\)/);
  assert.ok(runs[0].candidates.length >= 2, "the candidates found are kept");
});

test("PARTIAL: a cost ceiling stops the session before it overspends", async () => {
  const { queue, runner, runs, addTask } = setup({ provider: scriptedProvider({ candidates: 50, costUsd: 0.4 }), quota: { maxCostUsd: 1, maxCandidates: 50 } });
  const task = addTask();
  await runner.waitForTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.PARTIAL);
  assert.match(queue.getTask(task.id).result.detail, /cost budget reached/);
  assert.ok(runs[0].session.cost.totalUsd <= 1.2, `spent ${runs[0].session.cost.totalUsd}`);
});

test("an injected mid-session model failure is survived: the session resumes, finishes, and the report shows the recovery", async () => {
  // (the failed call uses up one of the script's positions, so give it one spare)
  const provider = scriptedProvider({ failOnCall: 3, candidates: 6 });
  const { queue, runner, runs, addTask } = setup({ provider, quota: { maxCandidates: 4 } });
  const task = addTask();
  await runner.waitForTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SUCCEEDED, "one outage does not sink the session");
  const report = runs[0].session;
  assert.ok(report.failures.some(failure => /temporary model outage/.test(failure.error)), "the failure is on the record");
  assert.ok(report.recoveries.some(recovery => recovery.kind === "step_retry"), "and so is the recovery");
  assert.equal(report.candidates.kept, 4);
  assert.equal(new Set(runs[0].candidates.map(candidate => candidate.canonical_url)).size, 4, "no duplicates from the retry");
});

test("a persistent failure stops the session as PARTIAL instead of hammering the phone", async () => {
  let calls = 0;
  const provider = { async observeAndPlan() {
    calls += 1;
    if (calls <= 2) return { screen_state: "springboard", goal_progress: "working", action: "open_feed", target: "instagram", reason: "open", confidence: 0.95 };
    throw new Error("model provider is down");
  } };
  const { queue, runner, runs, addTask } = setup({ provider, quota: { maxConsecutiveFailures: 2 } });
  const task = queue.addTask({ kind: "research", goal: "g", createdBy: "admin", accountSelector: { platform: "instagram", accountId: "account-a" },
    allowedActions: ["open_feed", "observe"], retryPolicy: { maxRetries: 10, backoffMs: 0 } });
  await runner.waitForTask(task.id);
  const state = queue.getTask(task.id).state;
  assert.ok([TASK_STATES.PARTIAL, TASK_STATES.FAILED_FINAL].includes(state), `ended as ${state}`);
  assert.ok(calls < 12, `stopped after ${calls} model calls`);
  assert.ok(runs.length <= 1);
});

test("a hand-off to a person appears in the intervention queue and closes when the task carries on", async () => {
  let calls = 0;
  const provider = { async observeAndPlan() {
    calls += 1;
    if (calls === 1) return { screen_state: "captcha", goal_progress: "blocked", action: "observe", target: null, reason: "captcha shown", confidence: 0.95 };
    return { screen_state: "feed", goal_progress: "complete", action: "observe", target: null, reason: "done", confidence: 0.95 };
  } };
  const { queue, runner, interventions, addTask } = setup({ provider });
  const task = addTask();
  await runner.waitForTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.NEEDS_HUMAN);
  const open = interventions.list({ states: ["OPEN"] });
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, "challenge");
  assert.deepEqual([open[0].accountId, open[0].workspaceId, open[0].platform, open[0].deviceId], ["account-a", "client-a", "instagram", "mock-1"]);
});
