import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthenticationThrottle, createRecoveryThrottle } from "../../src/recoveryThrottle.js";

test("recovery throttle limits normalized accounts without blocking unrelated accounts", () => {
  let timestamp = 1_000;
  const throttle = createRecoveryThrottle({ windowMs: 100, accountLimit: 2, ipLimit: 10, now: () => timestamp });
  assert.equal(throttle.allow({ identifier: " Person ", ip: "127.0.0.1" }), true);
  assert.equal(throttle.allow({ identifier: "person", ip: "127.0.0.1" }), true);
  assert.equal(throttle.allow({ identifier: "PERSON", ip: "127.0.0.2" }), false);
  assert.equal(throttle.allow({ identifier: "other", ip: "127.0.0.1" }), true);
  timestamp += 100;
  assert.equal(throttle.allow({ identifier: "person", ip: "127.0.0.1" }), true);
});

test("authentication attempt budget survives replacement login challenges", () => {
  let timestamp = 1_000;
  const throttle = createAuthenticationThrottle({ windowMs: 100, accountLimit: 2, ipLimit: 10, now: () => timestamp });
  assert.equal(throttle.blocked({ identifier: "worker", ip: "127.0.0.1" }), false);
  assert.equal(throttle.fail({ identifier: "worker", ip: "127.0.0.1" }), false);
  // A new cookie/session does not create a new throttle instance or key.
  assert.equal(throttle.fail({ identifier: "WORKER", ip: "127.0.0.2" }), true);
  assert.equal(throttle.blocked({ identifier: "worker", ip: "127.0.0.3" }), true);
  timestamp += 100;
  assert.equal(throttle.blocked({ identifier: "worker", ip: "127.0.0.3" }), false);
});

test("authentication throttle has a bounded global budget across accounts and source addresses", () => {
  const throttle = createAuthenticationThrottle({ accountLimit: 10, ipLimit: 10, globalLimit: 2 });
  assert.equal(throttle.fail({ identifier: "one", ip: "10.0.0.1" }), false);
  assert.equal(throttle.fail({ identifier: "two", ip: "10.0.0.2" }), true);
  assert.equal(throttle.blocked({ identifier: "three", ip: "10.0.0.3" }), true);
});

test("recovery throttle limits aggregate requests from one IP", () => {
  const throttle = createRecoveryThrottle({ windowMs: 100, accountLimit: 5, ipLimit: 2, now: () => 1_000 });
  assert.equal(throttle.allow({ identifier: "one", ip: "127.0.0.1" }), true);
  assert.equal(throttle.allow({ identifier: "two", ip: "127.0.0.1" }), true);
  assert.equal(throttle.allow({ identifier: "three", ip: "127.0.0.1" }), false);
});
