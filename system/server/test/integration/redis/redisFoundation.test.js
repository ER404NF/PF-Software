// Real-Redis test for the M06 foundation (client, health check, key
// schema). Skips without TEST_REDIS_URL — this is the only place any of
// this is actually run; no Redis is available in the environment that
// authored it.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRedisClient } from "../../../src/redis/client.js";
import { checkRedisHealth } from "../../../src/redis/health.js";
import { orgKey, assertBoundedPayload } from "../../../src/redis/keys.js";

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const skip = TEST_REDIS_URL
  ? false
  : "TEST_REDIS_URL is not set — this test only runs against a real Redis instance (see .github/workflows/redis-foundation.yml)";

test("Redis foundation (real Redis)", { skip }, async (t) => {
  const client = createRedisClient({ url: TEST_REDIS_URL });
  t.after(() => client.quit());

  await t.test("checkRedisHealth() reports healthy against a real server", async () => {
    const result = await checkRedisHealth(client);
    assert.equal(result.healthy, true);
    assert.equal(typeof result.latencyMs, "number");
  });

  await t.test("checkRedisHealth() reports unhealthy with a bounded wait against an unreachable host", async () => {
    const deadClient = createRedisClient({ url: "redis://127.0.0.1:1", connectTimeout: 200, maxRetriesPerRequest: 1 });
    t.after(() => deadClient.disconnect());
    const result = await checkRedisHealth(deadClient, { timeoutMs: 500 });
    assert.equal(result.healthy, false);
    assert.ok(result.error);
  });

  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();

  await t.test("orgKey() values round-trip through a real SET/GET with a TTL", async () => {
    const key = orgKey(orgA, "presence", "session-1");
    const value = JSON.stringify({ username: "va1", lastSeenAt: Date.now() });
    assertBoundedPayload(value);
    await client.set(key, value, "EX", 30);
    assert.equal(await client.get(key), value);
    const ttl = await client.ttl(key);
    assert.ok(ttl > 0 && ttl <= 30, "the key must carry a bounded TTL, not persist forever");
  });

  await t.test("keys for different organizations never collide", async () => {
    const keyA = orgKey(orgA, "presence", "session-shared-id");
    const keyB = orgKey(orgB, "presence", "session-shared-id");
    assert.notEqual(keyA, keyB);
    await client.set(keyA, "org-a-value", "EX", 30);
    await client.set(keyB, "org-b-value", "EX", 30);
    assert.equal(await client.get(keyA), "org-a-value");
    assert.equal(await client.get(keyB), "org-b-value");
  });

  t.after(async () => {
    // Best-effort cleanup — every key in this test already carries a 30s
    // TTL, so this is just tidiness for a shared CI database, not a
    // correctness concern.
    await client.del(orgKey(orgA, "presence", "session-1")).catch(() => {});
    await client.del(orgKey(orgA, "presence", "session-shared-id")).catch(() => {});
    await client.del(orgKey(orgB, "presence", "session-shared-id")).catch(() => {});
  });
});
