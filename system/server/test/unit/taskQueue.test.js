import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createTaskQueue } from "../../src/taskQueue.js";
import { TASK_STATES } from "../../src/taskSpec.js";
import { MODES, nextMode } from "../../src/controllerMode.js";

// Reuses the real (already-tested) transition table against an isolated
// registry, rather than the real deviceLease.js singleton — this is what
// makes every test here independent, with no reset() bookkeeping needed.
function createMockDeviceLease() {
  const state = new Map();
  function entry(id) {
    if (!state.has(id)) state.set(id, { mode: MODES.HUMAN, pendingAiAction: null });
    return state.get(id);
  }
  function getMode(id) {
    return entry(id).mode;
  }
  function applyEvent(id, event) {
    const e = entry(id);
    const next = nextMode(e.mode, event);
    if (!next) throw new Error(`illegal transition: ${e.mode} + ${event}`);
    e.mode = next;
    return next;
  }
  function switchToAI(id) {
    applyEvent(id, "SWITCH_TO_AI");
    applyEvent(id, "HANDOFF_TO_AI_COMPLETE");
    return getMode(id);
  }
  async function switchToHuman(id) {
    const e = entry(id);
    if (e.mode === MODES.HUMAN) return MODES.HUMAN;
    applyEvent(id, "SWITCH_TO_HUMAN");
    if (e.pendingAiAction) await e.pendingAiAction.catch(() => {});
    e.pendingAiAction = null;
    applyEvent(id, "HANDOFF_TO_HUMAN_COMPLETE");
    return MODES.HUMAN;
  }
  function registerPendingAiAction(id, promise) {
    entry(id).pendingAiAction = promise;
  }
  // Synchronous and unconditional, like the real deviceLease.js's version —
  // EMERGENCY_STOP is a valid transition from every mode (controllerMode.js),
  // so this never throws regardless of current state.
  function emergencyStop(id) {
    applyEvent(id, "EMERGENCY_STOP");
    entry(id).pendingAiAction = null;
    return MODES.HUMAN;
  }
  return { getMode, applyEvent, switchToAI, switchToHuman, registerPendingAiAction, emergencyStop };
}

function makeDevices(ids) {
  const map = new Map();
  for (const id of ids) map.set(id, { id, status: "idle" });
  return map;
}

