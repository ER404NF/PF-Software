import fs from "fs";
import path from "path";
import crypto from "crypto";

export const ASSIGNMENT_STATUSES = Object.freeze(["assigned", "in_progress", "completed", "cancelled", "expired"]);
const STATUS_SET = new Set(ASSIGNMENT_STATUSES);
const TRANSITIONS = Object.freeze({
  assigned: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["completed", "cancelled"]),
  completed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum;
}

function validateLoadedAssignment(value) {
  if (!value || typeof value !== "object" || !validText(value.id, 200)
    || !validText(value.instructions, 2_000) || !validText(value.assignee, 100)
    || !validText(value.createdBy, 100) || !STATUS_SET.has(value.status)
    || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.startAt !== undefined && value.startAt !== null && !Number.isFinite(Date.parse(value.startAt)))
    || (value.endAt !== undefined && value.endAt !== null && !Number.isFinite(Date.parse(value.endAt)))
    || ((value.startAt ?? null) === null) !== ((value.endAt ?? null) === null)
    || (value.startAt && Date.parse(value.startAt) >= Date.parse(value.endAt))
    || (value.exclusive !== undefined && typeof value.exclusive !== "boolean")
    || !Array.isArray(value.history)) {
    throw new Error("assignment store contains an invalid assignment");
  }
}

