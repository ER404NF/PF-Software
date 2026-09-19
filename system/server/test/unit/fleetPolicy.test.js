import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFleetPolicy, SpendTracker, FLEET_DENIALS } from "../../src/fleetPolicy.js";
import { InterventionQueue, INTERVENTION_STATES, INTERVENTION_KINDS, classifyIntervention } from "../../src/interventionQueue.js";

const task = (id, accountId, deviceId, extra = {}) => ({ id, kind: "research", accountSelector: { accountId, platform: "instagram" }, deviceSelector: { deviceId }, ...extra });
const workspaces = { a1: "ws1", a2: "ws1", a3: "ws1", b1: "ws2", b2: "ws2", c1: "ws3" };
const workspaceOf = account => workspaces[account] ?? null;

function policyFor(running, config = {}, extra = {}) {
  return createFleetPolicy({ runningTasks: () => running, workspaceOf, config, ...extra });
}

// ---- individual rules -------------------------------------------------------------------

test("an account is never operated by two workers at once", () => {
  const policy = policyFor([task("t1", "a1", "dev-1")]);
  const denied = policy.decide(task("t2", "a1", "dev-2"), "dev-2");
  assert.equal(denied.allow, false);
  assert.equal(denied.code, FLEET_DENIALS.ACCOUNT_BUSY);
  assert.equal(policy.decide(task("t3", "a2", "dev-2"), "dev-2").allow, true, "a different account is fine");
  assert.equal(policy.decide(task("t1", "a1", "dev-1"), "dev-1").allow, true, "a task never blocks itself");
});

test("device affinity pins an account to the phone it is signed in on", () => {
  const policy = policyFor([], { affinity: { a1: "dev-1" } });
  assert.equal(policy.decide(task("t1", "a1", "dev-1"), "dev-1").allow, true);
  const denied = policy.decide(task("t2", "a1", "dev-2"), "dev-2");
  assert.equal(denied.code, FLEET_DENIALS.AFFINITY);
  assert.match(denied.reason, /signed in on dev-1/);
  assert.equal(policy.decide(task("t3", "a2", "dev-2"), "dev-2").allow, true, "unpinned accounts may use any phone");
});

test("workspace concurrency limits how many of one client's accounts run at once", () => {
  const running = [task("t1", "a1", "d1"), task("t2", "a2", "d2")];
  const policy = policyFor(running, { perWorkspace: { default: 5, ws1: 2 } });
  assert.equal(policy.decide(task("t3", "a3", "d3"), "d3").code, FLEET_DENIALS.WORKSPACE_LIMIT);
  assert.equal(policy.decide(task("t4", "b1", "d4"), "d4").allow, true, "another client is unaffected");
});

test("provider concurrency, fleet cap and the hourly spend budget each stop new work", () => {
  const providerOf = item => item.provider ?? null;
  const running = [task("t1", "a1", "d1", { provider: "vendor-x" }), task("t2", "b1", "d2", { provider: "vendor-y" })];
  const byProvider = policyFor(running, { perProvider: { default: Infinity, "vendor-x": 1 } }, { providerOf });
  assert.equal(byProvider.decide(task("t3", "a2", "d3", { provider: "vendor-x" }), "d3").code, FLEET_DENIALS.PROVIDER_LIMIT);
  assert.equal(byProvider.decide(task("t4", "a2", "d3", { provider: "vendor-y" }), "d3").allow, true);

  const capped = policyFor(running, { maxWorkers: 2 });
  assert.equal(capped.decide(task("t5", "c1", "d5"), "d5").code, FLEET_DENIALS.FLEET_LIMIT);

  const spending = policyFor([], { maxCostUsdPerHour: 1 }, { spentLastHourUsd: () => 1.2 });
  assert.equal(spending.decide(task("t6", "c1", "d5"), "d5").code, FLEET_DENIALS.BUDGET);
});