function setup(deviceIds = ["dev-1", "dev-2"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-taskqueue-"));
  const devices = makeDevices(deviceIds);
  const deviceLease = createMockDeviceLease();
  const queue = createTaskQueue({ devices, deviceLease, auditLog: null, storePath: path.join(dir, "tasks.json") });
  return { dir, devices, deviceLease, queue };
}

function failNextQueueWrite(action) {
  const rename = mock.method(fs, "renameSync", () => {
    throw new Error("injected queue write failure");
  });
  try {
    assert.throws(action, /injected queue write failure/);
  } finally {
    rename.mock.restore();
  }
}

test("addTask with no window dispatches immediately to a free device", () => {
  const { deviceLease, queue } = setup();
  // addTask() dispatches synchronously before returning, so the returned
  // object already reflects the post-dispatch state — not a separate
  // "still QUEUED" snapshot.
  const task = queue.addTask({ goal: "do a thing" });
  assert.equal(task.state, TASK_STATES.RUNNING);
  assert.ok(["dev-1", "dev-2"].includes(task.deviceSelector.deviceId));
  assert.equal(deviceLease.getMode(task.deviceSelector.deviceId), "AI_RUNNING");
});

test("a task admission persistence failure leaves no hidden live task", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-task-admission-fail-"));
  const storePath = path.join(dir, "tasks.json");
  try {
    const queue = createTaskQueue({
      devices: makeDevices(["dev-1"]),
      deviceLease: createMockDeviceLease(),
      auditLog: null,
      storePath,
    });
    fs.mkdirSync(storePath);
    assert.throws(() => queue.addTask({ goal: "must not leak into memory" }));
    assert.deepEqual(queue.listTasks(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a dispatch persistence failure restores the queued task and device lease", () => {
  const { dir, queue, deviceLease } = setup(["dev-1"]);
  const originalRename = fs.renameSync.bind(fs);
  let renames = 0;
  const rename = mock.method(fs, "renameSync", (from, to) => {
    renames += 1;
    if (renames === 2) throw new Error("injected dispatch write failure");
    return originalRename(from, to);
  });
  let task;
  try {
    task = queue.addTask({ goal: "remain safely queued", deviceSelector: { deviceId: "dev-1" } });
  } finally { rename.mock.restore(); }

  assert.equal(task.state, TASK_STATES.QUEUED);
  assert.equal(task.dispatchedAt, undefined);
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"));
  assert.equal(stored.tasks[0].state, TASK_STATES.QUEUED);

  queue.tick(new Date());
  assert.equal(task.state, TASK_STATES.RUNNING);
  assert.equal(deviceLease.getMode("dev-1"), "AI_RUNNING");
});

test("ordinary queue mutations publish no live state when persistence fails", () => {
  const { dir, queue } = setup([]);
  try {
    const first = queue.addTask({ goal: "first" });
    const second = queue.addTask({ goal: "second" });

    failNextQueueWrite(() => queue.moveTask(second.id, "before", first.id));
    assert.deepEqual(queue.listTasks().map(task => task.id), [first.id, second.id]);

    failNextQueueWrite(() => queue.setPriority(first.id, "urgent"));
    assert.equal(queue.getTask(first.id).priority, "normal");

    failNextQueueWrite(() => queue.cancelTask(first.id));
    assert.equal(queue.getTask(first.id).state, TASK_STATES.QUEUED);

    failNextQueueWrite(() => queue.checkpoint(first.id, { step: 1 }));
    assert.deepEqual(queue.getTask(first.id).checkpoints, []);

    failNextQueueWrite(() => queue.pauseQueue());
    assert.equal(queue.isPaused(), false);
    queue.pauseQueue();
    failNextQueueWrite(() => queue.resumeQueue());
    assert.equal(queue.isPaused(), true);

    const stored = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"));
    assert.equal(stored.paused, true);
    assert.deepEqual(stored.tasks.map(task => task.id), [first.id, second.id]);
    assert.equal(stored.tasks[0].priority, "normal");
    assert.equal(stored.tasks[0].state, TASK_STATES.QUEUED);
    assert.deepEqual(stored.tasks[0].checkpoints, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("pause and resume keep task and lease aligned when persistence fails", () => {
  const { dir, queue, deviceLease } = setup(["dev-1"]);
  try {
    const task = queue.addTask({ goal: "running", deviceSelector: { deviceId: "dev-1" } });
    failNextQueueWrite(() => queue.pauseTask(task.id));
    assert.equal(queue.getTask(task.id).state, TASK_STATES.RUNNING);
    assert.equal(deviceLease.getMode("dev-1"), MODES.AI_RUNNING);

    queue.pauseTask(task.id);
    failNextQueueWrite(() => queue.resumeTask(task.id));
    assert.equal(queue.getTask(task.id).state, TASK_STATES.PAUSED);
    assert.equal(deviceLease.getMode("dev-1"), MODES.AI_PAUSED);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"));
    assert.equal(stored.tasks[0].state, TASK_STATES.PAUSED);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("clock-driven transitions publish no live state when persistence fails", () => {
  const { dir, queue } = setup([]);
  try {
    const task = queue.addTask({ goal: "scheduled", earliestStart: "2026-09-15T10:00:00.000Z",
      latestEnd: "2026-09-15T11:00:00.000Z" }, new Date("2026-09-15T09:00:00.000Z"));
    assert.equal(task.state, TASK_STATES.SCHEDULED);
    failNextQueueWrite(() => queue.tick(new Date("2026-09-15T10:00:00.000Z")));
    assert.equal(task.state, TASK_STATES.SCHEDULED);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"));
    assert.equal(stored.tasks[0].state, TASK_STATES.SCHEDULED);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("renamePrincipal durably migrates task creators and is write-first", () => {
  const { dir, queue } = setup([]);
  try {
    const first = queue.addTask({ goal: "first", createdBy: "old-name" });
    const other = queue.addTask({ goal: "other", createdBy: "someone-else" });
    failNextQueueWrite(() => queue.renamePrincipal("old-name", "new-name"));
    assert.equal(first.createdBy, "old-name");
    assert.deepEqual(queue.renamePrincipal("old-name", "new-name"), [first.id]);
    assert.equal(first.createdBy, "new-name");
    assert.equal(other.createdBy, "someone-else");
    const restarted = createTaskQueue({ devices: makeDevices([]), deviceLease: createMockDeviceLease(),
      auditLog: null, storePath: path.join(dir, "tasks.json") });
    assert.equal(restarted.getTask(first.id).createdBy, "new-name");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a task targeting a specific device only dispatches to that device", () => {
  const { queue } = setup();
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-2" } });
  const reloaded = queue.getTask(task.id);
  assert.equal(reloaded.state, TASK_STATES.RUNNING);
  assert.equal(reloaded.deviceSelector.deviceId, "dev-2");
});

test("a task targeting a busy device stays QUEUED until that device frees up", async () => {
  const { queue } = setup(["dev-1"]);
  const first = queue.addTask({ goal: "first", deviceSelector: { deviceId: "dev-1" } });
  const second = queue.addTask({ goal: "second", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(queue.getTask(first.id).state, TASK_STATES.RUNNING);
  assert.equal(queue.getTask(second.id).state, TASK_STATES.QUEUED);

  await queue.reportResult(first.id, TASK_STATES.SUCCEEDED);
  assert.equal(queue.getTask(second.id).state, TASK_STATES.RUNNING);
});

test("equal-priority tasks dispatch in FIFO (array) order", () => {
  const { queue } = setup(["dev-1"]);
  const a = queue.addTask({ goal: "a", deviceSelector: { deviceId: "dev-1" } });
  queue.addTask({ goal: "b", deviceSelector: { deviceId: "dev-1" } });
  // dev-1 only fits one at a time — "a" got there first and should be the one running.
  assert.equal(queue.getTask(a.id).state, TASK_STATES.RUNNING);
});

test("a higher-priority task added later still dispatches to a device that frees up next", async () => {
  const { queue } = setup(["dev-1"]);
  const low = queue.addTask({ goal: "low", priority: "low", deviceSelector: { deviceId: "dev-1" } });
  const urgent = queue.addTask({ goal: "urgent", priority: "urgent", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(queue.getTask(low.id).state, TASK_STATES.RUNNING);
  assert.equal(queue.getTask(urgent.id).state, TASK_STATES.QUEUED);

  await queue.reportResult(low.id, TASK_STATES.SUCCEEDED);
  assert.equal(queue.getTask(urgent.id).state, TASK_STATES.RUNNING);
});

test("moveTask changes dispatch order among equal-priority tasks", () => {
  const { queue } = setup(["dev-1"]);
  const a = queue.addTask({ goal: "a", deviceSelector: { deviceId: "dev-1" } });
  const b = queue.addTask({ goal: "b", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(queue.getTask(a.id).state, TASK_STATES.RUNNING); // a got dev-1 first

  // Cancel a (freeing dev-1) after moving b ahead of a — b should win the re-dispatch.
  queue.moveTask(b.id, "before", a.id);
  return queue.reportResult(a.id, TASK_STATES.SUCCEEDED).then(() => {
    assert.equal(queue.getTask(b.id).state, TASK_STATES.RUNNING);
  });
});

test("a task with an unopened window stays SCHEDULED until tick() opens it", () => {
  const { queue } = setup();
  const now = new Date("2026-06-15T09:00:00Z");
  const task = queue.addTask({
    goal: "later",
    earliestStart: "2026-06-15T10:00:00Z",
    latestEnd: "2026-06-15T11:00:00Z",
  }, now);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SCHEDULED);

  queue.tick(new Date("2026-06-15T09:59:00Z"));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.SCHEDULED);

  queue.tick(new Date("2026-06-15T10:00:00Z"));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.RUNNING);
});

test("a SCHEDULED task whose window closes before it ever ran becomes EXPIRED", () => {
  const { queue } = setup([]); // no devices at all -> can never dispatch
  const task = queue.addTask({
    goal: "never runs",
    earliestStart: "2026-06-15T10:00:00Z",
    latestEnd: "2026-06-15T11:00:00Z",
  }, new Date("2026-06-15T09:00:00Z"));

  queue.tick(new Date("2026-06-15T10:30:00Z"));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.QUEUED);

  queue.tick(new Date("2026-06-15T11:00:00Z"));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.EXPIRED);
});

test("a RUNNING task whose window closes with no checkpoints becomes EXPIRED, and frees its device", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const task = queue.addTask({
    goal: "x",
    deviceSelector: { deviceId: "dev-1" },
    earliestStart: "2026-06-15T09:00:00Z",
    latestEnd: "2026-06-15T10:00:00Z",
  }, new Date("2026-06-15T09:00:00Z"));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.RUNNING);

  queue.tick(new Date("2026-06-15T10:00:00Z"));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.EXPIRED);
  assert.equal(deviceLease.getMode("dev-1"), "AI_IDLE");
});

test("a RUNNING task with at least one checkpoint becomes PARTIAL, not EXPIRED, at window close", () => {
  const { queue } = setup(["dev-1"]);
  const task = queue.addTask({
    goal: "x",
    deviceSelector: { deviceId: "dev-1" },
    earliestStart: "2026-06-15T09:00:00Z",
    latestEnd: "2026-06-15T10:00:00Z",
  }, new Date("2026-06-15T09:00:00Z"));
  queue.checkpoint(task.id, { note: "found something" });

  queue.tick(new Date("2026-06-15T10:00:00Z"));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.PARTIAL);
});

test("a PAUSED task still closes at its time-window boundary and releases the lease", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" },
    earliestStart: "2026-06-15T09:00:00Z", latestEnd: "2026-06-15T10:00:00Z" },
  new Date("2026-06-15T09:00:00Z"));
  assert.equal(queue.pauseTask(task.id).state, TASK_STATES.PAUSED);
  queue.tick(new Date("2026-06-15T10:00:00Z"));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.EXPIRED);
  assert.equal(deviceLease.getMode("dev-1"), "AI_IDLE");
});

test("allowOverrun keeps a task RUNNING past its window instead of closing it", () => {
  const { queue } = setup(["dev-1"]);
  const task = queue.addTask({
    goal: "x",
    deviceSelector: { deviceId: "dev-1" },
    earliestStart: "2026-06-15T09:00:00Z",
    latestEnd: "2026-06-15T10:00:00Z",
    allowOverrun: true,
  }, new Date("2026-06-15T09:00:00Z"));

  queue.tick(new Date("2026-06-15T10:30:00Z"));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.RUNNING);
});

test("FAILED_RETRYABLE re-queues the task until retries are exhausted, then FAILED_FINAL", async () => {
  const { queue } = setup(["dev-1"]);
  const task = queue.addTask({
    goal: "x",
    deviceSelector: { deviceId: "dev-1" },
    retryPolicy: { maxRetries: 1 },
  });

  await queue.reportResult(task.id, TASK_STATES.FAILED_RETRYABLE);
  let reloaded = queue.getTask(task.id);
  assert.equal(reloaded.state, TASK_STATES.RUNNING); // re-dispatched automatically (dev-1 is free again)
  assert.equal(reloaded.retryCount, 1);

  await queue.reportResult(task.id, TASK_STATES.FAILED_RETRYABLE);
  reloaded = queue.getTask(task.id);
  assert.equal(reloaded.state, TASK_STATES.FAILED_FINAL);
  assert.equal(reloaded.retryCount, 2);
});

test("retry backoff is durable and blocks redispatch until retryNotBefore", async () => {
  const { dir, queue, deviceLease } = setup(["dev-1"]);
  const task = queue.addTask({
    goal: "x",
    deviceSelector: { deviceId: "dev-1" },
    retryPolicy: { maxRetries: 1, backoffMs: 1_000 },
  });

  await queue.reportResult(task.id, TASK_STATES.FAILED_RETRYABLE);
  const waiting = queue.getTask(task.id);
  const retryAt = new Date(waiting.retryNotBefore);
  assert.equal(waiting.state, TASK_STATES.QUEUED);
  assert.equal(waiting.retryCount, 1);
  assert.equal(deviceLease.getMode("dev-1"), "AI_IDLE");
  assert.ok(Number.isFinite(retryAt.getTime()));

  const stored = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"));
  assert.equal(stored.tasks[0].retryNotBefore, waiting.retryNotBefore);

  queue.tick(new Date(retryAt.getTime() - 1));
  assert.equal(queue.getTask(task.id).state, TASK_STATES.QUEUED);

  queue.tick(retryAt);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.RUNNING);
  assert.equal(queue.getTask(task.id).retryNotBefore, null);
});

test("NEEDS_HUMAN hands the device back via a real handoff, not just a status flag", async () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(deviceLease.getMode("dev-1"), "AI_RUNNING");

  await queue.reportResult(task.id, TASK_STATES.NEEDS_HUMAN, { detail: "MFA challenge" });
  assert.equal(queue.getTask(task.id).state, TASK_STATES.NEEDS_HUMAN);
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");
});

test("dependencies: a task is not eligible until its dependency has SUCCEEDED", async () => {
  const { queue } = setup(["dev-1"]);
  const base = queue.addTask({ goal: "base", deviceSelector: { deviceId: "dev-1" } });
  const dependent = queue.addTask({ goal: "dependent", dependencies: [base.id] });
  assert.equal(queue.getTask(dependent.id).state, TASK_STATES.QUEUED); // blocked, not running

  await queue.reportResult(base.id, TASK_STATES.SUCCEEDED);
  assert.equal(queue.getTask(dependent.id).state, TASK_STATES.RUNNING);
});

test("a dependency that only reached PARTIAL does not satisfy a dependent task", async () => {
  const { queue } = setup(["dev-1"]);
  const base = queue.addTask({ goal: "base", deviceSelector: { deviceId: "dev-1" } });
  const dependent = queue.addTask({ goal: "dependent", dependencies: [base.id] });

  await queue.reportResult(base.id, TASK_STATES.PARTIAL);
  assert.equal(queue.getTask(dependent.id).state, TASK_STATES.QUEUED);
});

test("cancelTask on a RUNNING task frees its device; on a terminal task it's a no-op", async () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const running = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  queue.cancelTask(running.id);
  assert.equal(queue.getTask(running.id).state, TASK_STATES.CANCELLED);
  assert.equal(deviceLease.getMode("dev-1"), "AI_IDLE");

  const other = queue.addTask({ goal: "y", deviceSelector: { deviceId: "dev-1" } });
  await queue.reportResult(other.id, TASK_STATES.SUCCEEDED);
  const beforeCancel = queue.getTask(other.id).state;
  queue.cancelTask(other.id);
  assert.equal(queue.getTask(other.id).state, beforeCancel); // unchanged — already terminal
});

test("pauseQueue stops new dispatches; resumeQueue lets them resume", () => {
  const { queue } = setup(["dev-1"]);
  queue.pauseQueue();
  const task = queue.addTask({ goal: "x" });
  assert.equal(queue.getTask(task.id).state, TASK_STATES.QUEUED);

  queue.tick(new Date());
  assert.equal(queue.getTask(task.id).state, TASK_STATES.QUEUED);

  queue.resumeQueue();
  queue.tick(new Date());
  assert.equal(queue.getTask(task.id).state, TASK_STATES.RUNNING);
});

test("queue pause state survives restart and resume is persisted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-paused-queue-"));
  const storePath = path.join(dir, "tasks.json");
  try {
    const devices = makeDevices(["dev-1"]);
    const first = createTaskQueue({ devices, deviceLease: createMockDeviceLease(), auditLog: null, storePath });
    first.pauseQueue();
    first.addTask({ goal: "wait while paused" });

    const restarted = createTaskQueue({
      devices,
      deviceLease: createMockDeviceLease(),
      auditLog: null,
      storePath,
    });
    assert.equal(restarted.isPaused(), true);
    assert.equal(restarted.listTasks()[0].state, TASK_STATES.QUEUED);

    restarted.resumeQueue();
    const reloaded = createTaskQueue({
      devices,
      deviceLease: createMockDeviceLease(),
      auditLog: null,
      storePath,
      dispatchOnCreate: false,
    });
    assert.equal(reloaded.isPaused(), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reportResult throws for an unknown task id or a task that isn't RUNNING", async () => {
  const { queue } = setup();
  await assert.rejects(() => queue.reportResult("task_nope", TASK_STATES.SUCCEEDED));
  const notRunning = queue.addTask({
    goal: "x",
    earliestStart: "2099-01-01T00:00:00Z",
    latestEnd: "2099-01-01T01:00:00Z",
  });
  await assert.rejects(() => queue.reportResult(notRunning.id, TASK_STATES.SUCCEEDED));
});

test("reportResult rejects unknown result states without corrupting a running task", async () => {
  const { queue } = setup();
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  await assert.rejects(() => queue.reportResult(task.id, "MADE_UP_STATE"), /invalid task result outcome/);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.RUNNING);
});

test("task state survives reloading the queue from the same store path (restart, no crash)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-taskqueue-"));
  const storePath = path.join(dir, "tasks.json");
  const devices = makeDevices(["dev-1"]);
  const lease1 = createMockDeviceLease();
  const q1 = createTaskQueue({ devices, deviceLease: lease1, auditLog: null, storePath });
  const task = q1.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  // A clean restart doesn't crash mid-task — this one is expected to
  // recover as interrupted (see the next test) rather than stay RUNNING,
  // since the new process has no way to know if the old one finished it.
  assert.equal(q1.getTask(task.id).state, TASK_STATES.RUNNING);
});