export function createAssignmentStore({ storePath, now = () => new Date(), id = () => crypto.randomUUID() } = {}) {
  if (typeof storePath !== "string" || !storePath) throw new Error("assignment store requires a storePath");
  let assignments = [];
  if (fs.existsSync(storePath)) {
    const saved = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (saved?.version !== 1 || !Array.isArray(saved.assignments)) throw new Error("invalid assignment store format");
    for (const assignment of saved.assignments) validateLoadedAssignment(assignment);
    assignments = clone(saved.assignments);
  }

  function timestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("assignment clock returned an invalid date");
    return date.toISOString();
  }

  function schedule(startAt, endAt, exclusive = true) {
    if ((startAt ?? null) === null && (endAt ?? null) === null) {
      if (typeof exclusive !== "boolean") throw new Error("exclusive must be a boolean");
      return { startAt: null, endAt: null, exclusive };
    }
    if (typeof startAt !== "string" || typeof endAt !== "string") {
      throw new Error("startAt and endAt must both be ISO date strings or null");
    }
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      throw new Error("assignment schedule requires startAt before endAt");
    }
    if (typeof exclusive !== "boolean") throw new Error("exclusive must be a boolean");
    return { startAt: start.toISOString(), endAt: end.toISOString(), exclusive };
  }

  function assertNoOverlap(candidate, excludedId = null) {
    if (!candidate.exclusive || !candidate.startAt) return;
    const start = Date.parse(candidate.startAt);
    const end = Date.parse(candidate.endAt);
    const conflict = assignments.find(existing => existing.id !== excludedId
      && !["completed", "cancelled", "expired"].includes(existing.status)
      && existing.exclusive !== false && existing.startAt && existing.endAt
      && start < Date.parse(existing.endAt) && end > Date.parse(existing.startAt)
      && ((candidate.deviceId && candidate.deviceId === existing.deviceId)
        || candidate.assignee === existing.assignee));
    if (conflict) throw new Error(`assignment overlaps active assignment ${conflict.id}`);
  }

  function persist(next) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, assignments: next }, null, 2), { flag: "wx" });
      fs.renameSync(temporary, storePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function commit(updated) {
    persist(updated);
    assignments = updated;
  }

  function list() {
    return clone(assignments).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function get(assignmentId) {
    const found = assignments.find(assignment => assignment.id === assignmentId);
    return found ? clone(found) : null;
  }

  function create({ instructions, assignee, createdBy, deviceId = null, accountId = null,
    startAt = null, endAt = null, exclusive = true }) {
    if (!validText(instructions, 2_000)) throw new Error("instructions must be 1-2000 characters");
    if (!validText(assignee, 100) || !validText(createdBy, 100)) throw new Error("assignee and creator are required");
    if (deviceId !== null && !validText(deviceId, 200)) throw new Error("deviceId must be a non-empty string or null");
    if (accountId !== null && !validText(accountId, 200)) throw new Error("accountId must be a non-empty string or null");
    const at = timestamp();
    const timing = schedule(startAt, endAt, exclusive);
    if (timing.endAt && Date.parse(timing.endAt) <= Date.parse(at)) throw new Error("assignment endAt must be in the future");
    const assignment = {
      id: id(),
      instructions: instructions.trim(),
      assignee: assignee.trim(),
      createdBy: createdBy.trim(),
      deviceId,
      accountId,
      ...timing,
      status: "assigned",
      createdAt: at,
      updatedAt: at,
      history: [{ at, actor: createdBy.trim(), action: "created", toStatus: "assigned", assignee: assignee.trim() }],
    };
    validateLoadedAssignment(assignment);
    if (assignments.some(existing => existing.id === assignment.id)) throw new Error("assignment id already exists");
    assertNoOverlap(assignment);
    commit([...assignments, assignment]);
    return clone(assignment);
  }

  function setStatus(assignmentId, status, actor) {
    if (!STATUS_SET.has(status)) throw new Error("invalid assignment status");
    if (!validText(actor, 100)) throw new Error("actor is required");
    const index = assignments.findIndex(assignment => assignment.id === assignmentId);
    if (index < 0) return null;
    const current = assignments[index];
    if (current.status === status) return clone(current);
    if (!TRANSITIONS[current.status].has(status)) throw new Error(`cannot move assignment from ${current.status} to ${status}`);
    const at = timestamp();
    if (status === "in_progress" && current.startAt && Date.parse(at) < Date.parse(current.startAt)) {
      throw new Error("cannot start assignment before startAt");
    }
    const updated = {
      ...current,
      status,
      updatedAt: at,
      history: [...current.history, { at, actor: actor.trim(), action: "status_changed", fromStatus: current.status, toStatus: status }],
    };
    const next = [...assignments];
    next[index] = updated;
    commit(next);
    return clone(updated);
  }

  function reassign(assignmentId, assignee, actor) {
    if (!validText(assignee, 100) || !validText(actor, 100)) throw new Error("assignee and actor are required");
    const index = assignments.findIndex(assignment => assignment.id === assignmentId);
    if (index < 0) return null;
    const current = assignments[index];
    if (["completed", "cancelled", "expired"].includes(current.status)) throw new Error("terminal assignments cannot be reassigned");
    if (current.assignee === assignee.trim()) return clone(current);
    const at = timestamp();
    const updated = {
      ...current,
      assignee: assignee.trim(),
      status: "assigned",
      updatedAt: at,
      history: [...current.history, {
        at,
        actor: actor.trim(),
        action: "reassigned",
        fromAssignee: current.assignee,
        toAssignee: assignee.trim(),
        fromStatus: current.status,
        toStatus: "assigned",
      }],
    };
    assertNoOverlap(updated, current.id);
    const next = [...assignments];
    next[index] = updated;
    commit(next);
    return clone(updated);
  }

  function reschedule(assignmentId, { startAt = null, endAt = null, exclusive = true }, actor) {
    if (!validText(actor, 100)) throw new Error("actor is required");
    const index = assignments.findIndex(assignment => assignment.id === assignmentId);
    if (index < 0) return null;
    const current = assignments[index];
    if (["completed", "cancelled", "expired"].includes(current.status)) throw new Error("terminal assignments cannot be rescheduled");
    const timing = schedule(startAt, endAt, exclusive);
    const at = timestamp();
    if (timing.endAt && Date.parse(timing.endAt) <= Date.parse(at)) throw new Error("assignment endAt must be in the future");
    if (current.status === "in_progress" && timing.startAt && Date.parse(timing.startAt) > Date.parse(at)) {
      throw new Error("an in-progress assignment cannot be rescheduled into the future");
    }
    const updated = {
      ...current,
      ...timing,
      updatedAt: at,
      history: [...current.history, {
        at,
        actor: actor.trim(),
        action: "rescheduled",
        fromStartAt: current.startAt ?? null,
        fromEndAt: current.endAt ?? null,
        toStartAt: timing.startAt,
        toEndAt: timing.endAt,
        exclusive: timing.exclusive,
      }],
    };
    assertNoOverlap(updated, current.id);
    const next = [...assignments];
    next[index] = updated;
    commit(next);
    return clone(updated);
  }

  function expireDue(at = new Date()) {
    const cutoff = at instanceof Date ? at : new Date(at);
    if (!Number.isFinite(cutoff.getTime())) throw new Error("expiration cutoff must be a valid date");
    const stamp = cutoff.toISOString();
    const expired = [];
    const next = assignments.map(assignment => {
      if (!["assigned", "in_progress"].includes(assignment.status)
        || !assignment.endAt || Date.parse(assignment.endAt) > cutoff.getTime()) return assignment;
      const updated = {
        ...assignment,
        status: "expired",
        updatedAt: stamp,
        history: [...assignment.history, {
          at: stamp,
          actor: "system",
          action: "expired",
          fromStatus: assignment.status,
          toStatus: "expired",
        }],
      };
      expired.push(clone(updated));
      return updated;
    });
    if (expired.length) commit(next);
    return expired;
  }

  return { list, get, create, setStatus, reassign, reschedule, expireDue };
}
