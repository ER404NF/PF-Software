import test from "node:test";
import assert from "node:assert/strict";
import { registerHealthRoutes } from "../../src/routes/healthRoutes.js";

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function routes(options = {}) {
  const registered = new Map();
  registerHealthRoutes({
    app: { get(path, handler) { registered.set(path, handler); } },
    checkDatabaseHealth: async () => ({ healthy: true, latencyMs: 1 }),
    ...options,
  });
  return registered;
}

test("liveness reports only that the process can answer", () => {
  const res = responseRecorder();
  routes().get("/healthz")({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("readiness is ready without a configured authoritative database", async () => {
  const res = responseRecorder();
  await routes().get("/readyz")({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, checks: { database: { status: "not_required" } } });
});

test("readiness fails closed without exposing a database error", async () => {
  const secret = "postgres://user:password@private-db.example/phonefarm";
  const res = responseRecorder();
  await routes({
    databasePool: {},
    checkDatabaseHealth: async () => ({ healthy: false, latencyMs: 23, error: `connection failed for ${secret}` }),
  }).get("/readyz")({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, checks: { database: { status: "unavailable", latencyMs: 23 } } });
  assert.equal(JSON.stringify(res.body).includes(secret), false);
});

test("an unexpected readiness-check rejection is a bounded 503", async () => {
  const res = responseRecorder();
  await routes({
    databasePool: {},
    checkDatabaseHealth: async () => { throw new Error("secret database details"); },
  }).get("/readyz")({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, checks: { database: { status: "unavailable", latencyMs: null } } });
});