test("restart recovery: a RUNNING task found on disk is retried or failed per its retry policy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-taskqueue-"));
  const storePath = path.join(dir, "tasks.json");
  fs.writeFileSync(
    storePath,
    JSON.stringify([
      {
        id: "task_interrupted_retryable",
        goal: "x",
        state: TASK_STATES.RUNNING,
        deviceSelector: { deviceId: "dev-1" },
        accountSelector: {},
        criteria: {},
        allowedActions: [],
        requiredActions: [],
        earliestStart: null,
        latestEnd: null,
        priority: "normal",
        dependencies: [],
        retryPolicy: { maxRetries: 1, backoffMs: 0 },
        retryCount: 0,
        allowOverrun: false,
        createdBy: null,
        createdAt: new Date().toISOString(),
        checkpoints: [],
        result: null,
        updatedAt: new Date().toISOString(),
      },
      {
        id: "task_interrupted_exhausted",
        goal: "y",
        state: TASK_STATES.RUNNING,
        deviceSelector: { deviceId: "dev-2" },
        accountSelector: {},
        criteria: {},
        allowedActions: [],
        requiredActions: [],
        earliestStart: null,
        latestEnd: null,
        priority: "normal",
        dependencies: [],
        retryPolicy: { maxRetries: 0, backoffMs: 0 },
        retryCount: 0,
        allowOverrun: false,
        createdBy: null,
        createdAt: new Date().toISOString(),
        checkpoints: [],
        result: null,
        updatedAt: new Date().toISOString(),
      },
    ])
  );

  const devices = makeDevices(["dev-1", "dev-2"]);
  const deviceLease = createMockDeviceLease();
  const queue = createTaskQueue({ devices, deviceLease, auditLog: null, storePath });

  // Retries available -> re-queued (and immediately re-dispatched, since
  // dev-1 is free in this fresh process — devices always start HUMAN/idle).
  const retried = queue.getTask("task_interrupted_retryable");
  assert.equal(retried.retryCount, 1);
  assert.equal(retried.state, TASK_STATES.RUNNING);

  // No retries left -> FAILED_FINAL, never re-dispatched.
  const exhausted = queue.getTask("task_interrupted_exhausted");
  assert.equal(exhausted.state, TASK_STATES.FAILED_FINAL);
  assert.equal(exhausted.retryCount, 1);
});

