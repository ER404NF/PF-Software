import test from "node:test";
import assert from "node:assert/strict";
import { checkDatabaseHealth } from "../../../src/db/health.js";

test("checkDatabaseHealth reports healthy and releases the client on success", async () => {
  let released = false;
  const pool = { connect: async () => ({ query: async () => {}, release: () => { released = true; } }) };
  const result = await checkDatabaseHealth(pool);
  assert.equal(result.healthy, true);
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(released, true);
});

test("checkDatabaseHealth reports unhealthy and still releases the client when the query fails", async () => {
  let released = false;
  const pool = { connect: async () => ({ query: async () => { throw new Error("connection refused"); }, release: () => { released = true; } }) };
  const result = await checkDatabaseHealth(pool);
  assert.equal(result.healthy, false);
  assert.match(result.error, /connection refused/);
  assert.equal(released, true);
});

test("checkDatabaseHealth reports unhealthy when connect() itself fails", async () => {
  const pool = { connect: async () => { throw new Error("pool exhausted"); } };
  const result = await checkDatabaseHealth(pool);
  assert.equal(result.healthy, false);
  assert.match(result.error, /pool exhausted/);
});

test("checkDatabaseHealth times out a hanging query instead of waiting forever", async () => {
  let released = false;
  const pool = { connect: async () => ({
    query: () => new Promise(() => {}), // never resolves
    release: () => { released = true; },
  }) };
  const result = await checkDatabaseHealth(pool, { timeoutMs: 20 });
  assert.equal(result.healthy, false);
  assert.match(result.error, /timed out/);
  assert.equal(released, true);
});
