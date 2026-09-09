import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createTaskQueue } from "../../src/taskQueue.js";
import { MockDevice } from "../../src/mockDevice.js";
import * as deviceLease from "../../src/deviceLease.js";
import { runResearchStep } from "../../src/researchWorker.js";
import { TASK_STATES } from "../../src/taskSpec.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-worker-integration-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => deviceLease.reset());

function build(decision) {
  const device = new MockDevice("dev-1", "Mock iPhone");
  const devices = new Map([[device.id, device]]);
  const events = [];
  const auditLog = { logEvent(event) { events.push(event); } };
  const queue = createTaskQueue({ devices, deviceLease, auditLog,
    storePath: path.join(root, `${crypto.randomUUID()}.json`) });
  const task = queue.addTask({ goal: "Find a strong post", createdBy: "admin", allowedActions: [decision.action],
    accountSelector: { platform: "instagram", accountId: "account-a" }, deviceSelector: { deviceId: "dev-1" } });
  const provider = { async observeAndPlan() { return decision; } };
  const skill = {
    name: "mock-instagram", platform: "instagram", skillVersion: "test-1", appVersion: "mock-1", supportedActions: ["open_post"],
    async detectState(observation) { return observation.ui_tree.screen; },
    async availableActions(state) { return state === "home" ? ["open_post"] : []; },
    async execute(_decision, { device: controlled }) { controlled.tap(70 / 375, 120 / 667); return { tapped: "instagram" }; },
    async verify(_decision, after) { return after.ui_tree?.screen === "app" && after.ui_tree?.app === "instagram"; },
    async recover() { return { recovered: false }; },
  };
  return { device, devices, events, auditLog, queue, task, provider, skill };
}

test("real queue + lease + mock device complete one verified research step", async () => {
  const ctx = build({ screen_state: "home", goal_progress: "working", action: "open_post", target: "Instagram", reason: "inspect it", confidence: 0.95 });
  assert.equal(ctx.task.state, TASK_STATES.RUNNING);
  assert.equal(deviceLease.canAiAct("dev-1"), true);
  const result = await runResearchStep({ task: ctx.task, device: ctx.device, provider: ctx.provider, skill: ctx.skill,
    accountId: "account-a", workspaceId: "client-a", accountWorkspaces: new Map([["account-a", "client-a"]]),
    accountPolicies: new Map([["account-a", { open_post: "ALLOW_AUTONOMOUS" }]]), taskQueue: ctx.queue,
    deviceLease, auditLog: ctx.auditLog, canAccessAccount: () => true });
  assert.equal(result.outcome, "VERIFIED");
  assert.equal(ctx.device.openApp, "instagram");
  assert.equal(ctx.queue.getTask(ctx.task.id).checkpoints.length, 1);
  assert.equal(deviceLease.canAiAct("dev-1"), true);
});

test("real queue hands the device to HUMAN when the model sees a challenge", async () => {
  const ctx = build({ screen_state: "captcha", goal_progress: "blocked", action: "open_post", target: null, reason: "challenge", confidence: 0.99 });
  const result = await runResearchStep({ task: ctx.task, device: ctx.device, provider: ctx.provider, skill: ctx.skill,
    accountId: "account-a", workspaceId: "client-a", accountWorkspaces: new Map([["account-a", "client-a"]]),
    accountPolicies: new Map([["account-a", { open_post: "ALLOW_AUTONOMOUS" }]]), taskQueue: ctx.queue,
    deviceLease, auditLog: ctx.auditLog, canAccessAccount: () => true });
  assert.equal(result.outcome, TASK_STATES.NEEDS_HUMAN);
  assert.equal(ctx.queue.getTask(ctx.task.id).state, TASK_STATES.NEEDS_HUMAN);
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");
  assert.ok(ctx.events.some((event) => event.type === "research_needs_human"));
});