test("restart recovery preserves retry backoff before redispatch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-retry-recovery-"));
  const storePath = path.join(dir, "tasks.json");
  try {
    fs.writeFileSync(storePath, JSON.stringify([{
      id: "task_interrupted_with_backoff",
      goal: "x",
      state: TASK_STATES.RUNNING,
      deviceSelector: { deviceId: "dev-1" },
      accountSelector: {},
      criteria: {},
      allowedActions: [],
      requiredActions: [],
      earliestStart: null,
      latestEnd: null,
      priority: "normal",
      dependencies: [],
      retryPolicy: { maxRetries: 1, backoffMs: 60_000 },
      retryCount: 0,
      allowOverrun: false,
      createdBy: null,
      createdAt: new Date().toISOString(),
      checkpoints: [],
      result: null,
      updatedAt: new Date().toISOString(),
    }]));

    const queue = createTaskQueue({
      devices: makeDevices(["dev-1"]),
      deviceLease: createMockDeviceLease(),
      auditLog: null,
      storePath,
    });
    const recovered = queue.getTask("task_interrupted_with_backoff");
    const retryAt = new Date(recovered.retryNotBefore);
    assert.equal(recovered.state, TASK_STATES.QUEUED);
    assert.equal(recovered.retryCount, 1);
    assert.ok(retryAt.getTime() > Date.now());

    queue.tick(retryAt);
    assert.equal(queue.getTask(recovered.id).state, TASK_STATES.RUNNING);
    assert.equal(queue.getTask(recovered.id).retryNotBefore, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("startup dispatch can wait until workers subscribe, so recovered work is not missed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-deferred-start-"));
  const storePath = path.join(dir, "tasks.json");
  const devices = makeDevices(["dev-1"]);
  try {
    const first = createTaskQueue({ devices, deviceLease: createMockDeviceLease(), storePath });
    first.addTask({ goal: "recovered", retryPolicy: { maxRetries: 1 } });

    const queue = createTaskQueue({ devices, deviceLease: createMockDeviceLease(), storePath, dispatchOnCreate: false });
    assert.equal(queue.listTasks()[0].state, TASK_STATES.QUEUED);
    const delivered = [];
    queue.on("dispatched", (payload) => delivered.push(payload));
    queue.tick(new Date());
    assert.equal(queue.listTasks()[0].state, TASK_STATES.RUNNING);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].deviceId, "dev-1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("checkpoint records an entry and is reflected in the persisted task", () => {
  const { queue } = setup();
  const task = queue.addTask({ goal: "x" });
  const entry = queue.checkpoint(task.id, { foundCandidate: "https://example.com/p/1" });
  assert.ok(entry.at);
  assert.deepEqual(entry.data, { foundCandidate: "https://example.com/p/1" });
  assert.equal(queue.getTask(task.id).checkpoints.length, 1);
});

