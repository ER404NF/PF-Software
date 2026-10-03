import test from "node:test";
import assert from "node:assert/strict";
import { checkRedisHealth } from "../../../src/redis/health.js";

test("checkRedisHealth reports healthy without retaining transport details", async () => {
  const result = await checkRedisHealth({ ping: async () => "PONG" });
  assert.equal(result.healthy, true);
  assert.equal(typeof result.latencyMs, "number");
  assert.equal("error" in result, false);
});

test("checkRedisHealth reports a safe error kind without retaining endpoint details", async () => {
  const result = await checkRedisHealth({
    ping: async () => { throw new Error("redis://user:PRIVATE_PASSWORD@private-host:6379 refused"); },
  });
  assert.equal(result.healthy, false);
  assert.equal(result.errorKind, "Error");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PASSWORD|private-host/);
});

test("checkRedisHealth reports a bounded timeout kind", async () => {
  const result = await checkRedisHealth({ ping: () => new Promise(() => {}) }, { timeoutMs: 10 });
  assert.equal(result.healthy, false);
  assert.equal(result.errorKind, "HEALTH_CHECK_TIMEOUT");
});
