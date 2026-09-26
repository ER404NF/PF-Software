// Persistence port for the task queue's durable snapshot (tasks, paused
// flag, human device holds). The queue's scheduling/eligibility/dispatch/
// retry/checkpoint mechanics (docs/COMMAND_QUEUE_SPEC.md §3,6-9,14) stay in
// taskQueue.js — that is domain/scheduling logic, not a persistence concern,
// and does not move behind this port. Only the snapshot read/write boundary
// does, matching what the session and audit slices did for their own
// domains.

import { TASK_STATES, normalizeRetryPolicy, validatePersistedTask } from "../taskSpec.js";

export const TASK_QUEUE_SNAPSHOT_REPOSITORY_METHODS = Object.freeze(["load", "save"]);

export function assertTaskQueueSnapshotRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("task queue snapshot repository must be an object");
  }
  for (const method of TASK_QUEUE_SNAPSHOT_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`task queue snapshot repository requires ${method}()`);
    }
  }
  return repository;
}

// Storage-agnostic legacy-format migration and crash-recovery logic, shared
// by every adapter so it exists exactly once. Takes whatever was decoded
// from storage (a legacy bare array, or the current
// { version, paused, humanHolds, tasks } shape) and returns the load()
// result plus whether the caller should persist the (possibly migrated or
// recovered) shape back to storage.
export function normalizeQueueSnapshot(stored) {
  const isLegacyArray = Array.isArray(stored);
  if (!isLegacyArray && (!stored || typeof stored !== "object" || !Array.isArray(stored.tasks))) {
    throw new Error("invalid queue snapshot");
  }
  const tasks = isLegacyArray ? stored : stored.tasks;
  const taskIds = new Set();
  for (let index = 0; index < tasks.length; index += 1) {
    const taskId = tasks[index]?.id;
    if (typeof taskId !== "string" || !taskId) throw new Error(`invalid queue snapshot task[${index}].id`);
    if (taskIds.has(taskId)) throw new Error(`invalid queue snapshot: duplicate task id ${taskId}`);
    taskIds.add(taskId);
  }
  const paused = isLegacyArray ? false : stored.paused === true;
  const humanHolds = new Set(isLegacyArray || !Array.isArray(stored.humanHolds)
    ? []
    : stored.humanHolds.filter((deviceId) => typeof deviceId === "string" && deviceId));
  let changed = isLegacyArray || stored.version !== 2 || !Array.isArray(stored.humanHolds);
  for (const task of tasks) {
    // Legacy array snapshots predate these fields. Migrate only known absent
    // fields; malformed present values are rejected below.
    if (!("kind" in task)) { task.kind = "generic"; changed = true; }
    if (!("maxDurationSec" in task)) { task.maxDurationSec = null; changed = true; }
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
    validatePersistedTask(task, tasks.indexOf(task));
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
  return { tasks, paused, humanHolds, changed };
}