test("the 'dispatched' and 'completed' events fire with the task and device id", async () => {
  const { queue } = setup(["dev-1"]);
  const dispatchedEvents = [];
  const completedEvents = [];
  queue.on("dispatched", (e) => dispatchedEvents.push(e));
  queue.on("completed", (e) => completedEvents.push(e));

  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0].task.id, task.id);
  assert.equal(dispatchedEvents[0].deviceId, "dev-1");

  await queue.reportResult(task.id, TASK_STATES.SUCCEEDED);
  assert.equal(completedEvents.length, 1);
  assert.equal(completedEvents[0].task.state, TASK_STATES.SUCCEEDED);
});

test("pauseTask/resumeTask hold the device lease (AI_PAUSED), not release it", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(deviceLease.getMode("dev-1"), "AI_RUNNING");

  queue.pauseTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.PAUSED);
  assert.equal(deviceLease.getMode("dev-1"), "AI_PAUSED");

  queue.resumeTask(task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.RUNNING);
  assert.equal(deviceLease.getMode("dev-1"), "AI_RUNNING");
});

test("pauseTask/resumeTask are no-ops (return null) on a task in the wrong state", () => {
  const { queue } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(queue.resumeTask(task.id), null); // it's RUNNING, not PAUSED
  queue.pauseTask(task.id);
  assert.equal(queue.pauseTask(task.id), null); // already PAUSED
});

