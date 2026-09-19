// Turns the MS13 optimizations on or off for a deployment, and assembles them around the
// existing model providers and platform skills. Everything here is opt-in, because the
// gains (see bench/) are measured against a simulated model and the accuracy claim needs
// a supervised run on a real device before a fleet relies on it.
//
//   PHONE_FARM_OPTIMIZATIONS   unset/off | on | comma list of: router, localPlanner, stateCache, pacing
//   PHONE_FARM_CHEAP_MODEL     name of a provider in models.config.json used for routine screens
//   PHONE_FARM_ESCALATE_BELOW  confidence under which a cheap answer is discarded (default 0.75)

import { withStateCache, StateCache } from "./optimization/stateCache.js";
import { LocalPlanner } from "./optimization/screenClassifier.js";
import { createModelRouter, RouterStats } from "./optimization/modelRouter.js";
import { AdaptivePacing } from "./optimization/adaptivePacing.js";

export const OPTIMIZATION_FEATURES = Object.freeze(["router", "localPlanner", "stateCache", "pacing"]);

export function parseOptimizationConfig(env = process.env) {
  const raw = String(env.PHONE_FARM_OPTIMIZATIONS ?? "").trim();
  const enabled = new Set();
  const lower = raw.toLowerCase();
  if (lower === "on" || lower === "all") OPTIMIZATION_FEATURES.forEach(name => enabled.add(name));
  else if (lower && lower !== "off" && lower !== "none") {
    // Names are matched case-insensitively so "statecache" and "stateCache" both work.
    for (const requested of raw.split(",").map(part => part.trim()).filter(Boolean)) {
      const name = OPTIMIZATION_FEATURES.find(feature => feature.toLowerCase() === requested.toLowerCase());
      if (!name) {
        throw new Error(`PHONE_FARM_OPTIMIZATIONS: unknown optimization "${requested}" (expected one of ${OPTIMIZATION_FEATURES.join(", ")}, or on/off)`);
      }
      enabled.add(name);
    }
  }
  const escalateBelow = env.PHONE_FARM_ESCALATE_BELOW === undefined ? 0.75 : Number(env.PHONE_FARM_ESCALATE_BELOW);
  if (!Number.isFinite(escalateBelow) || escalateBelow <= 0 || escalateBelow > 1) {
    throw new Error("PHONE_FARM_ESCALATE_BELOW must be a number above 0 and at most 1");
  }
  return {
    router: enabled.has("router"),
    localPlanner: enabled.has("localPlanner"),
    stateCache: enabled.has("stateCache"),
    pacing: enabled.has("pacing"),
    cheapModel: String(env.PHONE_FARM_CHEAP_MODEL ?? "").trim() || null,
    escalateBelow,
  };
}

export function createOptimizationRuntime({ config, getProvider, getPlatformSkill, warn = console.warn } = {}) {
  if (typeof getProvider !== "function" || typeof getPlatformSkill !== "function") {
    throw new TypeError("optimization runtime needs getProvider and getPlatformSkill");
  }
  const routing = config.router || config.localPlanner;
  const caches = new Map();   // platform -> StateCache
  const skills = new Map();   // platform -> skill (possibly wrapped)
  const routers = new Map();  // `${provider}|${platform}` -> router
  const stats = new RouterStats();
  let warnedCheap = false;

  function skillFor(platform) {
    if (!skills.has(platform)) {
      const base = getPlatformSkill(platform);
      if (base && config.stateCache) {
        const cache = new StateCache();
        caches.set(platform, cache);
        skills.set(platform, withStateCache(base, cache));
      } else {
        skills.set(platform, base ?? null);
      }
    }
    return skills.get(platform);
  }

  function cheapProvider() {
    if (!config.router || !config.cheapModel) return null;
    const provider = getProvider(config.cheapModel);
    if (!provider && !warnedCheap) {
      warnedCheap = true;
      warn(`PHONE_FARM_CHEAP_MODEL "${config.cheapModel}" is not in models.config.json; routing continues without a cheap tier`);
    }
    return provider ?? null;
  }

  return {
    config,
    skillFor,

    // The provider a task should use: the configured one, wrapped by the router when routing is on.
    providerFor(name, platform) {
      const strong = getProvider(name);
      if (!strong || !routing) return strong ?? null;
      const skill = skillFor(platform);
      if (!skill) return strong;
      const key = `${name}|${platform}`;
      if (!routers.has(key)) {
        routers.set(key, createModelRouter({
          strong, cheap: cheapProvider(), skill, stats,
          planner: config.localPlanner ? new LocalPlanner() : null,
          escalateBelow: config.escalateBelow,
        }));
      }
      return routers.get(key);
    },

    pacingFor() {
      return config.pacing ? new AdaptivePacing() : null;
    },

    describe() {
      const cache = { hits: 0, misses: 0 };
      for (const value of caches.values()) { cache.hits += value.hits; cache.misses += value.misses; }
      const lookups = cache.hits + cache.misses;
      return {
        enabled: OPTIMIZATION_FEATURES.filter(name => config[name]),
        cheapModel: config.router ? config.cheapModel : null,
        escalateBelow: config.escalateBelow,
        routing: { steps: stats.steps, byTier: { ...stats.byTier }, escalations: stats.escalations, costUsd: Math.round(stats.costUsd * 10000) / 10000 },
        stateCache: { ...cache, hitRate: lookups ? Math.round((cache.hits / lookups) * 1000) / 1000 : 0 },
      };
    },
  };
}
