// MS13 wired into the real research runner: routing, the state cache, adaptive pacing, and
// the provider lifecycle hooks (noteOutcome / finish). Uses the real Instagram skill, real
// MockDevice, real task queue and device lease.
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
import { parseOptimizationConfig, createOptimizationRuntime } from "../../src/optimizationRuntime.js";
import { AdaptivePacing } from "../../src/optimization/adaptivePacing.js";

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-opt-wiring-")); deviceLease.reset(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function setup({ providerForTask, skillForPlatform, pacingForTask, sleep = async () => {} }) {
  const device = new MockDevice("mock-1", "Mock");
  const devices = new Map([[device.id, device]]);
  const queue = createTaskQueue({ devices, deviceLease, storePath: path.join(root, "tasks.json") });
  const runs = [];
  const runner = createResearchTaskRunner({ taskQueue: queue, devices, deviceLease,
    accountWorkspaces: new Map([["account-a", "client-a"]]),
    accountPolicies: new Map([["account-a", { open_feed: "ALLOW_AUTONOMOUS", observe: "ALLOW_AUTONOMOUS", scroll_next: "ALLOW_AUTONOMOUS" }]]),
    providerForTask, skillForPlatform, pacingForTask,
    operatorForUsername: () => ({ username: "admin", role: "admin", allowedDevices: null }),
    workspaceForOperatorAccount: () => "client-a", stepDelayMs: 0, sleep,
    createRunRecord(workspaceId, accountId, input) { const run = { id: `run-${runs.length + 1}`, ...input, candidates: [] }; runs.push(run); return run; },
    appendCandidateRecord(workspaceId, accountId, runId, candidate) {
      const run = runs.find(entry => entry.id === runId);
      const recorded = { id: `candidate-${run.candidates.length + 1}`, ...candidate }; run.candidates.push(recorded); return recorded;
    },
    finalizeRunRecord(workspaceId, accountId, runId, final) { const run = runs.find(entry => entry.id === runId); Object.assign(run, final, { completedAt: "now" }); return run; },
    saveEvidenceRecord() { return { ref: "/api/research/account-a/evidence/e.png" }; } });
  runner.start();
  return { device, queue, runner, runs };
}

const task = queue => queue.addTask({ kind: "research", goal: "Look at the feed", createdBy: "admin",
  accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["open_feed", "observe", "scroll_next"] });

const OPEN = { screen_state: "springboard", goal_progress: "working", action: "open_feed", target: "instagram", reason: "open", confidence: 0.99 };
const DONE = { screen_state: "feed", goal_progress: "complete", action: "observe", target: null, reason: "done", confidence: 0.99 };

test("config: off by default, 'on' enables everything, a list picks, a typo fails loudly", () => {
  assert.deepEqual(["router", "localPlanner", "stateCache", "pacing"].map(name => parseOptimizationConfig({})[name]), [false, false, false, false]);
  const on = parseOptimizationConfig({ PHONE_FARM_OPTIMIZATIONS: "on", PHONE_FARM_CHEAP_MODEL: "small" });
  assert.deepEqual([on.router, on.localPlanner, on.stateCache, on.pacing, on.cheapModel], [true, true, true, true, "small"]);
  const some = parseOptimizationConfig({ PHONE_FARM_OPTIMIZATIONS: "stateCache, pacing" });
  assert.deepEqual([some.router, some.stateCache, some.pacing], [false, true, true]);
  assert.throws(() => parseOptimizationConfig({ PHONE_FARM_OPTIMIZATIONS: "turbo" }), /unknown optimization "turbo"/);
  assert.throws(() => parseOptimizationConfig({ PHONE_FARM_ESCALATE_BELOW: "2" }), /ESCALATE_BELOW/);
});

test("with everything off the runtime is transparent: same provider, same skill, no pacing", () => {
  const provider = { name: "strong", async observeAndPlan() {} };
  const skill = createInstagramSkill({ appVersion: "t" });
  const runtime = createOptimizationRuntime({ config: parseOptimizationConfig({}), getProvider: () => provider, getPlatformSkill: () => skill });
  assert.equal(runtime.providerFor("strong", "instagram"), provider);
  assert.equal(runtime.skillFor("instagram"), skill);
  assert.equal(runtime.pacingFor(), null);
  assert.deepEqual(runtime.describe().enabled, []);
});