test("stopDevice cancels the active task (even if paused) and frees the device to AI_IDLE", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  queue.pauseTask(task.id);

  const stopped = queue.stopDevice("dev-1");
  assert.equal(stopped.id, task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.CANCELLED);
  assert.equal(deviceLease.getMode("dev-1"), "AI_IDLE");
});

test("stopDevice on a device with nothing active is a harmless no-op", () => {
  const { queue } = setup(["dev-1"]);
  assert.equal(queue.stopDevice("dev-1"), null);
});

test("stopDevice frees the device for the next eligible task", () => {
  const { queue } = setup(["dev-1"]);
  const first = queue.addTask({ goal: "first", deviceSelector: { deviceId: "dev-1" } });
  const second = queue.addTask({ goal: "second", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(queue.getTask(second.id).state, TASK_STATES.QUEUED);

  queue.stopDevice("dev-1");
  assert.equal(queue.getTask(first.id).state, TASK_STATES.CANCELLED);
  assert.equal(queue.getTask(second.id).state, TASK_STATES.RUNNING);
});

test("device controls still target the lease holder after a queued task is reordered ahead of it", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const running = queue.addTask({ goal: "running", deviceSelector: { deviceId: "dev-1" } });
  const queued = queue.addTask({ goal: "queued", deviceSelector: { deviceId: "dev-1" } });
  queue.moveTask(queued.id, "before", running.id);

  const paused = queue.pauseDevice("dev-1");
  assert.equal(paused.id, running.id);
  assert.equal(queue.getTask(running.id).state, TASK_STATES.PAUSED);
  assert.equal(queue.getTask(queued.id).state, TASK_STATES.QUEUED);
  assert.equal(deviceLease.getMode("dev-1"), "AI_PAUSED");

  queue.resumeDevice("dev-1");
  const stopped = queue.stopDevice("dev-1");
  assert.equal(stopped.id, running.id);
  assert.equal(queue.getTask(running.id).state, TASK_STATES.CANCELLED);
  assert.equal(queue.getTask(queued.id).state, TASK_STATES.RUNNING);
});

test("takeoverDevice cancels the active task and hands the device to a real human, not AI_IDLE", async () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });

  const taken = await queue.takeoverDevice("dev-1");
  assert.equal(taken.id, task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.CANCELLED);
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");
});

