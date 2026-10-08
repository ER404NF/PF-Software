import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnrollmentLock } from "../../src/networkEnrollmentLock.js";

function clock() {
  let time = 1_000_000;
  const timers = new Map();
  let next = 1;
  return {
    now: () => time,
    advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } },
    setTimeoutFn(fn, delay) { const id = next++; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeoutFn(id) { timers.delete(id); },
    timerCount: () => timers.size,
  };
}

test("an enrollment is held for its time, then expires on its own and tells everyone", () => {
  const c = clock();
  const expired = [];
  const lock = createEnrollmentLock({ ttlMs: 300_000, now: c.now, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn, onExpire: id => expired.push(id) });
  lock.start("phone-a", { operatorUsername: "ana", sessionId: "s1" });
  assert.equal(lock.has("phone-a"), true);
  assert.equal(lock.remainingMs("phone-a"), 300_000);
  c.advance(299_000);
  assert.equal(lock.has("phone-a"), true);
  assert.equal(lock.remainingMs("phone-a"), 1_000);
  c.advance(1_300);
  assert.deepEqual(expired, ["phone-a"], "the timer announced the expiry without anyone asking");
  assert.equal(lock.has("phone-a"), false);
  assert.equal(lock.active(), null);
});

test("only one enrollment is active at a time, and it can be found", () => {
  const c = clock();
  const lock = createEnrollmentLock({ now: c.now, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn });
  assert.equal(lock.active(), null);
  lock.start("phone-a", { operatorUsername: "ana", sessionId: "s1" });
  const active = lock.active();
  assert.equal(active.deviceId, "phone-a");
  assert.equal(active.entry.operatorUsername, "ana");
  assert.ok(active.remainingMs > 0);
});

test("tryStart reserves the slot atomically and only its owner can update or clear it", () => {
  const c = clock();
  const lock = createEnrollmentLock({ now: c.now, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn });
  const first = lock.tryStart("phone-a", { ready: false, sessionId: "s1" });
  assert.ok(first);
  assert.equal(lock.tryStart("phone-b", { ready: false, sessionId: "s2" }), null);
  assert.equal(lock.update("phone-a", {}, { ready: true }), null);
  assert.equal(lock.clear("phone-a", {}), false);
  assert.equal(lock.update("phone-a", first, { ready: true }).ready, true);
  assert.equal(lock.clear("phone-a", first), true);
  assert.ok(lock.tryStart("phone-b", { ready: false, sessionId: "s2" }));
});

test("cancel (clear) removes it and its timer; a new start replaces an old one", () => {
  const c = clock();
  const lock = createEnrollmentLock({ now: c.now, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn });
  lock.start("phone-a", { sessionId: "s1" });
  assert.equal(c.timerCount(), 1);
  assert.equal(lock.clear("phone-a"), true);
  assert.equal(c.timerCount(), 0);
  assert.equal(lock.clear("phone-a"), false);
  lock.start("phone-a", { sessionId: "s1" });
  lock.start("phone-a", { sessionId: "s2" });
  assert.equal(c.timerCount(), 1, "the old timer was cancelled");
  assert.equal(lock.get("phone-a").sessionId, "s2");
});

test("Confirm can tell an expired enrollment from one that never existed (once)", () => {
  const c = clock();
  const lock = createEnrollmentLock({ ttlMs: 1000, now: c.now, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn });
  assert.equal(lock.consumeExpired("phone-a"), false);
  lock.start("phone-a", {});
  c.advance(1_300);
  assert.equal(lock.consumeExpired("phone-a"), true);
  assert.equal(lock.consumeExpired("phone-a"), false, "only once");
  lock.start("phone-a", {});
  c.advance(1_300);
  lock.start("phone-a", {});
  assert.equal(lock.consumeExpired("phone-a"), false, "starting again forgets the old expiry");
});

test("pendingFor finds a pending enrollment by a rule (same operator and window, other phone)", () => {
  const c = clock();
  const lock = createEnrollmentLock({ now: c.now, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn });
  lock.start("phone-a", { operatorUsername: "ana", sessionId: "s1" });
  assert.equal(lock.pendingFor(entry => entry.sessionId === "s1")?.deviceId, "phone-a");
  assert.equal(lock.pendingFor(entry => entry.sessionId === "other"), null);
});

test("device generations fence stale enrollment and routing work", () => {
  const lock = createEnrollmentLock();
  const reservation = lock.tryStart("phone-1", { ready: false });
  const first = lock.advance("phone-1");
  assert.equal(lock.isCurrent("phone-1", first, reservation), true);

  const second = lock.advance("phone-1");
  assert.equal(second, first + 1);
  assert.equal(lock.isCurrent("phone-1", first, reservation), false);
  assert.equal(lock.isCurrent("phone-1", second, reservation), true);
  lock.clear("phone-1", reservation);
  assert.equal(lock.isCurrent("phone-1", second, reservation), false);
});
