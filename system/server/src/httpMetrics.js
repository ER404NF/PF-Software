const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const DEVICE_STATES = Object.freeze(["connected", "disconnected", "controllable", "uncontrollable"]);
const TASK_STATES = Object.freeze(["QUEUED", "RUNNING", "PAUSED", "SUCCEEDED", "PARTIAL", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCELLED", "NEEDS_HUMAN", "EXPIRED"]);
const INTERVENTION_CATEGORIES = Object.freeze(["challenge", "low_confidence", "approval", "comment_rejected", "unconfirmed_action", "lease_revoked", "other"]);
const AI_OUTCOMES = Object.freeze(["SUCCEEDED", "PARTIAL", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCELLED", "NEEDS_HUMAN", "EXPIRED", "IN_PROGRESS"]);
export const OPERATIONAL_METRIC_LABELS = Object.freeze({
  phone_farm_devices: Object.freeze({ state: DEVICE_STATES }),
  phone_farm_queue_tasks: Object.freeze({ state: TASK_STATES }),
  phone_farm_open_interventions: Object.freeze({ category: INTERVENTION_CATEGORIES }),
  phone_farm_ai_tasks: Object.freeze({ outcome: AI_OUTCOMES }),
  phone_farm_routed_devices: Object.freeze({}),
  phone_farm_protected_devices: Object.freeze({}),
});

function safeMethod(value) {
  return METHODS.has(value) ? value : "OTHER";
}

function statusClass(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : "unknown";
}

export function createHttpMetrics({ now = () => process.hrtime.bigint(), uptime = () => process.uptime(),
  stateProviders = {} } = {}) {
  const counters = new Map();
  let providers = { ...stateProviders };

  function setStateProviders(next) {
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new TypeError("metrics state providers must be an object");
    providers = { ...next };
  }

  function safeList(name) {
    try {
      const value = providers[name]?.();
      return Array.isArray(value) ? value.slice(0, 100_000) : [];
    } catch { return []; }
  }

  function stateLines() {
    const devices = safeList("devices");
    const deviceCounts = {
      connected: devices.filter(item => item?.connected === true).length,
      disconnected: devices.filter(item => item?.connected !== true).length,
      controllable: devices.filter(item => item?.controllable === true).length,
      uncontrollable: devices.filter(item => item?.controllable !== true).length,
    };
    const tasks = safeList("tasks");
    const interventions = safeList("interventions").filter(item => item?.state === "OPEN" || item?.state === "CLAIMED");
    const lines = [
      "# HELP phone_farm_devices Devices grouped by bounded connection and control state.",
      "# TYPE phone_farm_devices gauge",
      ...DEVICE_STATES.map(state => `phone_farm_devices{state="${state}"} ${deviceCounts[state]}`),
      "# HELP phone_farm_queue_tasks Durable queue tasks grouped by known state.",
      "# TYPE phone_farm_queue_tasks gauge",
      ...TASK_STATES.map(state => `phone_farm_queue_tasks{state="${state}"} ${tasks.filter(item => item?.state === state).length}`),
      "# HELP phone_farm_open_interventions Open interventions grouped by known category.",
      "# TYPE phone_farm_open_interventions gauge",
      ...INTERVENTION_CATEGORIES.map(category => `phone_farm_open_interventions{category="${category}"} ${interventions.filter(item => item?.kind === category).length}`),
      "# HELP phone_farm_routed_devices Devices with a routing configuration applied by the host.",
      "# TYPE phone_farm_routed_devices gauge",
      `phone_farm_routed_devices ${devices.filter(item => item?.routed === true).length}`,
      "# HELP phone_farm_protected_devices Devices with current device-originated routing verification.",
      "# TYPE phone_farm_protected_devices gauge",
      `phone_farm_protected_devices ${devices.filter(item => item?.protected === true).length}`,
      "# HELP phone_farm_ai_tasks AI tasks grouped by bounded outcome.",
      "# TYPE phone_farm_ai_tasks gauge",
      ...AI_OUTCOMES.map(outcome => `phone_farm_ai_tasks{outcome="${outcome}"} ${tasks.filter(item => item?.kind === "research"
        && (item.state === outcome || (outcome === "IN_PROGRESS" && ["QUEUED", "RUNNING", "PAUSED"].includes(item.state)))).length}`),
    ];
    return lines;
  }

  function middleware(req, res, next) {
    const started = now();
    let recorded = false;
    res.once("finish", () => {
      if (recorded) return;
      recorded = true;
      const method = safeMethod(req.method);
      const outcome = statusClass(res.statusCode);
      const key = `${method}:${outcome}`;
      const elapsedNs = now() - started;
      const elapsedSeconds = Number(elapsedNs > 0n ? elapsedNs : 0n) / 1e9;
      const current = counters.get(key) ?? { method, outcome, count: 0, durationSeconds: 0 };
      current.count += 1;
      current.durationSeconds += elapsedSeconds;
      counters.set(key, current);
    });
    next();
  }

  function render() {
    const lines = [
      "# HELP phone_farm_process_up Whether the Phone Farm process is serving metrics.",
      "# TYPE phone_farm_process_up gauge",
      "phone_farm_process_up 1",
      "# HELP phone_farm_process_uptime_seconds Process uptime in seconds.",
      "# TYPE phone_farm_process_uptime_seconds gauge",
      `phone_farm_process_uptime_seconds ${Math.max(0, Number(uptime()) || 0)}`,
      "# HELP phone_farm_http_requests_total HTTP responses grouped only by method and status class.",
      "# TYPE phone_farm_http_requests_total counter",
      "# HELP phone_farm_http_request_duration_seconds_sum Aggregate response duration grouped only by method and status class.",
      "# TYPE phone_farm_http_request_duration_seconds_sum counter",
      ...stateLines(),
    ];
    for (const entry of [...counters.values()].sort((a, b) => `${a.method}:${a.outcome}`.localeCompare(`${b.method}:${b.outcome}`))) {
      const labels = `method="${entry.method}",status_class="${entry.outcome}"`;
      lines.push(`phone_farm_http_requests_total{${labels}} ${entry.count}`);
      lines.push(`phone_farm_http_request_duration_seconds_sum{${labels}} ${entry.durationSeconds}`);
    }
    return `${lines.join("\n")}\n`;
  }

  return { middleware, render, setStateProviders };
}