test("takeover holds the device in HUMAN until an explicit AI switch", async () => {
  const { dir, devices, queue, deviceLease } = setup(["dev-1"]);
  const first = queue.addTask({ goal: "first", deviceSelector: { deviceId: "dev-1" } });
  const second = queue.addTask({ goal: "second", deviceSelector: { deviceId: "dev-1" } });

  await queue.takeoverDevice("dev-1");
  assert.equal(queue.getTask(first.id).state, TASK_STATES.CANCELLED);
  assert.equal(queue.getTask(second.id).state, TASK_STATES.QUEUED);
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");

  queue.tick(new Date());
  assert.equal(queue.getTask(second.id).state, TASK_STATES.QUEUED);

  const restartedLease = createMockDeviceLease();
  const restarted = createTaskQueue({
    devices,
    deviceLease: restartedLease,
    auditLog: null,
    storePath: path.join(dir, "tasks.json"),
  });
  assert.equal(restarted.getTask(second.id).state, TASK_STATES.QUEUED);
  assert.equal(restartedLease.getMode("dev-1"), "HUMAN");

  restartedLease.switchToAI("dev-1");
  restarted.allowAiDispatch("dev-1");
  assert.equal(restarted.getTask(second.id).state, TASK_STATES.RUNNING);
});

test("takeoverDevice on an idle device is a harmless no-op that still ends up HUMAN", async () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const result = await queue.takeoverDevice("dev-1");
  assert.equal(result, null);
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");
});

test("emergencyStopDevice cancels the active task (even if paused) and hands the device straight to HUMAN", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  queue.pauseTask(task.id);

  const stopped = queue.emergencyStopDevice("dev-1");
  assert.equal(stopped.id, task.id);
  assert.equal(queue.getTask(task.id).state, TASK_STATES.CANCELLED);
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");
});

test("emergencyStopDevice is synchronous — it does not await a never-resolving pending action", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  deviceLease.registerPendingAiAction("dev-1", new Promise(() => {})); // never resolves

  const stopped = queue.emergencyStopDevice("dev-1");
  assert.equal(stopped.state, TASK_STATES.CANCELLED); // returned synchronously, no await needed
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");
});

test("emergencyStopDevice on a device with nothing active is a harmless no-op that still ends up HUMAN", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  assert.equal(queue.emergencyStopDevice("dev-1"), null);
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");
});

test("emergencyStopDevice holds queued work until an explicit AI switch", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const first = queue.addTask({ goal: "first", deviceSelector: { deviceId: "dev-1" } });
  const second = queue.addTask({ goal: "second", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(queue.getTask(second.id).state, TASK_STATES.QUEUED);

  queue.emergencyStopDevice("dev-1");
  assert.equal(queue.getTask(first.id).state, TASK_STATES.CANCELLED);
  assert.equal(queue.getTask(second.id).state, TASK_STATES.QUEUED);
  queue.tick(new Date());
  assert.equal(queue.getTask(second.id).state, TASK_STATES.QUEUED);

  deviceLease.switchToAI("dev-1");
  queue.allowAiDispatch("dev-1");
  assert.equal(queue.getTask(second.id).state, TASK_STATES.RUNNING);
});

test("pauseDevice/resumeDevice resolve the device's active task by id, for an operator typing a device id", () => {
  const { queue, deviceLease } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });

  const paused = queue.pauseDevice("dev-1");
  assert.equal(paused.id, task.id);
  assert.equal(deviceLease.getMode("dev-1"), "AI_PAUSED");

  const resumed = queue.resumeDevice("dev-1");
  assert.equal(resumed.id, task.id);
  assert.equal(deviceLease.getMode("dev-1"), "AI_RUNNING");
});

test("pauseDevice/resumeDevice on a device with nothing active or nothing paused are no-ops", () => {
  const { queue } = setup(["dev-1"]);
  assert.equal(queue.pauseDevice("dev-1"), null);
  queue.addTask({ goal: "x", deviceSelector: { deviceId: "dev-1" } });
  assert.equal(queue.resumeDevice("dev-1"), null); // it's RUNNING, not PAUSED
});

