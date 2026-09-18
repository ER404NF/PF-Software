import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createAssignmentStore } from "../../src/assignmentStore.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignments-"));
  let tick = 0;
  const args = {
    storePath: path.join(root, "assignments.json"),
    now: () => new Date(Date.parse("2026-09-11T12:00:00.000Z") + tick++ * 1_000),
    id: () => "assignment-1",
  };
  return { root, args, store: createAssignmentStore(args) };
}

test("assignment lifecycle persists immutable actor history across restart", () => {
  const { root, args, store } = fixture();
  try {
    const created = store.create({ instructions: "Review today’s clips", assignee: "editor", createdBy: "manager", deviceId: "phone-1" });
    assert.equal(created.status, "assigned");
    store.setStatus(created.id, "in_progress", "editor");
    store.setStatus(created.id, "completed", "editor");
    const reloaded = createAssignmentStore(args).get(created.id);
    assert.equal(reloaded.status, "completed");
    assert.deepEqual(reloaded.history.map(entry => entry.action), ["created", "status_changed", "status_changed"]);
    assert.deepEqual(reloaded.history.map(entry => entry.actor), ["manager", "editor", "editor"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("reassignment records both assignees and resets active work to assigned", () => {
  const { root, store } = fixture();
  try {
    const assignment = store.create({ instructions: "Prepare export", assignee: "alice", createdBy: "manager" });
    store.setStatus(assignment.id, "in_progress", "alice");
    const moved = store.reassign(assignment.id, "bob", "manager");
    assert.equal(moved.assignee, "bob");
    assert.equal(moved.status, "assigned");
    assert.deepEqual(moved.history.at(-1), {
      at: "2026-09-11T12:00:02.000Z", actor: "manager", action: "reassigned",
      fromAssignee: "alice", toAssignee: "bob", fromStatus: "in_progress", toStatus: "assigned",
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("terminal assignments reject mutation and invalid input never persists", () => {
  const { root, store } = fixture();
  try {
    assert.throws(() => store.create({ instructions: "", assignee: "alice", createdBy: "manager" }), /instructions/);
    const assignment = store.create({ instructions: "One task", assignee: "alice", createdBy: "manager" });
    assert.throws(() => store.create({ instructions: "Duplicate", assignee: "alice", createdBy: "manager" }), /already exists/);
    store.setStatus(assignment.id, "cancelled", "manager");
    assert.throws(() => store.setStatus(assignment.id, "in_progress", "alice"), /cannot move/);
    assert.throws(() => store.reassign(assignment.id, "bob", "manager"), /terminal/);
    assert.equal(store.list().length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a failed durable write does not change live assignment state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-fail-"));
  const storePath = path.join(root, "store");
  const store = createAssignmentStore({ storePath });
  fs.mkdirSync(storePath);
  try {
    assert.throws(() => store.create({ instructions: "Task", assignee: "alice", createdBy: "manager" }));
    assert.deepEqual(store.list(), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("exclusive schedules reject overlapping phone or assignee time while allowing adjacent slots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-schedule-"));
  let sequence = 0;
  const store = createAssignmentStore({
    storePath: path.join(root, "assignments.json"),
    now: () => new Date("2026-09-11T10:00:00.000Z"),
    id: () => `scheduled-${++sequence}`,
  });
  try {
    store.create({
      instructions: "First slot", assignee: "alice", createdBy: "manager", deviceId: "phone-1",
      startAt: "2026-09-11T12:00:00.000Z", endAt: "2026-09-11T13:00:00.000Z",
    });
    assert.throws(() => store.create({
      instructions: "Same phone overlap", assignee: "bob", createdBy: "manager", deviceId: "phone-1",
      startAt: "2026-09-11T12:30:00.000Z", endAt: "2026-09-11T13:30:00.000Z",
    }), /overlaps active assignment scheduled-1/);
    assert.throws(() => store.create({
      instructions: "Same person overlap", assignee: "alice", createdBy: "manager", deviceId: "phone-2",
      startAt: "2026-09-11T12:15:00.000Z", endAt: "2026-09-11T12:45:00.000Z",
    }), /overlaps active assignment scheduled-1/);
    const adjacent = store.create({
      instructions: "Adjacent slot", assignee: "bob", createdBy: "manager", deviceId: "phone-1",
      startAt: "2026-09-11T13:00:00.000Z", endAt: "2026-09-11T14:00:00.000Z",
    });
    assert.equal(adjacent.startAt, "2026-09-11T13:00:00.000Z");
    assert.equal(adjacent.exclusive, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rescheduling is durable, audited in history, and leaves state unchanged on overlap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-reschedule-"));
  let sequence = 0;
  const storePath = path.join(root, "assignments.json");
  const options = {
    storePath,
    now: () => new Date("2026-09-11T10:00:00.000Z"),
    id: () => `rescheduled-${++sequence}`,
  };
  const store = createAssignmentStore(options);
  try {
    const first = store.create({
      instructions: "First", assignee: "alice", createdBy: "manager", deviceId: "phone-1",
      startAt: "2026-09-11T12:00:00.000Z", endAt: "2026-09-11T13:00:00.000Z",
    });
    const second = store.create({
      instructions: "Second", assignee: "bob", createdBy: "manager", deviceId: "phone-1",
      startAt: "2026-09-11T14:00:00.000Z", endAt: "2026-09-11T15:00:00.000Z",
    });
    assert.throws(() => store.reschedule(second.id, {
      startAt: "2026-09-11T12:30:00.000Z", endAt: "2026-09-11T13:30:00.000Z", exclusive: true,
    }, "manager"), /overlaps/);
    assert.equal(store.get(second.id).startAt, "2026-09-11T14:00:00.000Z");
    const moved = store.reschedule(first.id, {
      startAt: "2026-09-11T11:00:00.000Z", endAt: "2026-09-11T12:00:00.000Z", exclusive: false,
    }, "manager");
    assert.equal(moved.history.at(-1).action, "rescheduled");
    assert.equal(createAssignmentStore({ ...options, id: () => "unused" }).get(first.id).exclusive, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("expiration is idempotent, terminal, and records the system actor without touching the live lease", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-expire-"));
  const store = createAssignmentStore({
    storePath: path.join(root, "assignments.json"),
    now: () => new Date("2026-09-11T10:00:00.000Z"),
    id: () => "expiring-1",
  });
  try {
    const assignment = store.create({
      instructions: "Timed work", assignee: "alice", createdBy: "manager", deviceId: "phone-1",
      startAt: "2026-09-11T10:30:00.000Z", endAt: "2026-09-11T11:00:00.000Z",
    });
    assert.throws(() => store.setStatus(assignment.id, "in_progress", "alice"), /before startAt/);
    assert.deepEqual(store.expireDue("2026-09-11T10:59:59.000Z"), []);
    const expired = store.expireDue("2026-09-11T11:00:00.000Z");
    assert.equal(expired[0].status, "expired");
    assert.deepEqual(expired[0].history.at(-1), {
      at: "2026-09-11T11:00:00.000Z", actor: "system", action: "expired",
      fromStatus: "assigned", toStatus: "expired",
    });
    assert.deepEqual(store.expireDue("2026-09-11T12:00:00.000Z"), []);
    assert.throws(() => store.reassign(assignment.id, "bob", "manager"), /terminal/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("renamePrincipal updates durable assignee and creator references", () => {
  const { root, args, store } = fixture();
  try {
    store.create({ instructions: "Prepare clips", assignee: "old-name", createdBy: "old-name" });
    const changed = store.renamePrincipal("old-name", "new-name", "admin");
    assert.equal(changed.length, 1);
    assert.equal(changed[0].assignee, "new-name");
    assert.equal(changed[0].createdBy, "new-name");
    assert.equal(changed[0].history.at(-1).action, "principal_renamed");
    assert.equal(createAssignmentStore(args).list()[0].assignee, "new-name");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("daily and weekly assignments require schedules and persist their recurrence", () => {
  const { root, args, store } = fixture();
  try {
    assert.throws(() => store.create({
      instructions: "Daily check", assignee: "va", createdBy: "manager", recurrence: "daily",
    }), /require a schedule/);
    const weekly = store.create({
      instructions: "Weekly report", assignee: "va", createdBy: "manager", recurrence: "weekly",
      startAt: "2026-09-12T12:00:00.000Z", endAt: "2026-09-12T13:00:00.000Z",
    });
    assert.equal(weekly.recurrence, "weekly");
    assert.equal(weekly.occurrence, 1);
    assert.equal(createAssignmentStore(args).get(weekly.id).recurrence, "weekly");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("completing a recurring assignment records the occurrence and advances its schedule", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-recur-complete-"));
  let at = "2026-09-11T10:00:00.000Z";
  const store = createAssignmentStore({
    storePath: path.join(root, "assignments.json"), now: () => new Date(at), id: () => "daily-1",
  });
  try {
    const assignment = store.create({
      instructions: "Daily phone check", assignee: "va", createdBy: "manager", recurrence: "daily",
      startAt: "2026-09-11T11:00:00.000Z", endAt: "2026-09-11T12:00:00.000Z",
    });
    at = "2026-09-11T11:15:00.000Z";
    store.setStatus(assignment.id, "in_progress", "va");
    at = "2026-09-11T11:30:00.000Z";
    const next = store.setStatus(assignment.id, "completed", "va");
    assert.equal(next.status, "assigned");
    assert.equal(next.occurrence, 2);
    assert.equal(next.startAt, "2026-09-12T11:00:00.000Z");
    assert.equal(next.endAt, "2026-09-12T12:00:00.000Z");
    assert.equal(next.lastCompletedAt, at);
    assert.equal(next.history.at(-1).action, "recurrence_completed");
    assert.equal(next.history.at(-1).completedOccurrence, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("missed recurring windows advance to the next future occurrence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-recur-expire-"));
  const store = createAssignmentStore({
    storePath: path.join(root, "assignments.json"),
    now: () => new Date("2026-09-11T09:00:00.000Z"), id: () => "daily-1",
  });
  try {
    const assignment = store.create({
      instructions: "Daily phone check", assignee: "va", createdBy: "manager", recurrence: "daily",
      startAt: "2026-09-11T10:00:00.000Z", endAt: "2026-09-11T11:00:00.000Z",
    });
    const advanced = store.expireDue("2026-09-12T11:00:00.000Z");
    assert.equal(advanced[0].id, assignment.id);
    assert.equal(advanced[0].status, "assigned");
    assert.equal(advanced[0].occurrence, 3);
    assert.equal(advanced[0].startAt, "2026-09-13T10:00:00.000Z");
    assert.equal(advanced[0].history.at(-1).action, "recurrence_advanced");
    assert.equal(advanced[0].history.at(-1).skippedOccurrences, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a recurring assignment's overlap conflict does not wedge the rest of the expiry batch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-assignment-recur-conflict-"));
  let sequence = 0;
  const store = createAssignmentStore({
    storePath: path.join(root, "assignments.json"),
    now: () => new Date("2026-09-11T09:00:00.000Z"), id: () => `conflict-${++sequence}`,
  });
  try {
    const recurring = store.create({
      instructions: "Daily phone check", assignee: "va", createdBy: "manager", recurrence: "daily",
      startAt: "2026-09-11T10:00:00.000Z", endAt: "2026-09-11T11:00:00.000Z",
    });
    // Same assignee, overlapping tomorrow's 10:00-11:00 slot the recurring
    // assignment above is about to advance into — unrelated at creation
    // time (different day), it only collides once expireDue tries to move
    // the recurring assignment's window forward.
    store.create({
      instructions: "Conflicting one-off", assignee: "va", createdBy: "manager",
      startAt: "2026-09-12T10:30:00.000Z", endAt: "2026-09-12T10:45:00.000Z",
    });
    const unrelated = store.create({
      instructions: "Unrelated timed work", assignee: "someone-else", createdBy: "manager",
      startAt: "2026-09-11T10:00:00.000Z", endAt: "2026-09-11T10:30:00.000Z",
    });

    const results = store.expireDue("2026-09-11T12:00:00.000Z");

    // The unrelated assignment must still expire even though the recurring
    // one hit an unresolvable overlap in the same batch — this is the crux
    // of the original bug: the throw used to abort the whole .map() before
    // commit() ever ran, so nothing in the batch persisted, not just the
    // conflicting item.
    const expiredUnrelated = results.find(item => item.id === unrelated.id);
    assert.equal(expiredUnrelated.status, "expired");

    // The conflicting recurring assignment must not have silently advanced
    // into (or past) the slot it collides with — it stays exactly where it
    // was, with the conflict recorded, so an operator can reschedule it.
    const conflicted = results.find(item => item.id === recurring.id);
    assert.equal(conflicted.status, "assigned");
    assert.equal(conflicted.startAt, "2026-09-11T10:00:00.000Z");
    assert.equal(conflicted.endAt, "2026-09-11T11:00:00.000Z");
    assert.equal(conflicted.occurrence ?? 1, 1);
    assert.equal(conflicted.history.at(-1).action, "recurrence_conflict");
    assert.match(conflicted.history.at(-1).reason, /overlaps active assignment/);

    // And it must actually be persisted, not just returned in memory.
    const reloaded = createAssignmentStore({
      storePath: path.join(root, "assignments.json"), now: () => new Date(), id: () => "unused",
    });
    assert.equal(reloaded.get(unrelated.id).status, "expired");
    assert.equal(reloaded.get(recurring.id).status, "assigned");
    assert.equal(reloaded.get(recurring.id).history.at(-1).action, "recurrence_conflict");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
