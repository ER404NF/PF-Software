import fs from "fs";
import path from "path";
import crypto from "crypto";

export const ASSIGNMENT_STATUSES = Object.freeze(["assigned", "in_progress", "completed", "cancelled", "expired"]);
export const ASSIGNMENT_RECURRENCES = Object.freeze(["once", "daily", "weekly"]);
const STATUS_SET = new Set(ASSIGNMENT_STATUSES);
const RECURRENCE_SET = new Set(ASSIGNMENT_RECURRENCES);
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
    || (value.recurrence !== undefined && !RECURRENCE_SET.has(value.recurrence))
    || (value.occurrence !== undefined && (!Number.isInteger(value.occurrence) || value.occurrence < 1))
    || ((value.recurrence === "daily" || value.recurrence === "weekly") && (!value.startAt || !value.endAt))
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
    startAt = null, endAt = null, exclusive = true, recurrence = "once" }) {
    if (!validText(instructions, 2_000)) throw new Error("instructions must be 1-2000 characters");
    if (!validText(assignee, 100) || !validText(createdBy, 100)) throw new Error("assignee and creator are required");
    if (deviceId !== null && !validText(deviceId, 200)) throw new Error("deviceId must be a non-empty string or null");
    if (accountId !== null && !validText(accountId, 200)) throw new Error("accountId must be a non-empty string or null");
    if (!RECURRENCE_SET.has(recurrence)) throw new Error("recurrence must be once, daily, or weekly");
    const at = timestamp();
    const timing = schedule(startAt, endAt, exclusive);
    if (recurrence !== "once" && !timing.startAt) throw new Error("daily and weekly assignments require a schedule");
    if (timing.endAt && Date.parse(timing.endAt) <= Date.parse(at)) throw new Error("assignment endAt must be in the future");
    const assignment = {
      id: id(),
      instructions: instructions.trim(),
      assignee: assignee.trim(),
      createdBy: createdBy.trim(),
      deviceId,
      accountId,
      ...timing,
      recurrence,
      occurrence: 1,
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
    let updated;
    const recurrence = current.recurrence ?? "once";
    if (status === "completed" && recurrence !== "once") {
      const intervalMs = recurrence === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
      let nextStart = Date.parse(current.startAt) + intervalMs;
      let nextEnd = Date.parse(current.endAt) + intervalMs;
      let advanced = 1;
      while (nextEnd <= Date.parse(at)) {
        nextStart += intervalMs;
        nextEnd += intervalMs;
        advanced += 1;
      }
      updated = {
        ...current,
        status: "assigned",
        startAt: new Date(nextStart).toISOString(),
        endAt: new Date(nextEnd).toISOString(),
        occurrence: (current.occurrence ?? 1) + advanced,
        lastCompletedAt: at,
        updatedAt: at,
        history: [...current.history, {
          at,
          actor: actor.trim(),
          action: "recurrence_completed",
          fromStatus: current.status,
          toStatus: "assigned",
          completedOccurrence: current.occurrence ?? 1,
          recurrence,
        }],
      };
      assertNoOverlap(updated, current.id);
    } else {
      updated = {
        ...current,
        status,
        updatedAt: at,
        history: [...current.history, { at, actor: actor.trim(), action: "status_changed", fromStatus: current.status, toStatus: status }],
      };
    }
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

  function renamePrincipal(previousUsername, username, actor) {
    if (!validText(previousUsername, 100) || !validText(username, 100) || !validText(actor, 100)) {
      throw new Error("previous username, username, and actor are required");
    }
    const previous = previousUsername.trim();
    const nextUsername = username.trim();
    const changed = assignments.map(assignment => {
      const wasAssignee = assignment.assignee === previous;
      const wasCreator = assignment.createdBy === previous;
      if (!wasAssignee && !wasCreator) return assignment;
      const at = timestamp();
      return {
        ...assignment,
        ...(wasAssignee ? { assignee: nextUsername } : {}),
        ...(wasCreator ? { createdBy: nextUsername } : {}),
        updatedAt: at,
        history: [...assignment.history, {
          at,
          actor: actor.trim(),
          action: "principal_renamed",
          previousUsername: previous,
          username: nextUsername,
        }],
      };
    });
    const updated = changed.filter((assignment, index) => assignment !== assignments[index]);
    if (updated.length) commit(changed);
    return clone(updated);
  }

  function reschedule(assignmentId, { startAt = null, endAt = null, exclusive = true }, actor) {
    if (!validText(actor, 100)) throw new Error("actor is required");
    const index = assignments.findIndex(assignment => assignment.id === assignmentId);
    if (index < 0) return null;
    const current = assignments[index];
    if (["completed", "cancelled", "expired"].includes(current.status)) throw new Error("terminal assignments cannot be rescheduled");
    const timing = schedule(startAt, endAt, exclusive);
    if ((current.recurrence ?? "once") !== "once" && !timing.startAt) {
      throw new Error("daily and weekly assignments require a schedule");
    }
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
      const recurrence = assignment.recurrence ?? "once";
      if (recurrence !== "once") {
        const intervalMs = recurrence === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        let nextStart = Date.parse(assignment.startAt);
        let nextEnd = Date.parse(assignment.endAt);
        let advanced = 0;
        while (nextEnd <= cutoff.getTime()) {
          nextStart += intervalMs;
          nextEnd += intervalMs;
          advanced += 1;
        }
        const updated = {
          ...assignment,
          status: "assigned",
          startAt: new Date(nextStart).toISOString(),
          endAt: new Date(nextEnd).toISOString(),
          occurrence: (assignment.occurrence ?? 1) + advanced,
          updatedAt: stamp,
          history: [...assignment.history, {
            at: stamp,
            actor: "system",
            action: "recurrence_advanced",
            fromStatus: assignment.status,
            toStatus: "assigned",
            skippedOccurrences: advanced,
            recurrence,
          }],
        };
        assertNoOverlap(updated, assignment.id);
        expired.push(clone(updated));
        return updated;
      }
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

  return { list, get, create, setStatus, reassign, renamePrincipal, reschedule, expireDue };
}
