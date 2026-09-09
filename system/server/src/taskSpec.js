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
    retryPolicy: { maxRetries: 0, backoffMs: 0, ...retryPolicy },
    retryCount: 0,
    allowOverrun,
    createdBy: createdBy ?? null,
    createdAt: now,
    state: earliestStart ? TASK_STATES.SCHEDULED : TASK_STATES.QUEUED,
    checkpoints: [],
    result: null,
    updatedAt: now,
  };
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

export { TASK_STATES, PRIORITIES, isTerminal, createTaskSpec, isWindowOpen, hasWindowExpired };