test("human control and other task kinds are never held back by the AI fleet policy", () => {
  const policy = policyFor([task("t1", "a1", "d1")], { maxWorkers: 1 });
  assert.equal(policy.decide({ id: "x", kind: "command", deviceSelector: { deviceId: "d2" } }, "d2").allow, true);
  assert.equal(policy.canDispatch({ id: "y", kind: "human" }, "d3"), true);
});

test("the spend tracker is a rolling hour", () => {
  let now = 0;
  const tracker = new SpendTracker({ now: () => now });
  tracker.add(0.5);
  now = 30 * 60_000;
  tracker.add(0.25);
  assert.equal(tracker.totalUsd(), 0.75);
  now = 61 * 60_000;
  assert.equal(tracker.totalUsd(), 0.25, "the first entry aged out");
});

test("monitoring shows every worker, per-workspace load and the limits in force", () => {
  const running = [task("t1", "a1", "d1", { checkpoints: [1, 2], startedAt: 5 }), task("t2", "b1", "d2")];
  const snapshot = policyFor(running, { maxWorkers: 8, maxCostUsdPerHour: 4 }, { spentLastHourUsd: () => 1.234567 }).snapshot();
  assert.equal(snapshot.activeWorkers, 2);
  assert.deepEqual(snapshot.byWorkspace, { ws1: 1, ws2: 1 });
  assert.deepEqual(snapshot.limits, { maxWorkers: 8, maxCostUsdPerHour: 4 });
  assert.equal(snapshot.spentLastHourUsd, 1.2346);
  assert.deepEqual(snapshot.workers[0], { taskId: "t1", deviceId: "d1", accountId: "a1", workspaceId: "ws1", platform: "instagram", provider: null, checkpoints: 2, startedAt: 5 });
});

// ---- load: N workers on N devices (the MS12 integration gate) ----------------------------

function seeded(seed) {
  let state = seed;
  return () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
}

for (const seed of [1, 7, 42, 2026]) {
  test(`under load (seed ${seed}): no account ever has two workers, limits hold at every step, and every task finishes`, () => {
    const random = seeded(seed);
    const accountIds = Object.keys(workspaces);
    const devices = Array.from({ length: 10 }, (_, index) => `dev-${index + 1}`);
    const affinity = { a1: "dev-1", b1: "dev-2", c1: "dev-3" };
    const limits = { maxWorkers: 6, perWorkspace: { default: 3, ws1: 2 }, affinity };
    const queue = Array.from({ length: 80 }, (_, index) => {
      const account = accountIds[Math.floor(random() * accountIds.length)];
      return task(`task-${index}`, account, affinity[account] ?? devices[Math.floor(random() * devices.length)]);
    });
    const running = [];
    const policy = policyFor(running, limits);
    const finished = new Set();

    for (let tick = 0; tick < 2000 && finished.size < queue.length; tick += 1) {
      for (const candidate of queue) {
        if (finished.has(candidate.id) || running.includes(candidate)) continue;
        const device = candidate.deviceSelector.deviceId;
        if (running.some(other => other.deviceSelector.deviceId === device)) continue; // one input owner per device
        if (policy.canDispatch(candidate, device)) running.push(candidate);
      }
      // ---- invariants, checked after every scheduling round ----
      const accounts = running.map(item => item.accountSelector.accountId);
      assert.equal(new Set(accounts).size, accounts.length, `tick ${tick}: an account has two workers`);
      assert.ok(running.length <= limits.maxWorkers, `tick ${tick}: ${running.length} workers > ${limits.maxWorkers}`);
      for (const [ws, limit] of [["ws1", 2], ["ws2", 3], ["ws3", 3]]) {
        assert.ok(running.filter(item => workspaces[item.accountSelector.accountId] === ws).length <= limit, `tick ${tick}: ${ws} over its limit`);
      }
      assert.equal(new Set(running.map(item => item.deviceSelector.deviceId)).size, running.length, `tick ${tick}: a device has two owners`);
      for (const item of running) {
        const pinned = affinity[item.accountSelector.accountId];
        if (pinned) assert.equal(item.deviceSelector.deviceId, pinned, "affinity respected");
      }
      // some workers finish, or a human takes the phone over, each round
      for (const item of [...running]) {
        if (random() < 0.35) { running.splice(running.indexOf(item), 1); finished.add(item.id); }
      }
    }
    assert.equal(finished.size, queue.length, "no task was starved");
  });
}

