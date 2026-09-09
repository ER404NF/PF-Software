// The durable task queue and scheduler (docs/COMMAND_QUEUE_SPEC.md §3,6-9,14).
// A factory, not a singleton module — like auditLog.js's createAuditLog, so
// tests get a fully isolated queue (own file, own injected devices/lease)
// instead of needing manual reset() calls between tests.
//
// This module owns scheduling/eligibility/dispatch/retry/checkpoint mechanics.
// "Running" a task means calling the `dispatched` listener with the task and
// device id; the MS8 research runner subscribes without putting model or
// platform logic into this generic queue.
// does the actual work and reports back via reportResult().

import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  TASK_STATES,
  isTerminal,
  createTaskSpec,
  isWindowOpen,
  hasWindowExpired,
  normalizeRetryPolicy,
} from "./taskSpec.js";

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };
const REPORTABLE_OUTCOMES = new Set([
  TASK_STATES.SUCCEEDED,
  TASK_STATES.PARTIAL,
  TASK_STATES.FAILED_RETRYABLE,
  TASK_STATES.FAILED_FINAL,
  TASK_STATES.CANCELLED,
  TASK_STATES.NEEDS_HUMAN,
]);

const replaceWaitArray = new Int32Array(new SharedArrayBuffer(4));
function writeTasks(storePath, tasks) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(tasks, null, 2), { flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, storePath);
        break;
      } catch (error) {
        if (!["EPERM", "EBUSY"].includes(error?.code) || attempt >= 10) throw error;
        Atomics.wait(replaceWaitArray, 0, 0, 5 * (attempt + 1));
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function loadTasks(storePath) {
  if (!fs.existsSync(storePath)) return [];
  const tasks = JSON.parse(fs.readFileSync(storePath, "utf8"));
  let changed = false;
  for (const task of tasks) {
    // Migrate snapshots written before retry timing became durable. Keeping
    // the normalized policy on every loaded task also prevents old files
    // with an omitted policy from crashing during recovery/reporting.
    const retryPolicy = normalizeRetryPolicy(task.retryPolicy ?? {});
    if (JSON.stringify(task.retryPolicy) !== JSON.stringify(retryPolicy)) changed = true;
    task.retryPolicy = retryPolicy;
    if (!("retryNotBefore" in task)) {
      task.retryNotBefore = null;
      changed = true;
    }
    // The process that was running this was killed or crashed — there is no
    // way to know whether the last action actually completed, so this is
    // never silently resumed or silently dropped. The 13 states in
    // COMMAND_QUEUE_SPEC.md §5 don't include a dedicated "interrupted"
    // state, so retry accounting (§10) decides the outcome directly here,
    // the same as any other failure would.
    if (task.state === TASK_STATES.RUNNING || task.state === TASK_STATES.DISPATCHED) {
      const recoveredAt = new Date();
      task.retryCount = (task.retryCount || 0) + 1;
      task.state = task.retryCount <= task.retryPolicy.maxRetries ? TASK_STATES.QUEUED : TASK_STATES.FAILED_FINAL;
      task.retryNotBefore = task.state === TASK_STATES.QUEUED && task.retryPolicy.backoffMs > 0
        ? new Date(recoveredAt.getTime() + task.retryPolicy.backoffMs).toISOString()
        : null;
      task.result = { outcome: "interrupted_by_restart", at: recoveredAt.toISOString() };
      task.updatedAt = task.result.at;
      changed = true;
    }
  }
  if (changed) writeTasks(storePath, tasks);
  return tasks;
}

function createTaskQueue({ devices, deviceLease, auditLog, storePath, dispatchOnCreate = true }) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tasks = loadTasks(storePath);
  let paused = false;
  const listeners = { dispatched: [], completed: [] };

  function persist() {
    // A crash during a direct truncate/write can destroy the only durable
    // queue snapshot. Write a complete sibling file and atomically replace
    // the destination so restart recovery sees the old or new state only.
    writeTasks(storePath, tasks);
  }

  // Restart recovery (COMMAND_QUEUE_SPEC.md §14): loadTasks() above already
  // requeued or failed any interrupted task per its retry policy — this is
  // what actually lets a requeued one resume immediately on a fresh device
  // set (every device starts HUMAN/idle on a new process) rather than
  // waiting for the first scheduled tick.
  if (dispatchOnCreate) tick(new Date());

  function on(event, cb) {
    listeners[event].push(cb);
  }

  function emit(event, payload) {
    for (const cb of listeners[event]) cb(payload);
  }

  function getTask(id) {
    return tasks.find((t) => t.id === id) ?? null;
  }

  function listTasks() {
    return [...tasks];
  }

  function addTask(input, now = new Date()) {
    const task = createTaskSpec(input);
    tasks.push(task);
    persist();
    auditLog?.logEvent({
      operator: task.createdBy,
      type: "task_added",
      detail: { taskId: task.id, goal: task.goal, priority: task.priority },
    });
    // tick(), not just tryDispatch(): a task created with an earliestStart
    // that's already in the past must still go through the SCHEDULED ->
    // QUEUED transition before it's dispatch-eligible — only tick() does
    // that. Don't make a VA wait for the next scheduled tick for a task
    // that's already due the moment it's added.
    tick(now);
    return task;
  }

  function releaseDevice(deviceId) {
    const mode = deviceLease.getMode(deviceId);
    if (mode === "AI_RUNNING" || mode === "AI_PAUSED") {
      deviceLease.applyEvent(deviceId, "TASK_FINISHED"); // -> AI_IDLE, ready for the next task
    }
  }

  function findActiveTaskForDevice(deviceId) {
    return tasks.find(
      (t) => t.deviceSelector?.deviceId === deviceId && !isTerminal(t.state) && t.state !== TASK_STATES.NEEDS_HUMAN
    );
  }

  function cancelTask(taskId) {
    const task = getTask(taskId);
    if (!task || isTerminal(task.state)) return task ?? null;
    const deviceId = task.deviceSelector?.deviceId;
    const wasHoldingDevice = task.state === TASK_STATES.RUNNING || task.state === TASK_STATES.PAUSED;
    task.state = TASK_STATES.CANCELLED;
    task.updatedAt = new Date().toISOString();
    if (wasHoldingDevice && deviceId) releaseDevice(deviceId);
    persist();
    auditLog?.logEvent({ type: "task_cancelled", detail: { taskId } });
    if (wasHoldingDevice) tryDispatch(new Date());
    return task;
  }

  // /pause and /resume (COMMAND_QUEUE_SPEC.md §9) — per-task AI execution
  // control, distinct from /queue pause|resume which halts new dispatches
  // globally. Pausing keeps the device lease (AI_RUNNING -> AI_PAUSED, not
  // released) since the task/worker still owns it, just isn't allowed to
  // send input while paused.
  function pauseTask(taskId) {
    const task = getTask(taskId);
    if (!task || task.state !== TASK_STATES.RUNNING) return null;
    const deviceId = task.deviceSelector?.deviceId;
    task.state = TASK_STATES.PAUSED;
    task.updatedAt = new Date().toISOString();
    if (deviceId) deviceLease.applyEvent(deviceId, "PAUSE_TASK");
    persist();
    auditLog?.logEvent({ type: "task_paused", deviceId, detail: { taskId } });
    return task;
  }

  function resumeTask(taskId) {
    const task = getTask(taskId);
    if (!task || task.state !== TASK_STATES.PAUSED) return null;
    const deviceId = task.deviceSelector?.deviceId;
    task.state = TASK_STATES.RUNNING;
    task.updatedAt = new Date().toISOString();
    if (deviceId) deviceLease.applyEvent(deviceId, "RESUME_TASK");
    persist();
    auditLog?.logEvent({ type: "task_resumed", deviceId, detail: { taskId } });
    return task;
  }

  // /pause and /resume <deviceId> — an operator types a device id (visible
  // in the device list), not a raw task id, so these resolve to whichever
  // task currently holds that device and delegate to pauseTask/resumeTask.
  function pauseDevice(deviceId) {
    const task = findActiveTaskForDevice(deviceId);
    return task && task.state === TASK_STATES.RUNNING ? pauseTask(task.id) : null;
  }

  function resumeDevice(deviceId) {
    const task = findActiveTaskForDevice(deviceId);
    return task && task.state === TASK_STATES.PAUSED ? resumeTask(task.id) : null;
  }

  // /stop <deviceId> — cancels whatever's active on that device and returns
  // it to AI_IDLE (still AI-enabled, just nothing running). Distinct from
  // /takeover, which hands the device back to a human entirely.
  function stopDevice(deviceId) {
    const task = findActiveTaskForDevice(deviceId);
    if (task) {
      task.state = TASK_STATES.CANCELLED;
      task.result = { outcome: TASK_STATES.CANCELLED, detail: "stopped by operator", at: new Date().toISOString() };
      task.updatedAt = task.result.at;
      persist();
      auditLog?.logEvent({ type: "task_cancelled", deviceId, detail: { taskId: task.id, reason: "stop" } });
    }
    releaseDevice(deviceId);
    tryDispatch(new Date());
    return task ?? null;
  }

  // /takeover <deviceId> — cancels whatever's active, then a real handoff to
  // HUMAN (not just AI_IDLE) via deviceLease.switchToHuman, which is the
  // same graceful, bounded-wait mechanism MS6 built and the WS `takeover`
  // message already uses.
  async function takeoverDevice(deviceId) {
    const task = findActiveTaskForDevice(deviceId);
    if (task) {
      task.state = TASK_STATES.CANCELLED;
      task.result = {
        outcome: TASK_STATES.CANCELLED,
        detail: "operator took over the device",
        at: new Date().toISOString(),
      };
      task.updatedAt = task.result.at;
      persist();
      auditLog?.logEvent({ type: "task_cancelled", deviceId, detail: { taskId: task.id, reason: "takeover" } });
    }
    await deviceLease.switchToHuman(deviceId);
    tryDispatch(new Date());
    return task ?? null;
  }

  // The WS `emergency_stop` message (CLAUDE.md §4: "must be able to revoke
  // AI input immediately") called deviceLease.emergencyStop() directly until
  // now, bypassing this queue entirely — the same class of bug the WS
  // `takeover` handler had before it was pointed at takeoverDevice above: a
  // task left RUNNING in the queue's own state while the device it thinks it
  // holds has already been forced back to HUMAN underneath it, so the device
  // never becomes eligible for the next dispatch. Unlike takeoverDevice, this
  // is deliberately synchronous — deviceLease.emergencyStop() never awaits a
  // pending action (that's the entire point of an emergency stop; see its
  // own comment), so this can't either without reintroducing the same wait
  // a stuck action was supposed to bypass.
  function emergencyStopDevice(deviceId) {
    const task = findActiveTaskForDevice(deviceId);
    if (task) {
      task.state = TASK_STATES.CANCELLED;
      task.result = {
        outcome: TASK_STATES.CANCELLED,
        detail: "emergency stop",
        at: new Date().toISOString(),
      };
      task.updatedAt = task.result.at;
      persist();
      auditLog?.logEvent({ type: "task_cancelled", deviceId, detail: { taskId: task.id, reason: "emergency_stop" } });
    }
    deviceLease.emergencyStop(deviceId);
    tryDispatch(new Date());
    return task ?? null;
  }

  function moveTask(taskId, relation, targetId) {
    const idx = tasks.findIndex((t) => t.id === taskId);
    const targetIdx = tasks.findIndex((t) => t.id === targetId);
    if (idx === -1 || targetIdx === -1 || taskId === targetId) return false;
    const [task] = tasks.splice(idx, 1);
    const newTargetIdx = tasks.findIndex((t) => t.id === targetId);
    tasks.splice(relation === "before" ? newTargetIdx : newTargetIdx + 1, 0, task);
    persist();
    return true;
  }

  function setPriority(taskId, priority) {
    const task = getTask(taskId);
    if (!task) return null;
    task.priority = priority;
    task.updatedAt = new Date().toISOString();
    persist();
    return task;
  }

  function pauseQueue() {
    paused = true;
  }
  function resumeQueue() {
    paused = false;
  }
  function isPaused() {
    return paused;
  }

  function checkpoint(taskId, data) {
    const task = getTask(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    const entry = { at: new Date().toISOString(), data };
    task.checkpoints.push(entry);
    task.updatedAt = entry.at;
    persist();
    auditLog?.logEvent({
      operator: task.createdBy,
      type: "task_checkpoint",
      deviceId: task.deviceSelector?.deviceId ?? null,
      detail: { taskId, data },
    });
    return entry;
  }

  // Eligibility (COMMAND_QUEUE_SPEC.md §6): window open, dependencies
  // satisfied. Device availability and policy/concurrency are checked
  // separately in pickTaskForDevice/freeDevices — there's no policy engine
  // or workspace concurrency config yet (that's MS9/10/12), so those two
  // checks are structurally always-pass placeholders for now, not silently
  // skipped logic.
  function isEligible(task, now) {
    if (task.state !== TASK_STATES.QUEUED) return false;
    if (!isWindowOpen(task, now)) return false;
    if (task.retryNotBefore && now.getTime() < new Date(task.retryNotBefore).getTime()) return false;
    return task.dependencies.every((depId) => getTask(depId)?.state === TASK_STATES.SUCCEEDED);
  }

  function freeDevices() {
    return [...devices.values()].filter((d) => {
      const mode = deviceLease.getMode(d.id);
      return (mode === "HUMAN" && d.status === "idle") || mode === "AI_IDLE";
    });
  }

  // Lowest array index wins among equal priority — this is what makes
  // moveTask() actually affect dispatch order (FIFO unless explicitly
  // reordered, per §6), rather than e.g. sorting by creation timestamp.
  function pickTaskForDevice(deviceId, now) {
    let best = null;
    let bestIdx = -1;
    tasks.forEach((t, idx) => {
      if (!isEligible(t, now)) return;
      const wants = t.deviceSelector?.deviceId;
      if (wants && wants !== deviceId) return;
      const allowedDeviceIds = t.deviceSelector?.allowedDeviceIds;
      if (Array.isArray(allowedDeviceIds) && !allowedDeviceIds.includes(deviceId)) return;
      if (!best || PRIORITY_ORDER[t.priority] < PRIORITY_ORDER[best.priority]) {
        best = t;
        bestIdx = idx;
      }
    });
    return best;
  }

  function dispatchTaskToDevice(task, deviceId, now) {
    if (deviceLease.getMode(deviceId) === "HUMAN") deviceLease.switchToAI(deviceId); // -> AI_IDLE
    deviceLease.applyEvent(deviceId, "START_TASK"); // -> AI_RUNNING
    task.state = TASK_STATES.RUNNING;
    task.deviceSelector = { ...task.deviceSelector, deviceId };
    task.retryNotBefore = null;
    task.dispatchedAt = now.toISOString();
    task.updatedAt = now.toISOString();
    persist();
    auditLog?.logEvent({
      operator: task.createdBy,
      type: "task_dispatched",
      deviceId,
      detail: { taskId: task.id, goal: task.goal },
    });
    emit("dispatched", { task, deviceId });
  }

  // Tries every currently-free device against the queue — not just one task
  // globally — since multiple devices can each run their own task at once.
  // Called after tick() and after every reportResult(), which is what makes
  // "no human click required between successful tasks" (§8) actually true.
  function tryDispatch(now) {
    if (paused) return [];
    const dispatched = [];
    for (const device of freeDevices()) {
      const task = pickTaskForDevice(device.id, now);
      if (!task) continue;
      dispatchTaskToDevice(task, device.id, now);
      dispatched.push(task);
    }
    return dispatched;
  }

  function finishRunningTaskAtWindowEnd(task, now) {
    const deviceId = task.deviceSelector?.deviceId;
    // A task that recorded at least one checkpoint made real progress —
    // PARTIAL, not EXPIRED (§7): the distinction future review depends on.
    task.state = task.checkpoints.length > 0 ? TASK_STATES.PARTIAL : TASK_STATES.EXPIRED;
    task.updatedAt = now.toISOString();
    task.result = { outcome: task.state, detail: "time window closed", at: now.toISOString() };
    if (deviceId) releaseDevice(deviceId);
    persist();
    auditLog?.logEvent({
      operator: task.createdBy,
      type: "task_window_closed",
      deviceId,
      detail: { taskId: task.id, finalState: task.state },
    });
  }

  // The clock-driven half of the scheduler — window open/close transitions
  // — separate from tryDispatch (the event-driven half). `now` is always an
  // explicit parameter, never read from Date.now() internally, so tests can
  // simulate time passing without real delays.
  function tick(now = new Date()) {
    let changed = false;
    for (const task of tasks) {
      if (task.state === TASK_STATES.SCHEDULED && isWindowOpen(task, now)) {
        task.state = TASK_STATES.QUEUED;
        task.updatedAt = now.toISOString();
        changed = true;
      } else if (
        (task.state === TASK_STATES.SCHEDULED || task.state === TASK_STATES.QUEUED) &&
        hasWindowExpired(task, now)
      ) {
        task.state = TASK_STATES.EXPIRED;
        task.result = { outcome: TASK_STATES.EXPIRED, detail: "window closed before it ever ran", at: now.toISOString() };
        task.updatedAt = now.toISOString();
        changed = true;
      } else if ([TASK_STATES.RUNNING, TASK_STATES.PAUSED].includes(task.state)
        && hasWindowExpired(task, now) && !task.allowOverrun) {
        finishRunningTaskAtWindowEnd(task, now);
        changed = true;
      }
    }
    if (changed) persist();
    tryDispatch(now);
  }

  // Async only because the NEEDS_HUMAN path awaits a real handoff — every
  // other outcome resolves synchronously in practice.
  async function reportResult(taskId, outcome, { detail } = {}) {
    const task = getTask(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.state !== TASK_STATES.RUNNING) {
      throw new Error(`task ${taskId} is not RUNNING (state: ${task.state})`);
    }
    if (!REPORTABLE_OUTCOMES.has(outcome)) throw new Error(`invalid task result outcome: ${outcome}`);
    const now = new Date();
    const deviceId = task.deviceSelector?.deviceId;

    if (outcome === TASK_STATES.FAILED_RETRYABLE) {
      task.retryCount += 1;
      task.state = task.retryCount <= task.retryPolicy.maxRetries ? TASK_STATES.QUEUED : TASK_STATES.FAILED_FINAL;
      task.retryNotBefore = task.state === TASK_STATES.QUEUED && task.retryPolicy.backoffMs > 0
        ? new Date(now.getTime() + task.retryPolicy.backoffMs).toISOString()
        : null;
    } else if (outcome === TASK_STATES.NEEDS_HUMAN) {
      task.state = TASK_STATES.NEEDS_HUMAN;
      task.retryNotBefore = null;
      if (deviceId) await deviceLease.switchToHuman(deviceId); // a real handoff, not just a status flag
    } else {
      task.state = outcome; // SUCCEEDED | PARTIAL | FAILED_FINAL | CANCELLED
      task.retryNotBefore = null;
    }
    task.result = { outcome, detail, at: now.toISOString() };
    task.updatedAt = now.toISOString();

    if (deviceId && task.state !== TASK_STATES.NEEDS_HUMAN) releaseDevice(deviceId);

    persist();
    auditLog?.logEvent({
      operator: task.createdBy,
      type: "task_result",
      deviceId,
      detail: { taskId, outcome, finalState: task.state },
    });
    emit("completed", { task });
    tryDispatch(now);
    return task;
  }

  return {
    addTask,
    listTasks,
    getTask,
    cancelTask,
    moveTask,
    setPriority,
    pauseQueue,
    resumeQueue,
    isPaused,
    checkpoint,
    tick,
    reportResult,
    pauseTask,
    resumeTask,
    pauseDevice,
    resumeDevice,
    stopDevice,
    takeoverDevice,
    emergencyStopDevice,
    on,
  };
}

export { createTaskQueue };
