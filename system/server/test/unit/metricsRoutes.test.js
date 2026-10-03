import test from "node:test";
import assert from "node:assert/strict";
import { registerMetricsRoutes } from "../../src/routes/metricsRoutes.js";

function responseRecorder() {
  return {
    statusCode: 200, contentType: null, body: null, ended: false, headers: {},
    status(value) { this.statusCode = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

function route(bearerToken) {
  let handler;
  registerMetricsRoutes({
    app: { get(path, value) { assert.equal(path, "/metrics"); handler = value; } },
    httpMetrics: { render: () => "phone_farm_process_up 1\n" },
    bearerToken,
  });
  return handler;
}

test("metrics route emits the collector snapshot only for the configured bearer token", () => {
  const token = "environment-only-metrics-token-1234567890";
  const handler = route(token);
  const denied = responseRecorder();
  handler({ headers: { authorization: "Bearer wrong-token" } }, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.body, null);

  const res = responseRecorder();
  handler({ headers: { authorization: `Bearer ${token}` } }, res);
  assert.equal(res.contentType, "text/plain; version=0.0.4; charset=utf-8");
  assert.equal(res.body, "phone_farm_process_up 1\n");
});

test("metrics route is undiscoverable when no bearer token is configured", () => {
  const res = responseRecorder();
  route(null)({ headers: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.ended, true);
  assert.equal(res.body, null);
});

test("metrics configuration rejects weak or header-unsafe bearer tokens", () => {
  for (const bearerToken of ["short", "x".repeat(31), `safe-prefix\r\nInjected-value-${"x".repeat(32)}`, "x".repeat(513)]) {
    assert.throws(
      () => route(bearerToken),
      /METRICS_BEARER_TOKEN must contain 32-512 token-safe characters/,
    );
  }
});
