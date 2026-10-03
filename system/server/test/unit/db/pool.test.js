import test from "node:test";
import assert from "node:assert/strict";
import { createPool, resolvePoolConfig, DatabaseConfigError } from "../../../src/db/pool.js";

test("resolvePoolConfig requires a connection string", () => {
  assert.throws(() => resolvePoolConfig({ connectionString: undefined }), DatabaseConfigError);
  assert.throws(() => resolvePoolConfig({ connectionString: "" }), DatabaseConfigError);
});

test("resolvePoolConfig rejects a non-positive pool size", () => {
  assert.throws(
    () => resolvePoolConfig({ connectionString: "postgres://x", max: 0 }),
    DatabaseConfigError,
  );
});

test("resolvePoolConfig applies documented defaults", () => {
  const config = resolvePoolConfig({ connectionString: "postgres://user:pass@localhost:5432/phonefarm" });
  assert.equal(config.connectionString, "postgres://user:pass@localhost:5432/phonefarm");
  assert.equal(config.max, 10);
  assert.equal(config.idleTimeoutMillis, 30_000);
  assert.equal(config.connectionTimeoutMillis, 5_000);
  assert.equal(config.statement_timeout, 30_000);
  assert.equal(config.ssl, undefined, "ssl is omitted, not forced, when unset");
});

test("resolvePoolConfig honors explicit overrides over env-derived defaults", () => {
  const config = resolvePoolConfig({ connectionString: "postgres://x", max: 3, idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 500, statementTimeoutMillis: 2000 });
  assert.equal(config.max, 3);
  assert.equal(config.idleTimeoutMillis, 1000);
  assert.equal(config.connectionTimeoutMillis, 500);
  assert.equal(config.statement_timeout, 2000);
});

test("resolvePoolConfig requires opt-in to disable TLS verification, never defaults to it", () => {
  const verified = resolvePoolConfig({ connectionString: "postgres://x", ssl: undefined });
  assert.equal(verified.ssl, undefined);
  const explicit = resolvePoolConfig({ connectionString: "postgres://x", ssl: { rejectUnauthorized: false } });
  assert.deepEqual(explicit.ssl, { rejectUnauthorized: false });
});

test("pool error listener does not log connection strings or private exception text", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.map(String).join(" "));
  const pool = createPool({ connectionString: "postgres://private:password@database/phonefarm" });
  try {
    const error = new Error("postgres://private:password@database/phonefarm was rejected");
    error.code = "ECONNRESET";
    pool.emit("error", error);
  } finally {
    console.error = originalError;
    await pool.end();
  }
  assert.deepEqual(errors, ["Unexpected PostgreSQL pool error on an idle client: ECONNRESET"]);
  assert.equal(errors.some(value => /private|password|database/.test(value)), false);
});
