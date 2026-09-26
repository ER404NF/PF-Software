// M05: PostgreSQL-backed adapter satisfying the exact same assignment
// repository contract (persistence/assignmentRepository.js) as
// fileAssignmentRepository.js — same methods, same return shapes, same
// plain-Error messages, same recurrence/overlap-conflict semantics as the
// file-backed assignmentStore.js. Every row is scoped to the install's
// single default organization (see db/defaultOrganization.js and the owner
// decision it documents).

import crypto from "node:crypto";
import { advanceRecurringWindow, validTimeZone } from "../../zonedRecurrence.js";
import { assertAssignmentRepository } from "../../persistence/assignmentRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

const STATUSES = new Set(["assigned", "in_progress", "completed", "cancelled", "expired"]);
const RECURRENCES = new Set(["once", "daily", "weekly"]);
const TRANSITIONS = {
  assigned: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["completed", "cancelled"]),
  completed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};
const TERMINAL = new Set(["completed", "cancelled", "expired"]);

function validText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum;
}

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    instructions: row.instructions,
    assignee: row.assignee,
    createdBy: row.created_by,
    deviceId: row.device_id,
    accountId: row.account_id,
    startAt: iso(row.start_at),
    endAt: iso(row.end_at),
    exclusive: row.exclusive,
    recurrence: row.recurrence,
    timezone: row.timezone,
    occurrence: row.occurrence,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.last_completed_at !== null ? { lastCompletedAt: iso(row.last_completed_at) } : {}),
    history: row.history,
  };
}

// Same pure validation as the file store's own schedule() helper — not
// exported from assignmentStore.js, so replicated here rather than reaching
// into that module's internals.
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

