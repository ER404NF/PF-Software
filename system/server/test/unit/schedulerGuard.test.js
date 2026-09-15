import { test } from "node:test";
import assert from "node:assert/strict";
import { createSchedulerGuard } from "../../src/schedulerGuard.js";

test("scheduler guard catches component failures and exposes degraded health", () => {
  const events = [];
  const errors = [];
  let assignmentsRan = 0;
  const guard = createSchedulerGuard({
    taskQueue: { tick() { throw new Error("injected queue failure"); } },
    expireAssignments() { assignmentsRan += 1; },
    auditLog: { logEvent(event) { events.push(event); } },
    logError(...args) { errors.push(args); },
  });
  const at = new Date("2026-09-15T10:00:00.000Z");
  assert.equal(guard.run(at), false);
  assert.equal(assignmentsRan, 1, "one failed component must not skip the other maintenance path");
  assert.deepEqual(guard.status(), {
    state: "degraded",
    lastSuccessAt: null,
    lastErrorAt: at.toISOString(),
    failedComponent: "task_queue",
  });
  assert.equal(events[0].type, "scheduler_persistence_failed");
  assert.equal(events[0].detail.component, "task_queue");
  assert.equal(errors.length, 1);
});

test("scheduler guard recovers health after a later successful tick", () => {
  let fail = true;
  const guard = createSchedulerGuard({
    taskQueue: { tick() { if (fail) throw new Error("temporary"); } },
    expireAssignments() {},
    logError() {},
  });
  guard.run(new Date("2026-09-15T10:00:00.000Z"));
  fail = false;
  const recoveredAt = new Date("2026-09-15T10:00:05.000Z");
  assert.equal(guard.run(recoveredAt), true);
  assert.equal(guard.status().state, "healthy");
  assert.equal(guard.status().lastSuccessAt, recoveredAt.toISOString());
  assert.equal(guard.status().lastErrorAt, "2026-09-15T10:00:00.000Z");
});