test("NEEDS_HUMAN durably holds the device in HUMAN until an explicit AI switch", async () => {
  const { dir, devices, queue, deviceLease } = setup(["dev-1"]);
  const first = queue.addTask({ goal: "first", deviceSelector: { deviceId: "dev-1" } });
  const second = queue.addTask({ goal: "second", deviceSelector: { deviceId: "dev-1" } });

  await queue.reportResult(first.id, TASK_STATES.NEEDS_HUMAN);
  assert.equal(queue.getTask(first.id).state, TASK_STATES.NEEDS_HUMAN);
  assert.equal(queue.getTask(second.id).state, TASK_STATES.QUEUED);
  assert.equal(deviceLease.getMode("dev-1"), "HUMAN");

  queue.tick(new Date());
  assert.equal(queue.getTask(second.id).state, TASK_STATES.QUEUED);

  const restartedLease = createMockDeviceLease();
  const restarted = createTaskQueue({
    devices,
    deviceLease: restartedLease,
    auditLog: null,
    storePath: path.join(dir, "tasks.json"),
  });
  assert.equal(restarted.getTask(second.id).state, TASK_STATES.QUEUED);
  assert.equal(restartedLease.getMode("dev-1"), "HUMAN");

  restartedLease.switchToAI("dev-1");
  restarted.allowAiDispatch("dev-1");
  assert.equal(restarted.getTask(second.id).state, TASK_STATES.RUNNING);
});

test("restart restores a paused lease and resume notifies the worker", () => {
  const { dir, queue } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "pause across restart" });
  queue.pauseTask(task.id);
  const lease = createMockDeviceLease();
  const recovered = createTaskQueue({ devices: makeDevices(["dev-1"]), deviceLease: lease,
    storePath: path.join(dir, "tasks.json") });
  assert.equal(lease.getMode("dev-1"), MODES.AI_PAUSED);
  assert.equal(recovered.getTask(task.id).state, TASK_STATES.PAUSED);
  let resumed;
  recovered.on("dispatched", payload => { resumed = payload.task.id; });
  recovered.resumeTask(task.id);
  assert.equal(lease.getMode("dev-1"), MODES.AI_RUNNING);
  assert.equal(resumed, task.id);
});

test("rejected resume preserves paused state in memory and on disk", () => {
  const { dir, queue, deviceLease: lease } = setup(["dev-1"]);
  const task = queue.addTask({ goal: "invalid resume" });
  queue.pauseTask(task.id);
  lease.emergencyStop("dev-1");
  const before = JSON.stringify(task);
  assert.throws(() => queue.resumeTask(task.id), /transition/);
  assert.equal(JSON.stringify(task), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"))).tasks[0].state, TASK_STATES.PAUSED);
});

test("startup rejects duplicate durable task IDs before restoring leases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-duplicate-task-"));
  const storePath = path.join(dir, "tasks.json");
  try {
    const first = createTaskQueue({ devices: makeDevices([]), deviceLease: createMockDeviceLease(), storePath, dispatchOnCreate: false });
    first.addTask({ goal: "one" });
    const snapshot = JSON.parse(fs.readFileSync(storePath, "utf8"));
    snapshot.tasks.push({ ...snapshot.tasks[0] });
    fs.writeFileSync(storePath, JSON.stringify(snapshot));
    assert.throws(() => createTaskQueue({ devices: makeDevices([]), deviceLease: createMockDeviceLease(), storePath }), /duplicate task id/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("versioned queue snapshots migrate known missing legacy fields before strict validation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-versioned-legacy-task-"));
  const storePath = path.join(dir, "tasks.json");
  try {
    const first = createTaskQueue({ devices: makeDevices([]), deviceLease: createMockDeviceLease(), storePath, dispatchOnCreate: false });
    const task = first.addTask({ goal: "legacy task" });
    const snapshot = JSON.parse(fs.readFileSync(storePath, "utf8"));
    delete snapshot.tasks[0].kind;
    delete snapshot.tasks[0].maxDurationSec;
    fs.writeFileSync(storePath, JSON.stringify(snapshot));

    const restarted = createTaskQueue({ devices: makeDevices([]), deviceLease: createMockDeviceLease(), storePath, dispatchOnCreate: false });
    assert.equal(restarted.getTask(task.id).kind, "generic");
    assert.equal(restarted.getTask(task.id).maxDurationSec, null);
    const migrated = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.equal(migrated.tasks[0].kind, "generic");
    assert.equal(migrated.tasks[0].maxDurationSec, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("client request IDs make task admission idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-idempotent-task-"));
  try {
    const queue = createTaskQueue({ devices: makeDevices([]), deviceLease: createMockDeviceLease(),
      storePath: path.join(dir, "tasks.json"), dispatchOnCreate: false });
    const first = queue.addTask({ goal: "one", createdBy: "admin", clientRequestId: "request-12345678" });
    const replay = queue.addTask({ goal: "one", createdBy: "admin", clientRequestId: "request-12345678" });
    assert.equal(replay.id, first.id);
    assert.equal(queue.listTasks().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
