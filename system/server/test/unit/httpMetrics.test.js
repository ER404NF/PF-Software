import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHttpMetrics, OPERATIONAL_METRIC_LABELS } from "../../src/httpMetrics.js";

function observe(metrics, { method, statusCode }, nextNow) {
  const req = { method, url: "/private/device?id=secret", body: { token: "secret" } };
  const res = new EventEmitter();
  res.statusCode = statusCode;
  metrics.middleware(req, res, () => {});
  nextNow();
  res.emit("finish");
}

test("HTTP metrics aggregate only method, status class, count, and duration", () => {
  let clock = 0n;
  const metrics = createHttpMetrics({ now: () => clock, uptime: () => 12.5 });
  observe(metrics, { method: "POST", statusCode: 201 }, () => { clock += 250_000_000n; });
  observe(metrics, { method: "POST", statusCode: 204 }, () => { clock += 500_000_000n; });
  observe(metrics, { method: "GET", statusCode: 403 }, () => { clock += 100_000_000n; });
  const output = metrics.render();
  assert.match(output, /phone_farm_process_up 1/);
  assert.match(output, /phone_farm_process_uptime_seconds 12\.5/);
  assert.match(output, /phone_farm_http_requests_total\{method="POST",status_class="2xx"\} 2/);
  assert.match(output, /phone_farm_http_request_duration_seconds_sum\{method="POST",status_class="2xx"\} 0\.75/);
  assert.match(output, /phone_farm_http_requests_total\{method="GET",status_class="4xx"\} 1/);
  assert.doesNotMatch(output, /private|secret|token|201|204|403/);
});

test("unknown methods and invalid statuses use bounded labels", () => {
  let clock = 0n;
  const metrics = createHttpMetrics({ now: () => clock });
  observe(metrics, { method: "ATTACK\nlabel", statusCode: 999 }, () => { clock += 1n; });
  const output = metrics.render();
  assert.match(output, /method="OTHER",status_class="unknown"/);
  assert.doesNotMatch(output, /ATTACK|999/);
});

test("operational metrics use only fixed low-cardinality labels and omit private fields", () => {
  const privateValue = "private-user-device-url-token";
  const metrics = createHttpMetrics({ stateProviders: {
    devices: () => [
      { connected: true, controllable: true, routed: true, protected: false, username: privateValue, deviceId: privateValue },
      { connected: false, controllable: false, routed: false, protected: false, error: privateValue },
    ],
    tasks: () => [
      { kind: "research", state: "SUCCEEDED", account: privateValue },
      { kind: "research", state: "ATTACK_LABEL", outcome: privateValue },
      { kind: "upload", state: "QUEUED", url: privateValue },
    ],
    interventions: () => [
      { state: "OPEN", kind: "challenge", reason: privateValue },
      { state: "OPEN", kind: "ATTACK_LABEL", reason: privateValue },
    ],
  } });
  const output = metrics.render();
  assert.match(output, /phone_farm_devices\{state="connected"\} 1/);
  assert.match(output, /phone_farm_devices\{state="controllable"\} 1/);
  assert.match(output, /phone_farm_queue_tasks\{state="QUEUED"\} 1/);
  assert.match(output, /phone_farm_open_interventions\{category="challenge"\} 1/);
  assert.match(output, /phone_farm_routed_devices 1/);
  assert.match(output, /phone_farm_protected_devices 0/);
  assert.match(output, /phone_farm_ai_tasks\{outcome="SUCCEEDED"\} 1/);
  assert.doesNotMatch(output, new RegExp(privateValue));
  assert.doesNotMatch(output, /ATTACK_LABEL|username|deviceId|account=|url=|error=|reason=/);
});

test("the exported label contract enumerates every allowed label and value", () => {
  assert.deepEqual(Object.keys(OPERATIONAL_METRIC_LABELS).sort(), [
    "phone_farm_ai_tasks", "phone_farm_devices", "phone_farm_open_interventions",
    "phone_farm_protected_devices", "phone_farm_queue_tasks", "phone_farm_routed_devices",
  ]);
  for (const [metric, labels] of Object.entries(OPERATIONAL_METRIC_LABELS)) {
    assert.ok(metric.startsWith("phone_farm_"));
    assert.equal(Object.keys(labels).every(label => ["state", "category", "outcome"].includes(label)), true);
    for (const values of Object.values(labels)) {
      assert.equal(values.every(value => /^[a-zA-Z_]+$/.test(value)), true);
    }
  }
});
