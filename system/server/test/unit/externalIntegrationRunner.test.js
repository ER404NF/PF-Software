import test from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_TEST_EXIT,
  collectExternalIntegrationTests,
  runExternalIntegration,
} from "../../src/externalIntegrationRunner.js";

test("missing service configuration is distinct from an unavailable service", async () => {
  const missing = await runExternalIntegration({ kind: "postgres", env: {}, probe: async () => {}, run: () => 0 });
  assert.deepEqual(missing, { ok: false, category: "configuration_missing", exitCode: EXTERNAL_TEST_EXIT.CONFIGURATION_MISSING });

  const unavailable = await runExternalIntegration({
    kind: "redis",
    env: { TEST_REDIS_URL: "redis://fixture.invalid" },
    probe: async () => { throw new Error("private connection details"); },
    run: () => 0,
  });
  assert.deepEqual(unavailable, { ok: false, category: "service_unavailable", exitCode: EXTERNAL_TEST_EXIT.SERVICE_UNAVAILABLE });
  assert.doesNotMatch(JSON.stringify(unavailable), /fixture|private|connection/i);
});

test("a reachable service executes the complete intended subset and preserves test failure", async () => {
  const calls = [];
  const result = await runExternalIntegration({
    kind: "postgres",
    env: { TEST_DATABASE_URL: "postgres://fixture.invalid/private" },
    probe: async () => {},
    run: files => { calls.push(files); return 7; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, "test_failure");
  assert.equal(result.exitCode, EXTERNAL_TEST_EXIT.TEST_FAILURE);
  assert.ok(calls[0].length > 1);
  assert.equal(calls[0].every(file => file.endsWith(".test.js")), true);
});

test("the repository's external subsets are complete and never include unit fixtures", () => {
  const postgres = collectExternalIntegrationTests("postgres");
  const redis = collectExternalIntegrationTests("redis");
  assert.ok(postgres.some(file => file.endsWith("tenantIsolation.test.js")));
  assert.ok(postgres.some(file => file.endsWith("postgresConnectionLoss.test.js")));
  assert.deepEqual(redis.map(file => file.split(/[\\/]/).at(-1)), ["redisFoundation.test.js"]);
  assert.equal([...postgres, ...redis].some(file => file.includes(`${process.platform === "win32" ? "\\" : "/"}unit${process.platform === "win32" ? "\\" : "/"}`)), false);
});