test("routing on: the closed-app step is handled locally, the strong model is asked only for the rest", async () => {
  let strongCalls = 0;
  const strong = { name: "strong", costPerStepUsd: 0.05, async observeAndPlan() { strongCalls += 1; return DONE; } };
  const runtime = createOptimizationRuntime({
    config: parseOptimizationConfig({ PHONE_FARM_OPTIMIZATIONS: "localPlanner,stateCache" }),
    getProvider: name => (name === "strong" ? strong : null),
    getPlatformSkill: () => createInstagramSkill({ appVersion: "t" }),
  });
  const { queue, runner, device } = setup({ providerForTask: () => runtime.providerFor("strong", "instagram"), skillForPlatform: platform => runtime.skillFor(platform) });
  const added = task(queue);
  await runner.waitForTask(added.id);
  assert.equal(queue.getTask(added.id).state, TASK_STATES.SUCCEEDED);
  assert.equal(device.openApp, "instagram", "the local rule really opened the app");
  assert.equal(strongCalls, 1, "only the second step needed a model");
  const summary = runtime.describe();
  assert.equal(summary.routing.byTier.local, 1);
  assert.equal(summary.routing.byTier.strong, 1);
  assert.ok(summary.stateCache.misses >= 1, "screens were classified through the cache");
});

test("routing never bypasses safety: a local rule cannot open the app if the task did not permit open_feed", async () => {
  let strongCalls = 0;
  const strong = { name: "strong", async observeAndPlan() { strongCalls += 1; return { ...DONE, screen_state: "springboard" }; } };
  const runtime = createOptimizationRuntime({
    config: parseOptimizationConfig({ PHONE_FARM_OPTIMIZATIONS: "localPlanner" }),
    getProvider: () => strong, getPlatformSkill: () => createInstagramSkill({ appVersion: "t" }),
  });
  const { queue, runner, device } = setup({ providerForTask: () => runtime.providerFor("strong", "instagram"), skillForPlatform: platform => runtime.skillFor(platform) });
  const added = queue.addTask({ kind: "research", goal: "Look", createdBy: "admin",
    accountSelector: { platform: "instagram", accountId: "account-a" }, allowedActions: ["observe"] });
  await runner.waitForTask(added.id);
  assert.equal(strongCalls, 1, "the model, not a local rule, decided");
  assert.equal(device.openApp, null, "the app was not opened behind the task's back");
  assert.equal(runtime.describe().routing.byTier.local, 0);
});

test("the runner tells a routing provider how each step went and when the session ended", async () => {
  const events = [];
  let call = 0;
  const provider = {
    name: "hooks",
    async observeAndPlan(observation, context) {
      call += 1;
      events.push(["plan", context.taskId ? "has-task-id" : "no-task-id", context.platform, [...context.permittedActions].sort().join(",")]);
      return call === 1 ? OPEN : DONE;
    },
    noteOutcome: outcome => events.push(["outcome", outcome.ok]),
    finish: taskId => events.push(["finish", Boolean(taskId)]),
  };
  const { queue, runner } = setup({ providerForTask: () => provider, skillForPlatform: () => createInstagramSkill({ appVersion: "t" }) });
  const added = task(queue);
  await runner.waitForTask(added.id);
  assert.deepEqual(events, [
    ["plan", "has-task-id", "instagram", "observe,open_feed,scroll_next"],
    ["outcome", true],
    ["plan", "has-task-id", "instagram", "observe,open_feed,scroll_next"],
    ["outcome", true],
    ["finish", true],
  ]);
});

test("adaptive pacing replaces the fixed wait between steps, and never waits less than the app needs", async () => {
  const waits = [];
  let call = 0;
  const LOOK = { screen_state: "feed", goal_progress: "working", action: "observe", target: null, reason: "still looking", confidence: 0.99 };
  const provider = { name: "p", async observeAndPlan() { call += 1; return call === 1 ? OPEN : call < 5 ? LOOK : DONE; } };
  const pacing = new AdaptivePacing({ baseMs: 400, settleMs: 300 });
  const { queue, runner } = setup({ providerForTask: () => provider, skillForPlatform: () => createInstagramSkill({ appVersion: "t" }),
    pacingForTask: () => pacing, sleep: async ms => { waits.push(ms); } });
  const added = task(queue);
  await runner.waitForTask(added.id);
  assert.equal(queue.getTask(added.id).state, TASK_STATES.SUCCEEDED);
  assert.ok(waits.length >= 2, "waited between steps");
  assert.ok(waits.every(ms => ms >= 300), `never below the settle time: ${waits}`);
  assert.ok(waits[waits.length - 1] >= waits[0], "an unchanged screen backs off rather than speeding up");
});
