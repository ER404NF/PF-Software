import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = relative => fs.readFileSync(path.join(repoRoot, relative), "utf8");

test("monitoring profile scrapes private metrics with a secret and no public port", () => {
  const compose = read("deploy/hub/docker-compose.yml");
  const prometheus = read("deploy/observability/prometheus.yml");
  assert.match(compose, /prometheus:\s*[\s\S]*profiles: \["monitoring"\]/);
  assert.match(compose, /image: prom\/prometheus:v3\.5\.5/);
  assert.match(compose, /metrics_token:\s*\n\s*environment: METRICS_BEARER_TOKEN/);
  assert.doesNotMatch(compose, /prometheus:[\s\S]*?ports:/);
  assert.match(prometheus, /credentials_file: \/run\/secrets\/metrics_token/);
  assert.match(prometheus, /targets: \["hub:4173"\]/);
});

test("bounded alert rules link to a secret-safe incident runbook", () => {
  const alerts = read("deploy/observability/phone-farm-alerts.yml");
  const runbook = read("docs/INCIDENT_RESPONSE.md");
  for (const name of ["PhoneFarmMetricsUnavailable", "PhoneFarmHighServerErrorRatio", "PhoneFarmProcessRestarted"]) {
    assert.match(alerts, new RegExp(`alert: ${name}`));
    assert.match(runbook, new RegExp(`## ${name}`));
  }
  assert.match(runbook, /Never paste session cookies, tokens, proxy credentials/);
  assert.match(runbook, /configuration files alone are insufficient/);
});

test("recording rules and the importable dashboard expose only bounded operational dimensions", () => {
  const alerts = read("deploy/observability/phone-farm-alerts.yml");
  const dashboard = JSON.parse(read("deploy/observability/phone-farm-dashboard.json"));
  for (const metric of [
    "phone_farm:http_requests:rate5m",
    "phone_farm:http_server_errors:ratio5m",
    "phone_farm:http_request_duration:average5m",
  ]) {
    assert.match(alerts, new RegExp(metric.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(dashboard.uid, "phone-farm-operations");
  assert.deepEqual(dashboard.panels.map(panel => panel.title), [
    "Hub scrape status", "Request rate", "Server error ratio", "Average response duration", "Process uptime",
    "Device control state", "Queue state", "Routing evidence", "Open interventions", "AI task outcomes",
  ]);
  const serialized = JSON.stringify(dashboard);
  for (const forbidden of ["username", "deviceId", "requestPath", "token", "screenshot"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
