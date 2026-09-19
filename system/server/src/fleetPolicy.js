// Multi-device AI fleet policy (roadmap MS12.1/MS12.2): which queued research task may
// start on which device right now.
//
// It is a pure function of "what is running at this moment", read from the queue each
// time, so there is no separate slot bookkeeping to leak or drift: a task that finished,
// was cancelled or was taken over by a human simply stops counting.
//
//   account exclusivity   an account is never operated by two workers at once
//   device/account affinity   an account may be pinned to the device it is signed in on
//   workspace concurrency  at most N of a client's accounts are active at once
//   provider concurrency   at most N in-flight calls to one model provider
//   fleet cap              at most N AI workers in total (resource budget)
//   spend budget           model spend per rolling hour
//
// Non-research work (human control, other task kinds) is never held back by this policy.

export const FLEET_DENIALS = Object.freeze({
  ACCOUNT_BUSY: "account_busy",
  AFFINITY: "affinity",
  WORKSPACE_LIMIT: "workspace_limit",
  PROVIDER_LIMIT: "provider_limit",
  FLEET_LIMIT: "fleet_limit",
  BUDGET: "budget_exhausted",
});

const limitFor = (table, key, fallback) => {
  const value = table?.[key] ?? table?.default;
  return Number.isFinite(value) ? value : fallback;
};

export function createFleetPolicy({
  runningTasks,                 // () => tasks currently RUNNING (any kind)
  workspaceOf = () => null,     // accountId -> workspaceId
  providerOf = () => null,      // task -> provider id
  spentLastHourUsd = () => 0,
  config = {},
} = {}) {
  if (typeof runningTasks !== "function") throw new TypeError("runningTasks() is required");
  const settings = {
    maxWorkers: Infinity,
    perWorkspace: { default: Infinity },
    perProvider: { default: Infinity },
    affinity: {},                // accountId -> deviceId
    maxCostUsdPerHour: Infinity,
    ...config,
  };

  const researchOnly = tasks => tasks.filter(task => task?.kind === "research");

  function decide(task, deviceId) {
    if (task?.kind !== "research") return { allow: true };
    const accountId = task.accountSelector?.accountId ?? null;
    const workspaceId = accountId ? workspaceOf(accountId) : null;
    const running = researchOnly(runningTasks()).filter(other => other.id !== task.id);

    if (accountId && settings.affinity[accountId] && settings.affinity[accountId] !== deviceId) {
      return { allow: false, code: FLEET_DENIALS.AFFINITY, reason: `account ${accountId} is signed in on ${settings.affinity[accountId]}, not ${deviceId}` };
    }
    if (accountId && running.some(other => other.accountSelector?.accountId === accountId)) {
      return { allow: false, code: FLEET_DENIALS.ACCOUNT_BUSY, reason: `account ${accountId} already has a worker` };
    }
    if (workspaceId) {
      const limit = limitFor(settings.perWorkspace, workspaceId, Infinity);
      const active = running.filter(other => workspaceOf(other.accountSelector?.accountId) === workspaceId).length;
      if (active >= limit) return { allow: false, code: FLEET_DENIALS.WORKSPACE_LIMIT, reason: `workspace ${workspaceId} is at its limit of ${limit} concurrent workers` };
    }
    const provider = providerOf(task);
    if (provider) {
      const limit = limitFor(settings.perProvider, provider, Infinity);
      const active = running.filter(other => providerOf(other) === provider).length;
      if (active >= limit) return { allow: false, code: FLEET_DENIALS.PROVIDER_LIMIT, reason: `provider ${provider} is at its limit of ${limit} concurrent calls` };
    }
    if (running.length >= settings.maxWorkers) {
      return { allow: false, code: FLEET_DENIALS.FLEET_LIMIT, reason: `the fleet is at its limit of ${settings.maxWorkers} AI workers` };
    }
    if (spentLastHourUsd() >= settings.maxCostUsdPerHour) {
      return { allow: false, code: FLEET_DENIALS.BUDGET, reason: "the hourly model-spend budget is used up" };
    }
    return { allow: true };
  }

  return {
    decide,
    // The shape taskQueue's canDispatch(task, deviceId) expects.
    canDispatch: (task, deviceId) => decide(task, deviceId).allow,
    settings,
    // Centralised monitoring (MS12.3): what every AI worker is doing right now.
    snapshot() {
      const workers = researchOnly(runningTasks()).map(task => {
        const accountId = task.accountSelector?.accountId ?? null;
        return {
          taskId: task.id, deviceId: task.deviceSelector?.deviceId ?? null, accountId,
          workspaceId: accountId ? workspaceOf(accountId) : null, platform: task.accountSelector?.platform ?? null,
          provider: providerOf(task) ?? null, checkpoints: task.checkpoints?.length ?? 0, startedAt: task.startedAt ?? null,
        };
      });
      const byWorkspace = {};
      for (const worker of workers) if (worker.workspaceId) byWorkspace[worker.workspaceId] = (byWorkspace[worker.workspaceId] ?? 0) + 1;
      return {
        workers,
        activeWorkers: workers.length,
        byWorkspace,
        limits: { maxWorkers: Number.isFinite(settings.maxWorkers) ? settings.maxWorkers : null,
          maxCostUsdPerHour: Number.isFinite(settings.maxCostUsdPerHour) ? settings.maxCostUsdPerHour : null },
        spentLastHourUsd: Math.round(spentLastHourUsd() * 10000) / 10000,
      };
    },
  };
}

// Limits from the environment, plus account->device affinity from the research config.
export function fleetConfigFromEnv(env = process.env, accountDefinitions = new Map()) {
  const positive = name => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const config = {};
  if (positive("FLEET_MAX_WORKERS")) config.maxWorkers = positive("FLEET_MAX_WORKERS");
  if (positive("FLEET_WORKSPACE_LIMIT")) config.perWorkspace = { default: positive("FLEET_WORKSPACE_LIMIT") };
  if (positive("FLEET_PROVIDER_LIMIT")) config.perProvider = { default: positive("FLEET_PROVIDER_LIMIT") };
  if (positive("FLEET_MAX_COST_USD_PER_HOUR")) config.maxCostUsdPerHour = positive("FLEET_MAX_COST_USD_PER_HOUR");
  config.affinity = Object.fromEntries([...accountDefinitions].filter(([, definition]) => definition?.deviceId).map(([id, definition]) => [id, definition.deviceId]));
  return config;
}

// Rolling one-hour spend, fed by each finished step's cost.
export class SpendTracker {
  constructor({ now = () => Date.now(), windowMs = 3_600_000 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.entries = [];
  }

  add(costUsd) {
    if (Number(costUsd) > 0) this.entries.push({ at: this.now(), costUsd: Number(costUsd) });
  }

  totalUsd() {
    const cutoff = this.now() - this.windowMs;
    this.entries = this.entries.filter(entry => entry.at >= cutoff);
    return this.entries.reduce((sum, entry) => sum + entry.costUsd, 0);
  }
}
