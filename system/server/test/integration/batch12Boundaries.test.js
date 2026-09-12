import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createTaskQueue } from "../../src/taskQueue.js";
import * as lease from "../../src/deviceLease.js";
import { createTaskSpec } from "../../src/taskSpec.js";
import { canAccessDevice } from "../../src/authStore.js";
import { WdaDevice } from "../../src/wdaDevice.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-batch12-"));
process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
const { runResearchStep } = await import("../../src/researchWorker.js");
const { createInstagramSkill } = await import("../../src/platformSkills/instagramSkill.js");
const { resolveResearchEvidence } = await import("../../src/researchEvidenceStore.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => lease.reset());
function queueFor(device, extra = {}) { return createTaskQueue({ devices: new Map([[device.id, device]]), deviceLease: lease, storePath: path.join(root, `${crypto.randomUUID()}.json`), ...extra }); }
for (const end of ["cancel", "stop", "window", "duration"]) {
  test(`${end} blocks redispatch until submitted AI input settles`, async () => {
    const device = { id: "d", status: "idle" };
    const queue = queueFor(device);
    const first = queue.addTask({ goal: "first", ...(end === "duration" ? { maxDurationSec: 1 } : {}) });
    const second = queue.addTask({ goal: "next" });
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    lease.registerPendingAiAction("d", pending);
    if (end === "cancel") queue.cancelTask(first.id);
    if (end === "stop") queue.stopDevice("d");
    if (end === "window") { first.latestEnd = new Date(Date.now() - 1).toISOString(); queue.tick(); }
    if (end === "duration") queue.tick(new Date(Date.parse(first.dispatchedAt) + 2000));
    assert.equal(second.state, "QUEUED");
    assert.equal(lease.canAiAct("d"), false);
    assert.equal(lease.canHumanSelect("d"), false);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.state, "RUNNING");
  });
}
test("current permissions override stored admission grants at dispatch and restart", () => {
  const operator = { allowedDevices: ["d"] };
  const device = { id: "d", status: "idle" };
  const storePath = path.join(root, "grants.json");
  const args = { storePath, canDispatch: (task, id) => canAccessDevice(operator, id) };
  const queue = queueFor(device, args);
  queue.pauseQueue();
  const task = queue.addTask({ goal: "queued", deviceSelector: { allowedDeviceIds: ["d"] } });
  operator.allowedDevices = [];
  queue.resumeQueue();
  assert.equal(task.state, "QUEUED");
  lease.reset();
  const restarted = queueFor(device, args);
  restarted.tick();
  assert.equal(restarted.getTask(task.id).state, "QUEUED");
});
for (const paused of [false, true]) test(`duration expires elapsed attempt time including pause=${paused}`, () => {
  const queue = queueFor({ id: "d", status: "idle" });
  const task = queue.addTask({ goal: "bounded", maxDurationSec: 1, allowOverrun: true });
  if (paused) queue.pauseTask(task.id);
  queue.tick(new Date(Date.parse(task.dispatchedAt) + 1000));
  assert.equal(task.state, "EXPIRED");
  assert.match(task.result.detail, /duration/);
});
test("invalid duration values are rejected", () => {
  for (const maxDurationSec of [-1, 0, Infinity, NaN, "1"]) assert.throws(() => createTaskSpec({ goal: "bounded", maxDurationSec }), /maxDurationSec/);
});
const frame = { kind: "image", mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=" };
function worker(action, tree = null) {
  let renders = 0, homes = 0;
  const device = { id: "d", status: "idle", async getUiTree() { return tree; }, async render() { renders++; return frame; }, async pressHome() { homes++; } };
  const taskQueue = queueFor(device);
  const task = taskQueue.addTask({ goal: "inspect", allowedActions: [action] });
  const args = { task, device, taskQueue, deviceLease: lease, skill: createInstagramSkill({ appVersion: "fixture" }),
    provider: { async observeAndPlan() { return { screen_state: "feed", goal_progress: "working", action, target: null, reason: "inspect", confidence: 0.99 }; } },
    workspaceId: "workspace", accountId: "account", accountWorkspaces: new Map([["account", "workspace"]]),
    accountPolicies: new Map([["account", { [action]: "ALLOW_AUTONOMOUS" }]]), canAccessAccount: () => true };
  return { args, renders: () => renders, homes: () => homes };
}
test("passive screenshot fallback succeeds without Home recovery", async () => {
  const ctx = worker("observe");
  const result = await runResearchStep(ctx.args);
  assert.equal(result.outcome, "VERIFIED");
  assert.ok(ctx.renders() > 0); assert.equal(ctx.homes(), 0);
});
test("ungrounded screenshot navigation hands off without Home recovery", async () => {
  const ctx = worker("open_feed");
  assert.equal((await runResearchStep(ctx.args)).outcome, "NEEDS_HUMAN");
  assert.equal(ctx.homes(), 0);
});
test("capture_screenshot saves a real artifact even when a tree is available", async () => {
  const ctx = worker("capture_screenshot", { screen: "feed", label: "Instagram Home" });
  const result = await runResearchStep(ctx.args);
  assert.equal(result.outcome, "VERIFIED");
  assert.equal(ctx.renders(), 1);
  const evidence = result.execution.evidence;
  const saved = resolveResearchEvidence("workspace", "account", evidence.id);
  assert.ok(saved);
  assert.deepEqual(fs.readFileSync(saved.file), Buffer.from(frame.data, "base64"));
  assert.equal(ctx.args.task.checkpoints[0].data.observationRef, evidence.ref);
});
test("late model decisions cannot execute beyond their duration deadline", async () => {
  const ctx = worker("observe");
  ctx.args.task.maxDurationSec = 1;
  const provider = ctx.args.provider.observeAndPlan;
  ctx.args.provider.observeAndPlan = async () => { ctx.args.task.dispatchedAt = new Date(Date.now() - 2000).toISOString(); return provider(); };
  assert.equal((await runResearchStep(ctx.args)).outcome, "EXPIRED");
  assert.equal(ctx.args.task.checkpoints.length, 0);
});
test("WDA refreshes dimensions for taps and positioned swipes after rotation", async () => {
  let size = { width: 390, height: 844 }, reads = 0;
  const inputs = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/session") return res.end(JSON.stringify({ sessionId: "fixture" }));
    if (req.url.endsWith("/window/size")) { reads++; return res.end(JSON.stringify({ value: size })); }
    inputs.push(JSON.parse(raw)); res.end('{"value":null}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const device = new WdaDevice("d", "fixture", { port: server.address().port });
    await device.tap(0.5, 0.5);
    size = { width: 844, height: 390 };
    await device.tap(0.5, 0.5);
    await device.swipe("up", { x: 0.5, y: 0.5 });
    assert.equal(reads, 3);
    assert.deepEqual(inputs[1], { x: 422, y: 195 });
    assert.equal(inputs[2].x, 422); assert.equal(inputs[2].y, 195);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
