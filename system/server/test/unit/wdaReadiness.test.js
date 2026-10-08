import { test } from "node:test";
import assert from "node:assert/strict";
import { WdaDevice } from "../../src/wdaDevice.js";

function response(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test("fresh WDA startup failures stay in STARTING without consuming the normal failure budget, then recover immediately", async () => {
  let now = 1_000;
  let ready = false;
  const device = new WdaDevice("wda-1", "Phone", {
    port: 8100, now: () => now, startupGraceMs: 120_000,
    fetchFn: async () => response({ value: { ready } }),
  });
  device.beginStartup();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    now += 10_000;
    assert.equal(await device.checkReadiness(), false);
  }
  assert.equal(device.readiness.state, "STARTING");
  assert.equal(device.readiness.consecutiveFailures, 0);
  assert.equal(device.readiness.lastError, null);
  ready = true;
  assert.equal(await device.checkReadiness(), true);
  assert.equal(device.readiness.state, "HEALTHY");
});

test("after startup grace expires the ordinary threshold and bounded recovery signal still apply", async () => {
  let now = 5_000;
  const device = new WdaDevice("wda-1", "Phone", {
    port: 8100, now: () => now, startupGraceMs: 1_000, readinessFailureThreshold: 2,
    fetchFn: async () => response({ ready: false }),
  });
  device.beginStartup();
  now += 1_001;
  assert.equal(await device.checkReadiness(), false);
  assert.equal(device.readiness.consecutiveFailures, 1);
  assert.equal(device.readiness.state, "SUSPECT");
  assert.equal(await device.checkReadiness(), false);
  assert.equal(device.readiness.state, "FAILED");
});

test("simultaneous readiness callers share one HTTP operation and count one failure", async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const device = new WdaDevice("wda-1", "Phone", {
    port: 8100, startupGraceMs: 0,
    fetchFn: async () => { calls += 1; await gate; return response({ ready: false }); },
  });
  const first = device.checkReadiness();
  const second = device.checkReadiness();
  release();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(calls, 1);
  assert.equal(device.readiness.consecutiveFailures, 1);
});

test("invalidation during an in-flight probe cannot restore stale health", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const device = new WdaDevice("wda-1", "Phone", {
    port: 8100, fetchFn: async () => { await gate; return response({ ready: true }); },
  });
  const pending = device.checkReadiness();
  device.invalidateReadiness("WDA");
  release();
  assert.equal(await pending, false);
  assert.equal(device.readiness.ready, false);
  assert.equal(device.componentHealth.wdaEndpoint, "RECOVERING");
});

test("readiness failures expose safe categories without raw transport text", async () => {
  const refused = Object.assign(new Error("connect 127.0.0.1:8100 secret"), { cause: { code: "ECONNREFUSED" } });
  const device = new WdaDevice("wda-1", "Phone", {
    port: 8100, startupGraceMs: 0, fetchFn: async () => { throw refused; },
  });
  await device.checkReadiness();
  assert.equal(device.readiness.lastFailureCategory, "connection_refused");
  assert.doesNotMatch(JSON.stringify(device.healthSnapshot()), /127\.0\.0\.1|secret/);
});

test("readiness classifies transport and WDA response failures for evidence-based recovery", async (t) => {
  const cases = [
    ["timeout", async () => { throw Object.assign(new Error("private timeout detail"), { name: "TimeoutError" }); }],
    ["connection_reset", async () => { throw Object.assign(new Error("private reset detail"), { cause: { code: "ECONNRESET" } }); }],
    ["http_non_2xx", async () => response({}, { status: 503 })],
    ["not_ready", async () => response({ value: { ready: false } })],
    ["invalid_response", async () => ({ ok: true, status: 200, async json() { throw new Error("private parse detail"); } })],
  ];
  for (const [category, fetchFn] of cases) {
    await t.test(category, async () => {
      const device = new WdaDevice(`wda-${category}`, "Phone", { port: 8100, startupGraceMs: 0, fetchFn });
      assert.equal(await device.checkReadiness(), false);
      assert.equal(device.readiness.lastFailureCategory, category);
      assert.doesNotMatch(JSON.stringify(device.healthSnapshot()), /private/);
    });
  }
});