export async function createPostgresAssignmentRepository(pool, { now = () => new Date(), id = () => crypto.randomUUID() } = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  function timestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("assignment clock returned an invalid date");
    return date;
  }

  // Mirrors assertNoOverlap() exactly: an active (non-terminal), exclusive,
  // time-bounded assignment for the same device or assignee whose window
  // intersects the candidate's.
  async function assertNoOverlap(client, candidate, excludedId = null) {
    if (!candidate.exclusive || !candidate.startAt) return;
    const result = await client.query(
      `SELECT id FROM automation.assignments
       WHERE organization_id = $1
         AND ($2::uuid IS NULL OR id != $2)
         AND status NOT IN ('completed', 'cancelled', 'expired')
         AND exclusive = true
         AND start_at IS NOT NULL AND end_at IS NOT NULL
         AND $3::timestamptz < end_at AND $4::timestamptz > start_at
         AND (($5::text IS NOT NULL AND device_id = $5) OR assignee = $6)
       LIMIT 1`,
      [organizationId, excludedId, candidate.startAt, candidate.endAt, candidate.deviceId ?? null, candidate.assignee],
    );
    if (result.rowCount > 0) throw new Error(`assignment overlaps active assignment ${result.rows[0].id}`);
  }

  return assertAssignmentRepository({
    async list() {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT * FROM automation.assignments WHERE organization_id = $1 ORDER BY updated_at DESC",
          [organizationId],
        );
        return result.rows.map(toAssignment);
      });
    },

    async get(assignmentId) {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT * FROM automation.assignments WHERE id = $1 AND organization_id = $2",
          [assignmentId, organizationId],
        );
        return toAssignment(result.rows[0]) ?? null;
      });
    },

    async create({ instructions, assignee, createdBy, deviceId = null, accountId = null,
      startAt = null, endAt = null, exclusive = true, recurrence = "once", timezone = "UTC" }) {
      if (!validText(instructions, 2_000)) throw new Error("instructions must be 1-2000 characters");
      if (!validText(assignee, 100) || !validText(createdBy, 100)) throw new Error("assignee and creator are required");
      if (deviceId !== null && !validText(deviceId, 200)) throw new Error("deviceId must be a non-empty string or null");
      if (accountId !== null && !validText(accountId, 200)) throw new Error("accountId must be a non-empty string or null");
      if (!RECURRENCES.has(recurrence)) throw new Error("recurrence must be once, daily, or weekly");
      if (recurrence !== "once" && !validTimeZone(timezone)) throw new Error("recurring assignment requires a valid IANA timezone");

      const at = timestamp();
      const timing = schedule(startAt, endAt, exclusive);
      if (recurrence !== "once" && !timing.startAt) throw new Error("daily and weekly assignments require a schedule");
      if (timing.endAt && Date.parse(timing.endAt) <= at.getTime()) throw new Error("assignment endAt must be in the future");

      const assignmentId = id();
      const history = [{ at: at.toISOString(), actor: createdBy.trim(), action: "created", toStatus: "assigned", assignee: assignee.trim() }];
      const candidate = { deviceId, assignee: assignee.trim(), startAt: timing.startAt, endAt: timing.endAt, exclusive: timing.exclusive };

      return withOrg(async (client) => {
        await assertNoOverlap(client, candidate);
        const result = await client.query(
          `INSERT INTO automation.assignments
             (id, organization_id, instructions, assignee, created_by, device_id, account_id, start_at, end_at,
              exclusive, recurrence, timezone, occurrence, status, created_at, updated_at, history)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, 'assigned', $13, $13, $14)
           RETURNING *`,
          [assignmentId, organizationId, instructions.trim(), assignee.trim(), createdBy.trim(), deviceId, accountId,
            timing.startAt, timing.endAt, timing.exclusive, recurrence, recurrence === "once" ? null : timezone,
            at, JSON.stringify(history)],
        );
        return toAssignment(result.rows[0]);
      });
    },

    async setStatus(assignmentId, status, actor) {
      if (!STATUSES.has(status)) throw new Error("invalid assignment status");
      if (!validText(actor, 100)) throw new Error("actor is required");
      return withOrg(async (client) => {
        const existing = await client.query("SELECT * FROM automation.assignments WHERE id = $1 AND organization_id = $2", [assignmentId, organizationId]);
        const current = existing.rows[0];
        if (!current) return null;
        if (current.status === status) return toAssignment(current);
        if (!TRANSITIONS[current.status].has(status)) throw new Error(`cannot move assignment from ${current.status} to ${status}`);

        const at = timestamp();
        if (status === "in_progress" && current.start_at && at.getTime() < current.start_at.getTime()) {
          throw new Error("cannot start assignment before startAt");
        }

        const recurrence = current.recurrence ?? "once";
        if (status === "completed" && recurrence !== "once") {
          const advancedWindow = advanceRecurringWindow({
            startAt: iso(current.start_at), endAt: iso(current.end_at), recurrence,
            timeZone: current.timezone || "UTC", after: at,
          });
          const historyEntry = { at: at.toISOString(), actor: actor.trim(), action: "recurrence_completed",
            fromStatus: current.status, toStatus: "assigned", completedOccurrence: current.occurrence ?? 1, recurrence };
          await assertNoOverlap(client, {
            deviceId: current.device_id, assignee: current.assignee,
            startAt: advancedWindow.startAt, endAt: advancedWindow.endAt, exclusive: current.exclusive,
          }, assignmentId);
          const result = await client.query(
            `UPDATE automation.assignments
             SET status = 'assigned', start_at = $2, end_at = $3, occurrence = $4, last_completed_at = $5,
                 updated_at = $5, history = history || $6::jsonb
             WHERE id = $1
             RETURNING *`,
            [assignmentId, advancedWindow.startAt, advancedWindow.endAt,
              (current.occurrence ?? 1) + advancedWindow.advanced, at, JSON.stringify([historyEntry])],
          );
          return toAssignment(result.rows[0]);
        }

        const historyEntry = { at: at.toISOString(), actor: actor.trim(), action: "status_changed", fromStatus: current.status, toStatus: status };
        const result = await client.query(
          `UPDATE automation.assignments SET status = $2, updated_at = $3, history = history || $4::jsonb WHERE id = $1 RETURNING *`,
          [assignmentId, status, at, JSON.stringify([historyEntry])],
        );
        return toAssignment(result.rows[0]);
      });
    },

    async reassign(assignmentId, assignee, actor) {
      if (!validText(assignee, 100) || !validText(actor, 100)) throw new Error("assignee and actor are required");
      return withOrg(async (client) => {
        const existing = await client.query("SELECT * FROM automation.assignments WHERE id = $1 AND organization_id = $2", [assignmentId, organizationId]);
        const current = existing.rows[0];
        if (!current) return null;
        if (TERMINAL.has(current.status)) throw new Error("terminal assignments cannot be reassigned");
        const trimmedAssignee = assignee.trim();
        if (current.assignee === trimmedAssignee) return toAssignment(current);

        const at = timestamp();
        const candidate = { deviceId: current.device_id, assignee: trimmedAssignee, startAt: iso(current.start_at), endAt: iso(current.end_at), exclusive: current.exclusive };
        await assertNoOverlap(client, candidate, assignmentId);
        const historyEntry = { at: at.toISOString(), actor: actor.trim(), action: "reassigned",
          fromAssignee: current.assignee, toAssignee: trimmedAssignee, fromStatus: current.status, toStatus: "assigned" };
        const result = await client.query(
          `UPDATE automation.assignments SET assignee = $2, status = 'assigned', updated_at = $3, history = history || $4::jsonb WHERE id = $1 RETURNING *`,
          [assignmentId, trimmedAssignee, at, JSON.stringify([historyEntry])],
        );
        return toAssignment(result.rows[0]);
      });
    },

    async renamePrincipal(previousUsername, username, actor) {
      if (!validText(previousUsername, 100) || !validText(username, 100) || !validText(actor, 100)) {
        throw new Error("previous username, username, and actor are required");
      }
      const previous = previousUsername.trim();
      const nextUsername = username.trim();
      return withOrg(async (client) => {
        const matches = await client.query(
          "SELECT * FROM automation.assignments WHERE organization_id = $1 AND (assignee = $2 OR created_by = $2)",
          [organizationId, previous],
        );
        const updated = [];
        for (const row of matches.rows) {
          const at = timestamp();
          const wasAssignee = row.assignee === previous;
          const wasCreator = row.created_by === previous;
          const historyEntry = { at: at.toISOString(), actor: actor.trim(), action: "principal_renamed", previousUsername: previous, username: nextUsername };
          const result = await client.query(
            `UPDATE automation.assignments
             SET assignee = CASE WHEN $2 THEN $4 ELSE assignee END,
                 created_by = CASE WHEN $3 THEN $4 ELSE created_by END,
                 updated_at = $5, history = history || $6::jsonb
             WHERE id = $1
             RETURNING *`,
            [row.id, wasAssignee, wasCreator, nextUsername, at, JSON.stringify([historyEntry])],
          );
          updated.push(toAssignment(result.rows[0]));
        }
        return updated;
      });
    },

    async reschedule(assignmentId, { startAt = null, endAt = null, exclusive = true }, actor) {
      if (!validText(actor, 100)) throw new Error("actor is required");
      return withOrg(async (client) => {
        const existing = await client.query("SELECT * FROM automation.assignments WHERE id = $1 AND organization_id = $2", [assignmentId, organizationId]);
        const current = existing.rows[0];
        if (!current) return null;
        if (TERMINAL.has(current.status)) throw new Error("terminal assignments cannot be rescheduled");

        const timing = schedule(startAt, endAt, exclusive);
        if ((current.recurrence ?? "once") !== "once" && !timing.startAt) {
          throw new Error("daily and weekly assignments require a schedule");
        }
        const at = timestamp();
        if (timing.endAt && Date.parse(timing.endAt) <= at.getTime()) throw new Error("assignment endAt must be in the future");
        if (current.status === "in_progress" && timing.startAt && Date.parse(timing.startAt) > at.getTime()) {
          throw new Error("an in-progress assignment cannot be rescheduled into the future");
        }

        const candidate = { deviceId: current.device_id, assignee: current.assignee, startAt: timing.startAt, endAt: timing.endAt, exclusive: timing.exclusive };
        await assertNoOverlap(client, candidate, assignmentId);
        const historyEntry = { at: at.toISOString(), actor: actor.trim(), action: "rescheduled",
          fromStartAt: iso(current.start_at), fromEndAt: iso(current.end_at), toStartAt: timing.startAt, toEndAt: timing.endAt, exclusive: timing.exclusive };
        const result = await client.query(
          `UPDATE automation.assignments
           SET start_at = $2, end_at = $3, exclusive = $4, updated_at = $5, history = history || $6::jsonb
           WHERE id = $1
           RETURNING *`,
          [assignmentId, timing.startAt, timing.endAt, timing.exclusive, at, JSON.stringify([historyEntry])],
        );
        return toAssignment(result.rows[0]);
      });
    },

    async expireDue(at = new Date()) {
      const cutoff = at instanceof Date ? at : new Date(at);
      if (!Number.isFinite(cutoff.getTime())) throw new Error("expiration cutoff must be a valid date");

      return withOrg(async (client) => {
        // The file store's assertNoOverlap() closes over its outer
        // `assignments` array, which is NOT reassigned until the whole
        // batch's commit() at the end of this tick — every overlap check
        // during one expireDue() call sees the same frozen pre-tick
        // snapshot, never an item this same tick already advanced. This
        // fetches that same frozen snapshot once and checks in-memory,
        // rather than re-querying the (mutating) table per row, which would
        // let an earlier row's UPDATE in this loop influence a later row's
        // overlap check within the same tick — a real behavioral difference
        // from the file store, not just a style choice.
        const snapshot = await client.query(
          `SELECT id, device_id, assignee, status, exclusive, start_at, end_at
           FROM automation.assignments WHERE organization_id = $1`,
          [organizationId],
        );
        function findOverlapInSnapshot(candidate, excludedId) {
          if (!candidate.exclusive || !candidate.startAt) return null;
          const start = Date.parse(candidate.startAt);
          const end = Date.parse(candidate.endAt);
          return snapshot.rows.find((existing) => existing.id !== excludedId
            && !["completed", "cancelled", "expired"].includes(existing.status)
            && existing.exclusive !== false && existing.start_at && existing.end_at
            && start < existing.end_at.getTime() && end > existing.start_at.getTime()
            && ((candidate.deviceId && candidate.deviceId === existing.device_id) || candidate.assignee === existing.assignee)) ?? null;
        }

        const due = await client.query(
          `SELECT * FROM automation.assignments
           WHERE organization_id = $1 AND status IN ('assigned', 'in_progress')
             AND end_at IS NOT NULL AND end_at <= $2`,
          [organizationId, cutoff],
        );
        const expired = [];
        for (const row of due.rows) {
          const recurrence = row.recurrence ?? "once";
          if (recurrence !== "once") {
            const advancedWindow = advanceRecurringWindow({
              startAt: iso(row.start_at), endAt: iso(row.end_at), recurrence, timeZone: row.timezone || "UTC", after: cutoff,
            });
            const historyEntry = { at: cutoff.toISOString(), actor: "system", action: "recurrence_advanced",
              fromStatus: row.status, toStatus: "assigned", skippedOccurrences: advancedWindow.advanced, recurrence };
            const conflict = findOverlapInSnapshot(
              { deviceId: row.device_id, assignee: row.assignee, startAt: advancedWindow.startAt, endAt: advancedWindow.endAt, exclusive: row.exclusive },
              row.id,
            );
            try {
              if (conflict) throw new Error(`assignment overlaps active assignment ${conflict.id}`);
              const result = await client.query(
                `UPDATE automation.assignments
                 SET status = 'assigned', start_at = $2, end_at = $3, occurrence = $4, updated_at = $5, history = history || $6::jsonb
                 WHERE id = $1
                 RETURNING *`,
                [row.id, advancedWindow.startAt, advancedWindow.endAt, (row.occurrence ?? 1) + advancedWindow.advanced, cutoff, JSON.stringify([historyEntry])],
              );
              expired.push(toAssignment(result.rows[0]));
            } catch (error) {
              // A collision with another active assignment must stay isolated
              // to this one assignment — matching the file store's own
              // per-item try/catch so one conflict doesn't block every other
              // due assignment's expiry/advance in this tick.
              const conflictEntry = { at: cutoff.toISOString(), actor: "system", action: "recurrence_conflict", recurrence, reason: error.message };
              const result = await client.query(
                `UPDATE automation.assignments SET updated_at = $2, history = history || $3::jsonb WHERE id = $1 RETURNING *`,
                [row.id, cutoff, JSON.stringify([conflictEntry])],
              );
              expired.push(toAssignment(result.rows[0]));
            }
            continue;
          }
          const historyEntry = { at: cutoff.toISOString(), actor: "system", action: "expired", fromStatus: row.status, toStatus: "expired" };
          const result = await client.query(
            `UPDATE automation.assignments SET status = 'expired', updated_at = $2, history = history || $3::jsonb WHERE id = $1 RETURNING *`,
            [row.id, cutoff, JSON.stringify([historyEntry])],
          );
          expired.push(toAssignment(result.rows[0]));
        }
        return expired;
      });
    },
  });
}
