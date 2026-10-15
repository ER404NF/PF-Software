import test from "node:test";
import assert from "node:assert/strict";
import { createDatabaseStartupCoordinator } from "../../src/db/startupCoordinator.js";

test("database startup retries a temporary failure and shares one initialization", async () => {
  let queries = 0;
  let initialized = 0;
  const events = [];
  const coordinator = createDatabaseStartupCoordinator({
    pool: { async query() { queries += 1; if (queries < 3) throw Object.assign(new Error("private host"), { code: "ETIMEDOUT" }); } },
    initialize: async () => { initialized += 1; }, deadlineMs: 1_000, initialDelayMs: 1, maxDelayMs: 1,
    jitter: () => 0, log: code => events.push(code),
  });
  const first = coordinator.start();
  const second = coordinator.start();
  assert.equal(first, second);
  await first;
  assert.equal(queries, 3);
  assert.equal(initialized, 1);
  assert.equal(coordinator.status().status, "ready");
  assert.ok(events.includes("DATABASE_STARTUP_RETRY"));
  assert.equal(events.some(event => /private|ETIMEDOUT/.test(event)), false);
});

test("database startup deadline exhausts with a safe error", async () => {
  let clock = 0;
  const coordinator = createDatabaseStartupCoordinator({
    pool: { async query() { clock += 6; throw new Error("postgres://secret@private"); } },
    now: () => clock, deadlineMs: 10, initialDelayMs: 1, maxDelayMs: 1, jitter: () => 0,
    setTimeoutFn: fn => { queueMicrotask(fn); return 1; }, clearTimeoutFn() {}, log() {},
  });
  await assert.rejects(coordinator.start(), error => {
    assert.equal(error.code, "DATABASE_STARTUP_TIMEOUT");
    assert.equal(error.message.includes("private"), false);
    return true;
  });
  assert.equal(coordinator.status().status, "timeout");
});

test("database startup cancellation interrupts a pending retry", async () => {
  let scheduled;
  const coordinator = createDatabaseStartupCoordinator({
    pool: { async query() { throw new Error("offline"); } }, deadlineMs: 10_000,
    setTimeoutFn: fn => { scheduled = fn; return 7; }, clearTimeoutFn() {}, log() {},
  });
  const operation = coordinator.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof scheduled, "function");
  coordinator.cancel();
  await assert.rejects(operation, error => error.code === "DATABASE_STARTUP_CANCELLED");
  assert.equal(coordinator.status().status, "cancelled");
});
