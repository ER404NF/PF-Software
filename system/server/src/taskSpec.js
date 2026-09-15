// TaskSpec shape and task-state machine (docs/COMMAND_QUEUE_SPEC.md §4-5).
// Field names are camelCase here (workspaceId, not workspace_id) to match
// this codebase's existing convention (researchStore.js's sourceHandle,
// etc.) — the spec's own JSON examples use snake_case, but nothing else in
// this project does.

import crypto from "crypto";

const TASK_STATES = Object.freeze({
  DRAFT: "DRAFT",
  VALIDATED: "VALIDATED",
  QUEUED: "QUEUED",
  SCHEDULED: "SCHEDULED",
  DISPATCHED: "DISPATCHED",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  NEEDS_HUMAN: "NEEDS_HUMAN",
  SUCCEEDED: "SUCCEEDED",
  PARTIAL: "PARTIAL",
  FAILED_RETRYABLE: "FAILED_RETRYABLE",
  FAILED_FINAL: "FAILED_FINAL",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
});

const TERMINAL_STATES = new Set([
  TASK_STATES.SUCCEEDED,
  TASK_STATES.PARTIAL,
  TASK_STATES.FAILED_FINAL,
  TASK_STATES.CANCELLED,
  TASK_STATES.EXPIRED,
]);

const PRIORITIES = Object.freeze(["low", "normal", "high", "urgent"]);

function normalizeRetryPolicy(retryPolicy = {}) {
  if (!retryPolicy || typeof retryPolicy !== "object" || Array.isArray(retryPolicy)) {
    throw new Error("retryPolicy must be an object");
  }
  const normalized = { maxRetries: 0, backoffMs: 0, ...retryPolicy };
  if (!Number.isSafeInteger(normalized.maxRetries) || normalized.maxRetries < 0) {
    throw new Error("retryPolicy.maxRetries must be a non-negative integer");
  }
  if (!Number.isSafeInteger(normalized.backoffMs) || normalized.backoffMs < 0) {
    throw new Error("retryPolicy.backoffMs must be a non-negative integer");
  }
  return normalized;
}

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

// Builds a valid TaskSpec from operator/parser input, applying defaults.
// Throws on genuinely invalid input (missing goal) rather than silently
// inventing one — COMMAND_QUEUE_SPEC.md §12 is explicit that ambiguous
// high-impact fields must never be silently invented.
function createTaskSpec({
  kind = "generic",
  goal,
  deviceSelector = {},
  accountSelector = {},
  criteria = {},
  allowedActions = [],
  requiredActions = [],
  earliestStart = null,
  latestEnd = null,
  maxDurationSec = null,
  priority = "normal",
  dependencies = [],
  retryPolicy = {},
  createdBy,
  clientRequestId = null,
  allowOverrun = false,
} = {}) {
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new Error("goal is required");
  }
  if (kind !== "generic" && kind !== "research") throw new Error(`invalid task kind: ${kind}`);
  if (!PRIORITIES.includes(priority)) {
    throw new Error(`invalid priority: ${priority}`);
  }
  for (const [name, value] of [["earliestStart", earliestStart], ["latestEnd", latestEnd]]) {
    if (value !== null && (typeof value !== "string" || !value.trim() || !Number.isFinite(new Date(value).getTime()))) {
      throw new Error(`${name} must be a valid date-time string or null`);
    }
  }
  if (earliestStart && latestEnd && new Date(earliestStart) >= new Date(latestEnd)) {
    throw new Error("earliestStart must be before latestEnd");
  }

  if (maxDurationSec !== null && (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0
    || Date.now() + maxDurationSec * 1000 > 8640000000000000)) {
    throw new Error("maxDurationSec must be a positive finite duration or null");
  }
  const normalizedRetryPolicy = normalizeRetryPolicy(retryPolicy);
  if (clientRequestId !== null && (typeof clientRequestId !== "string" || !/^[A-Za-z0-9_.:-]{8,200}$/.test(clientRequestId))) {
    throw new Error("clientRequestId must be 8-200 safe characters or null");
  }

  const now = new Date().toISOString();
  return {
    id: `task_${crypto.randomUUID()}`,
    kind,
    goal,
    deviceSelector,
    accountSelector,
    criteria,
    allowedActions,
    requiredActions,
    earliestStart,
    latestEnd,
    maxDurationSec,
    priority,
    dependencies,
    retryPolicy: normalizedRetryPolicy,
    retryCount: 0,
    retryNotBefore: null,
    allowOverrun,
    createdBy: createdBy ?? null,
    clientRequestId,
    createdAt: now,
    state: earliestStart ? TASK_STATES.SCHEDULED : TASK_STATES.QUEUED,
    checkpoints: [],
    result: null,
    updatedAt: now,
  };
}

function validObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validDateOrNull(value) {
  return value === null || (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value)));
}

// Validate durable records before restart recovery mutates them or restores a
// device lease. A malformed snapshot is a startup error, not trusted state.
function validatePersistedTask(task, index = 0) {
  const fail = field => { throw new Error(`invalid queue snapshot task[${index}].${field}`); };
  if (!validObject(task)) fail("record");
  if (typeof task.id !== "string" || !/^task_[A-Za-z0-9_-]{1,200}$/.test(task.id)) fail("id");
  if (!Object.values(TASK_STATES).includes(task.state)) fail("state");
  if (!["generic", "research"].includes(task.kind)) fail("kind");
  if (typeof task.goal !== "string" || !task.goal.trim()) fail("goal");
  if (!PRIORITIES.includes(task.priority)) fail("priority");
  if (!validObject(task.deviceSelector)) fail("deviceSelector");
  if (!validObject(task.accountSelector)) fail("accountSelector");
  for (const field of ["criteria"]) if (!validObject(task[field])) fail(field);
  for (const field of ["allowedActions", "requiredActions", "dependencies", "checkpoints"]) {
    if (!Array.isArray(task[field])) fail(field);
  }
  if (!Number.isSafeInteger(task.retryCount) || task.retryCount < 0) fail("retryCount");
  try { normalizeRetryPolicy(task.retryPolicy ?? {}); } catch { fail("retryPolicy"); }
  for (const field of ["earliestStart", "latestEnd", "retryNotBefore"]) {
    if (!validDateOrNull(task[field] ?? null)) fail(field);
  }
  for (const field of ["createdAt", "updatedAt"]) {
    if (typeof task[field] !== "string" || !Number.isFinite(Date.parse(task[field]))) fail(field);
  }
  if (task.clientRequestId != null
    && (typeof task.clientRequestId !== "string" || !/^[A-Za-z0-9_.:-]{8,200}$/.test(task.clientRequestId))) fail("clientRequestId");
  if (task.result !== null && task.result !== undefined && !validObject(task.result)) fail("result");
  if ([TASK_STATES.RUNNING, TASK_STATES.PAUSED, TASK_STATES.DISPATCHED].includes(task.state)
    && (typeof task.deviceSelector.deviceId !== "string" || !task.deviceSelector.deviceId)) fail("deviceSelector.deviceId");
  return task;
}

// Whether `task`'s time window (if any) is open at `now`. A task with no
// window is always "open" — it's eligible whenever the queue would
// otherwise consider it, per COMMAND_QUEUE_SPEC.md §7 (only bounded tasks
// have a window to be inside or outside of).
function isWindowOpen(task, now) {
  const t = now.getTime();
  if (task.earliestStart && t < new Date(task.earliestStart).getTime()) return false;
  if (task.latestEnd && t >= new Date(task.latestEnd).getTime()) return false;
  return true;
}

function hasWindowExpired(task, now) {
  return Boolean(task.latestEnd) && now.getTime() >= new Date(task.latestEnd).getTime();
}

export { TASK_STATES, PRIORITIES, isTerminal, createTaskSpec, isWindowOpen, hasWindowExpired, normalizeRetryPolicy, validatePersistedTask };

// Duration is elapsed wall time per dispatch attempt, including pauses.
// Retries start a new attempt; dispatchedAt makes the deadline durable.
export function hasExecutionExpired(task, now = new Date()) {
  const durationEnd = task.maxDurationSec != null && task.dispatchedAt
    ? new Date(task.dispatchedAt).getTime() + task.maxDurationSec * 1000 : Infinity;
  return now.getTime() >= durationEnd || (!task.allowOverrun && hasWindowExpired(task, now));
}
