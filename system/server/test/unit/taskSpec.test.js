import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskSpec, isWindowOpen, hasWindowExpired, isTerminal, TASK_STATES } from "../../src/taskSpec.js";

test("createTaskSpec requires a non-empty goal", () => {
  assert.throws(() => createTaskSpec({}), /goal is required/);
  assert.throws(() => createTaskSpec({ goal: "   " }), /goal is required/);
});

test("createTaskSpec rejects an invalid priority", () => {
  assert.throws(() => createTaskSpec({ goal: "x", priority: "urgent!!" }), /invalid priority/);
});

test("createTaskSpec rejects a window where start is not before end", () => {
  assert.throws(
    () => createTaskSpec({ goal: "x", earliestStart: "2026-01-01T10:00:00Z", latestEnd: "2026-01-01T09:00:00Z" }),
    /earliestStart must be before latestEnd/
  );
});

test("createTaskSpec rejects invalid date-time fields instead of creating a stuck task", () => {
  assert.throws(() => createTaskSpec({ goal: "x", earliestStart: "not-a-date" }), /valid date-time/);
  assert.throws(() => createTaskSpec({ goal: "x", latestEnd: "not-a-date" }), /valid date-time/);
  assert.throws(() => createTaskSpec({ goal: "x", earliestStart: 123 }), /valid date-time/);
});

test("createTaskSpec defaults: no window -> QUEUED; a window -> SCHEDULED", () => {
  const noWindow = createTaskSpec({ goal: "x" });
  assert.equal(noWindow.state, TASK_STATES.QUEUED);

  const windowed = createTaskSpec({
    goal: "x",
    earliestStart: "2026-01-01T09:00:00Z",
    latestEnd: "2026-01-01T10:00:00Z",
  });
  assert.equal(windowed.state, TASK_STATES.SCHEDULED);
});

test("createTaskSpec assigns a unique id and sensible defaults", () => {
  const a = createTaskSpec({ goal: "x" });
  const b = createTaskSpec({ goal: "x" });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^task_/);
  assert.equal(a.retryCount, 0);
  assert.equal(a.retryNotBefore, null);
  assert.deepEqual(a.checkpoints, []);
  assert.equal(a.priority, "normal");
});

test("createTaskSpec rejects malformed retry policies", () => {
  assert.throws(() => createTaskSpec({ goal: "x", retryPolicy: null }), /retryPolicy must be an object/);
  assert.throws(() => createTaskSpec({ goal: "x", retryPolicy: { maxRetries: -1 } }), /maxRetries/);
  assert.throws(() => createTaskSpec({ goal: "x", retryPolicy: { maxRetries: 1.5 } }), /maxRetries/);
  assert.throws(() => createTaskSpec({ goal: "x", retryPolicy: { backoffMs: -1 } }), /backoffMs/);
  assert.throws(() => createTaskSpec({ goal: "x", retryPolicy: { backoffMs: "1000" } }), /backoffMs/);
});

test("task kinds distinguish research workers from generic queue work", () => {
  assert.equal(createTaskSpec({ goal: "generic" }).kind, "generic");
  assert.equal(createTaskSpec({ kind: "research", goal: "research" }).kind, "research");
  assert.throws(() => createTaskSpec({ kind: "unknown", goal: "bad" }), /invalid task kind/);
});

test("isWindowOpen: no window is always open", () => {
  assert.equal(isWindowOpen({}, new Date()), true);
});

test("isWindowOpen: before/inside/after a bounded window", () => {
  const task = { earliestStart: "2026-01-01T09:00:00Z", latestEnd: "2026-01-01T10:00:00Z" };
  assert.equal(isWindowOpen(task, new Date("2026-01-01T08:59:00Z")), false);
  assert.equal(isWindowOpen(task, new Date("2026-01-01T09:30:00Z")), true);
  assert.equal(isWindowOpen(task, new Date("2026-01-01T10:00:00Z")), false); // end is exclusive
  assert.equal(isWindowOpen(task, new Date("2026-01-01T10:01:00Z")), false);
});

test("hasWindowExpired requires a latestEnd", () => {
  assert.equal(hasWindowExpired({}, new Date()), false);
  assert.equal(hasWindowExpired({ latestEnd: "2026-01-01T10:00:00Z" }, new Date("2026-01-01T09:00:00Z")), false);
  assert.equal(hasWindowExpired({ latestEnd: "2026-01-01T10:00:00Z" }, new Date("2026-01-01T10:00:00Z")), true);
});

test("isTerminal classifies the five terminal states correctly", () => {
  for (const s of ["SUCCEEDED", "PARTIAL", "FAILED_FINAL", "CANCELLED", "EXPIRED"]) {
    assert.equal(isTerminal(s), true, s);
  }
  for (const s of ["DRAFT", "QUEUED", "SCHEDULED", "DISPATCHED", "RUNNING", "PAUSED", "NEEDS_HUMAN", "FAILED_RETRYABLE"]) {
    assert.equal(isTerminal(s), false, s);
  }
});
