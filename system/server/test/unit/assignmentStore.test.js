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
