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

import {
  TASK_STATES,
  isTerminal,
  createTaskSpec,
  isWindowOpen,
  hasWindowExpired,
  normalizeRetryPolicy,
  hasExecutionExpired,
  validatePersistedTask,
} from "./taskSpec.js";
import { createFileTaskQueueSnapshotRepository } from "./persistence/fileTaskQueueSnapshotRepository.js";

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };
const REPORTABLE_OUTCOMES = new Set([
  TASK_STATES.SUCCEEDED,
  TASK_STATES.PARTIAL,
  TASK_STATES.FAILED_RETRYABLE,
  TASK_STATES.FAILED_FINAL,
  TASK_STATES.CANCELLED,
  TASK_STATES.NEEDS_HUMAN,
]);

// Snapshot read/write (atomic write, legacy-format and interrupted-task
// recovery on load) moved to persistence/fileTaskQueueSnapshotRepository.js
// as part of the task-queue persistence slice. This factory still accepts
// storePath directly for compatibility; pass `repository` instead to inject
// a different persistence port (tests, or a future database-backed one).
function createTaskQueue({ devices, deviceLease, auditLog, storePath, repository = createFileTaskQueueSnapshotRepository(storePath),
  dispatchOnCreate = true, canDispatch = () => true }) {
  const snapshot = repository.load();
  const tasks = snapshot.tasks;
  let paused = snapshot.paused;
  const humanHolds = snapshot.humanHolds;
  const listeners = { dispatched: [], completed: [] };

  function persist() {
    // A crash during a direct truncate/write can destroy the only durable
    // queue snapshot. The repository writes a complete sibling file and
    // atomically replaces the destination so restart recovery sees the old
    // or new state only.
    repository.save(tasks, paused, humanHolds);
  }

  // Restart recovery (COMMAND_QUEUE_SPEC.md §14): repository.load() above already
  // requeued or failed any interrupted task per its retry policy — this is
  // what actually lets a requeued one resume immediately on a fresh device
  // set (every device starts HUMAN/idle on a new process) rather than
  // waiting for the first scheduled tick.
  // Paused tasks retain exclusive ownership across restart without running
  // input. Rebuild their lease before the scheduler examines free devices.
  for (const task of tasks.filter(task => task.state === TASK_STATES.PAUSED)) {
    const id = task.deviceSelector?.deviceId;
    if (!devices.has(id) || humanHolds.has(id)) continue;
    if (deviceLease.getMode(id) !== "HUMAN" || devices.get(id).status !== "idle") {
      throw new Error(`cannot restore paused ownership for device ${id}`);
    }
    deviceLease.switchToAI(id);
    deviceLease.applyEvent(id, "START_TASK");
    deviceLease.applyEvent(id, "PAUSE_TASK");
  }
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
    if (input?.clientRequestId) {
      const existing = tasks.find(candidate => candidate.clientRequestId === input.clientRequestId
        && candidate.createdBy === (input.createdBy ?? null));
      if (existing) return existing;
    }
    const task = createTaskSpec(input);
    // Admit the task durably before exposing it to the live scheduler. If
    // storage is unavailable, callers receive an error and no hidden task is
    // left in memory to dispatch on a later tick.
    repository.save([...tasks, task], paused, humanHolds);
    tasks.push(task);
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
      if (deviceLease.finishAiTask) {
        const draining = deviceLease.finishAiTask(deviceId);
        if (draining) void draining.then(() => tryDispatch(new Date())).catch(error => {
          deviceLease.markError(deviceId);
          auditLog?.logEvent({ type: "task_drain_failed", deviceId, detail: { error: error.message } });
        });
      } else deviceLease.applyEvent(deviceId, "TASK_FINISHED");
    }
  }

  function findActiveTaskForDevice(deviceId) {
    return tasks.find(
      (t) => t.deviceSelector?.deviceId === deviceId
        && (t.state === TASK_STATES.RUNNING || t.state === TASK_STATES.PAUSED)
    );
  }

  function cancelTask(taskId) {
    const task = getTask(taskId);
    if (!task || isTerminal(task.state)) return task ?? null;
    const deviceId = task.deviceSelector?.deviceId;
    const wasHoldingDevice = task.state === TASK_STATES.RUNNING || task.state === TASK_STATES.PAUSED;
    const nextTask = { ...task, state: TASK_STATES.CANCELLED, updatedAt: new Date().toISOString() };
    repository.save(tasks.map(candidate => candidate === task ? nextTask : candidate), paused, humanHolds);
    Object.assign(task, nextTask);
    if (wasHoldingDevice && deviceId) releaseDevice(deviceId);
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
    const nextTask = { ...task, state: TASK_STATES.PAUSED, updatedAt: new Date().toISOString() };
    repository.save(tasks.map(candidate => candidate === task ? nextTask : candidate), paused, humanHolds);
    try {
      if (deviceId) deviceLease.applyEvent(deviceId, "PAUSE_TASK");
    } catch (error) {
      repository.save(tasks, paused, humanHolds);
      throw error;
    }
    Object.assign(task, nextTask);
    auditLog?.logEvent({ type: "task_paused", deviceId, detail: { taskId } });
    return task;
  }

  function resumeTask(taskId) {
    const task = getTask(taskId);
    if (!task || task.state !== TASK_STATES.PAUSED) return null;
    const deviceId = task.deviceSelector?.deviceId;
    const nextTask = { ...task, state: TASK_STATES.RUNNING, updatedAt: new Date().toISOString() };
    repository.save(tasks.map(candidate => candidate === task ? nextTask : candidate), paused, humanHolds);
    try {
      if (deviceId) deviceLease.applyEvent(deviceId, "RESUME_TASK");
    } catch (error) {
      repository.save(tasks, paused, humanHolds);
      throw error;
    }
    Object.assign(task, nextTask);
    auditLog?.logEvent({ type: "task_resumed", deviceId, detail: { taskId } });
    // Starts a recovered worker; the runner coalesces an already active one.
    emit("dispatched", { task, deviceId });
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
  function stopDevice(deviceId, reason = "operator") {
    const task = findActiveTaskForDevice(deviceId);
    if (task) {
      task.state = TASK_STATES.CANCELLED;
      task.result = { outcome: TASK_STATES.CANCELLED,
        detail: reason === "network_policy" ? "stopped by fail-closed network policy" : "stopped by operator",
        at: new Date().toISOString() };
      task.updatedAt = task.result.at;
    }
    // Physical input revocation must not depend on a successful disk write.
    releaseDevice(deviceId);
    try { persist(); }
    catch (error) {
      humanHolds.add(deviceId);
      deviceLease.markError?.(deviceId);
      throw error; // cancellation was not durable; require explicit recovery
    }
    if (task) auditLog?.logEvent({ type: "task_cancelled", deviceId,
      detail: { taskId: task.id, reason: reason === "network_policy" ? "network_policy" : "stop" } });
    tryDispatch(new Date());
    return task ?? null;
  }

  // /takeover <deviceId> — cancels whatever's active, then a real handoff to
  // HUMAN (not just AI_IDLE) via deviceLease.switchToHuman, which is the
  // same graceful, bounded-wait mechanism MS6 built and the WS `takeover`
  // message already uses.
  async function takeoverDevice(deviceId) {
    const task = findActiveTaskForDevice(deviceId);
    humanHolds.add(deviceId);
    if (task) {
      task.state = TASK_STATES.CANCELLED;
      task.result = {
        outcome: TASK_STATES.CANCELLED,
        detail: "operator took over the device",
        at: new Date().toISOString(),
      };
      task.updatedAt = task.result.at;
      auditLog?.logEvent({ type: "task_cancelled", deviceId, detail: { taskId: task.id, reason: "takeover" } });
    }
    persist();
    await deviceLease.switchToHuman(deviceId);
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
    // Revoke input first: emergency stop must never wait on storage or an
    // in-flight action. The durable human hold below prevents a later tick
    // or restart from immediately assigning queued AI work back to it.
    deviceLease.emergencyStop(deviceId);
    humanHolds.add(deviceId);
    if (task) {
      task.state = TASK_STATES.CANCELLED;
      task.result = {
        outcome: TASK_STATES.CANCELLED,
        detail: "emergency stop",
        at: new Date().toISOString(),
      };
      task.updatedAt = task.result.at;
      auditLog?.logEvent({ type: "task_cancelled", deviceId, detail: { taskId: task.id, reason: "emergency_stop" } });
    }
    persist();
    return task ?? null;
  }

  // An explicit operator switch to AI mode is the only action that clears a
  // takeover/emergency hold. Persist the release before dispatching work so
  // a restart cannot revive a hold the operator already removed.
  function allowAiDispatch(deviceId) {
    if (humanHolds.has(deviceId)) {
      const nextHolds = new Set(humanHolds);
      nextHolds.delete(deviceId);
      repository.save(tasks, paused, nextHolds);
      humanHolds.delete(deviceId);
    }
    tryDispatch(new Date());
  }

  function moveTask(taskId, relation, targetId) {
    const idx = tasks.findIndex((t) => t.id === taskId);
    const targetIdx = tasks.findIndex((t) => t.id === targetId);
    if (idx === -1 || targetIdx === -1 || taskId === targetId) return false;
    const nextTasks = [...tasks];
    const [task] = nextTasks.splice(idx, 1);
    const newTargetIdx = nextTasks.findIndex((t) => t.id === targetId);
    nextTasks.splice(relation === "before" ? newTargetIdx : newTargetIdx + 1, 0, task);
    repository.save(nextTasks, paused, humanHolds);
    tasks.splice(0, tasks.length, ...nextTasks);
    return true;
  }

  function setPriority(taskId, priority) {
    const task = getTask(taskId);
    if (!task) return null;
    const nextTask = { ...task, priority, updatedAt: new Date().toISOString() };
    repository.save(tasks.map(candidate => candidate === task ? nextTask : candidate), paused, humanHolds);
    Object.assign(task, nextTask);
    return task;
  }

  function pauseQueue() {
    if (paused) return;
    repository.save(tasks, true, humanHolds);
    paused = true;
  }
  function resumeQueue() {
    if (!paused) return;
    repository.save(tasks, false, humanHolds);
    paused = false;
  }
  function isPaused() {
    return paused;
  }

  function checkpoint(taskId, data) {
    const task = getTask(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    const entry = { at: new Date().toISOString(), data };
    const nextTask = { ...task, checkpoints: [...task.checkpoints, entry], updatedAt: entry.at };
    repository.save(tasks.map(candidate => candidate === task ? nextTask : candidate), paused, humanHolds);
    Object.assign(task, nextTask);
    auditLog?.logEvent({
      operator: task.createdBy,
      type: "task_checkpoint",
      deviceId: task.deviceSelector?.deviceId ?? null,
      detail: { taskId, data },
    });
    return entry;
  }

  function renamePrincipal(previousUsername, username) {
    if (typeof previousUsername !== "string" || !previousUsername.trim()
      || typeof username !== "string" || !username.trim()) {
      throw new Error("previous username and username are required");
    }
    const previous = previousUsername.trim();
    const nextUsername = username.trim();
    const changed = tasks.filter(task => task.createdBy === previous);
    if (!changed.length || previous === nextUsername) return [];
    const nextTasks = tasks.map(task => task.createdBy === previous ? { ...task, createdBy: nextUsername } : task);
    repository.save(nextTasks, paused, humanHolds);
    for (let index = 0; index < tasks.length; index += 1) {
      if (nextTasks[index] !== tasks[index]) Object.assign(tasks[index], nextTasks[index]);
    }
    return changed.map(task => task.id);
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
      if (humanHolds.has(d.id) || deviceLease.hasPendingAiAction?.(d.id)) return false;
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
      if (!isEligible(t, now) || !canDispatch(t, deviceId)) return;
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
    const previousMode = deviceLease.getMode(deviceId);
    const previousTask = {
      state: task.state,
      deviceSelector: task.deviceSelector,
      retryNotBefore: task.retryNotBefore,
      dispatchedAt: task.dispatchedAt,
      updatedAt: task.updatedAt,
    };
    try {
      if (previousMode === "HUMAN") deviceLease.switchToAI(deviceId); // -> AI_IDLE
      deviceLease.applyEvent(deviceId, "START_TASK"); // -> AI_RUNNING
      task.state = TASK_STATES.RUNNING;
      task.deviceSelector = { ...task.deviceSelector, deviceId };
      task.retryNotBefore = null;
      task.dispatchedAt = now.toISOString();
      task.updatedAt = now.toISOString();
      persist();
    } catch (error) {
      task.state = previousTask.state;
      task.deviceSelector = previousTask.deviceSelector;
      task.retryNotBefore = previousTask.retryNotBefore;
      task.updatedAt = previousTask.updatedAt;
      if (previousTask.dispatchedAt === undefined) delete task.dispatchedAt;
      else task.dispatchedAt = previousTask.dispatchedAt;

      const currentMode = deviceLease.getMode(deviceId);
      if (previousMode === "AI_IDLE" && currentMode === "AI_RUNNING") {
        deviceLease.applyEvent(deviceId, "TASK_FINISHED");
      } else if (currentMode !== previousMode) {
        // A failed dispatch must fail closed. HUMAN is the only synchronous
        // safe fallback when a partially-completed lease transition cannot
        // be restored exactly.
        deviceLease.emergencyStop(deviceId);
      }
      return null;
    }
    auditLog?.logEvent({
      operator: task.createdBy,
      type: "task_dispatched",
      deviceId,
      detail: { taskId: task.id, goal: task.goal },
    });
    emit("dispatched", { task, deviceId });
    return task;
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
      if (dispatchTaskToDevice(task, device.id, now)) dispatched.push(task);
    }
    return dispatched;
  }

  function taskAtWindowEnd(task, now) {
    // A task that recorded at least one checkpoint made real progress —
    // PARTIAL, not EXPIRED (§7): the distinction future review depends on.
    const state = task.checkpoints.length > 0 ? TASK_STATES.PARTIAL : TASK_STATES.EXPIRED;
    return { ...task, state, updatedAt: now.toISOString(), result: { outcome: state,
      detail: task.maxDurationSec && new Date(task.dispatchedAt).getTime() + task.maxDurationSec * 1000 <= now.getTime()
      ? "task duration limit reached" : "time window closed", at: now.toISOString() } };
  }

  // The clock-driven half of the scheduler — window open/close transitions
  // — separate from tryDispatch (the event-driven half). `now` is always an
  // explicit parameter, never read from Date.now() internally, so tests can
  // simulate time passing without real delays.
  function tick(now = new Date()) {
    const transitions = [];
    const nextTasks = tasks.map(task => {
      let nextTask = task;
      if (task.state === TASK_STATES.SCHEDULED && isWindowOpen(task, now)) {
        nextTask = { ...task, state: TASK_STATES.QUEUED, updatedAt: now.toISOString() };
      } else if (
        (task.state === TASK_STATES.SCHEDULED || task.state === TASK_STATES.QUEUED) &&
        hasWindowExpired(task, now)
      ) {
        nextTask = { ...task, state: TASK_STATES.EXPIRED, updatedAt: now.toISOString(),
          result: { outcome: TASK_STATES.EXPIRED, detail: "window closed before it ever ran", at: now.toISOString() } };
      } else if ([TASK_STATES.RUNNING, TASK_STATES.PAUSED].includes(task.state)
        && hasExecutionExpired(task, now)) {
        nextTask = taskAtWindowEnd(task, now);
      }
      if (nextTask !== task) transitions.push({ task, nextTask });
      return nextTask;
    });
    if (transitions.length) repository.save(nextTasks, paused, humanHolds);
    for (const { task, nextTask } of transitions) {
      const wasHolding = [TASK_STATES.RUNNING, TASK_STATES.PAUSED].includes(task.state);
      const deviceId = task.deviceSelector?.deviceId;
      Object.assign(task, nextTask);
      if (wasHolding && deviceId) {
        releaseDevice(deviceId);
        auditLog?.logEvent({ operator: task.createdBy, type: "task_window_closed", deviceId,
          detail: { taskId: task.id, finalState: task.state } });
      }
    }
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
      if (deviceId) {
        // Persist the hold before awaiting handoff: neither a tick nor a
        // restart may dispatch another task while the operator is needed.
        humanHolds.add(deviceId);
        persist();
        await deviceLease.switchToHuman(deviceId);
      }
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
    renamePrincipal,
    tick,
    reportResult,
    pauseTask,
    resumeTask,
    pauseDevice,
    resumeDevice,
    stopDevice,
    takeoverDevice,
    emergencyStopDevice,
    allowAiDispatch,
    on,
  };
}

export { createTaskQueue };