// ---- interventions -----------------------------------------------------------------------

test("hand-off reasons are classified for the queue and for analytics", () => {
  assert.equal(classifyIntervention("security or account challenge: captcha"), INTERVENTION_KINDS.CHALLENGE);
  assert.equal(classifyIntervention("model confidence 0.2 is below 0.6"), INTERVENTION_KINDS.LOW_CONFIDENCE);
  assert.equal(classifyIntervention("platform_save is waiting for approval (apr-1)"), INTERVENTION_KINDS.APPROVAL);
  assert.equal(classifyIntervention("comment not sent: this account already commented"), INTERVENTION_KINDS.COMMENT_REJECTED);
  assert.equal(classifyIntervention("like could not be confirmed; check the account"), INTERVENTION_KINDS.UNCONFIRMED_ACTION);
  assert.equal(classifyIntervention("AI input lease was revoked during execution"), INTERVENTION_KINDS.LEASE_REVOKED);
  assert.equal(classifyIntervention("something else"), INTERVENTION_KINDS.OTHER);
});

test("intervention queue: one open item per task and kind, claimed then resolved, oldest first", () => {
  let now = 100;
  const queue = new InterventionQueue({ now: () => now });
  const first = queue.open({ taskId: "t1", accountId: "a1", workspaceId: "ws1", reason: "security or account challenge: captcha" });
  assert.equal(queue.open({ taskId: "t1", reason: "security or account challenge: captcha again" }).id, first.id, "not duplicated");
  now = 200;
  queue.open({ taskId: "t2", workspaceId: "ws2", reason: "model confidence 0.1 is below 0.6" });
  assert.deepEqual(queue.list({ states: [INTERVENTION_STATES.OPEN] }).map(item => item.taskId), ["t1", "t2"]);
  assert.equal(queue.claim(first.id, "va1").claimedBy, "va1");
  assert.throws(() => queue.claim(first.id, "va2"), /Already claimed by va1/);
  assert.equal(queue.resolve(first.id, { by: "va1", resolution: "solved the captcha" }).state, INTERVENTION_STATES.RESOLVED);
  assert.throws(() => queue.claim(first.id, "va1"), /already resolved/);
  assert.deepEqual(queue.counts(), { OPEN: 1, CLAIMED: 0, RESOLVED: 1 });
  assert.equal(queue.list({ workspaceId: "ws2" }).length, 1);
});

test("open items close by themselves when the task moves on, and everything survives a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-int-")), "interventions.json");
  const queue = new InterventionQueue({ filePath: file });
  queue.open({ taskId: "t1", reason: "model confidence 0.1 is below 0.6" });
  queue.open({ taskId: "t1", kind: INTERVENTION_KINDS.APPROVAL, reason: "waiting for approval" });
  assert.equal(queue.resolveForTask("t1", { resolution: "task resumed" }), 2);
  const reloaded = new InterventionQueue({ filePath: file });
  assert.deepEqual(reloaded.counts(), { OPEN: 0, CLAIMED: 0, RESOLVED: 2 });
  assert.equal(reloaded.list()[0].resolution, "task resumed");
});

test("the resolved history is bounded", () => {
  const queue = new InterventionQueue({ maxResolved: 3 });
  for (let index = 0; index < 6; index += 1) queue.resolve(queue.open({ taskId: `t${index}`, reason: "x" }).id);
  assert.equal(queue.counts().RESOLVED, 3);
});
