// Model routing by task difficulty (roadmap MS13.2). It has the same shape as any
// model provider (observeAndPlan), so the worker does not know it is there.
//
//   tier "local"   a mechanical next step (LocalPlanner): no model call at all
//   tier "cheap"   a routine screen the app is known to be on: a small, cheap model
//   tier "strong"  anything hard: unknown screens, challenges, recent failures
//
// The rule that keeps optimization from costing quality: the cheap tier is only ever
// trusted when it is confident. A cheap answer below `escalateBelow` is thrown away and
// the strong model decides instead, so a saving can only come from cases the cheap model
// was sure about. Every step reports which tier answered and what it cost.

import { classifyScreen } from "./screenClassifier.js";

export class RouterStats {
  constructor() {
    this.byTier = { local: 0, cheap: 0, strong: 0 };
    this.escalations = 0;
    this.costUsd = 0;
  }

  record(tier, costUsd, escalated) {
    this.byTier[tier] += 1;
    this.costUsd += costUsd;
    if (escalated) this.escalations += 1;
  }

  get steps() {
    return this.byTier.local + this.byTier.cheap + this.byTier.strong;
  }
}

export function createModelRouter({
  strong, cheap = null, skill, planner = null,
  costs = { cheap: 0.005, strong: 0.05 },
  escalateBelow = 0.75,
  stats = new RouterStats(),
} = {}) {
  if (!strong || typeof strong.observeAndPlan !== "function") throw new TypeError("a strong provider is required");
  if (!skill) throw new TypeError("a platform skill is required to classify screens");
  const recentFailures = new Map(); // taskId -> consecutive failed steps

  const costOf = provider => Number(provider?.costPerStepUsd ?? 0);
  const annotate = (decision, tier, cost, escalated) => {
    stats.record(tier, cost, escalated);
    return { ...decision, usage: { ...(decision.usage ?? {}), cost_usd: cost, tier, escalated } };
  };

  return {
    name: `router(${strong.name ?? "strong"}${cheap ? `+${cheap.name ?? "cheap"}` : ""})`,
    stats,

    async observeAndPlan(observation, context = {}) {
      const { taskId = null, platform = observation?.platform ?? null, permittedActions = [] } = context;
      const screen = await classifyScreen(observation, skill);

      const local = planner?.plan({ screen, platform, taskId, permittedActions });
      if (local) {
        planner.remember(taskId, local);
        return annotate(local, "local", 0, false);
      }

      const hard = !screen.known || screen.challenge || (recentFailures.get(taskId) ?? 0) > 0;
      if (cheap && !hard) {
        const attempt = await cheap.observeAndPlan(observation, context);
        const cheapCost = costOf(cheap) || costs.cheap;
        if (attempt.confidence >= escalateBelow) {
          planner?.remember(taskId, attempt);
          return annotate(attempt, "cheap", cheapCost, false);
        }
        const decision = await strong.observeAndPlan(observation, context); // not sure enough: a stronger model decides
        planner?.remember(taskId, decision);
        return annotate(decision, "strong", cheapCost + (costOf(strong) || costs.strong), true);
      }
      const decision = await strong.observeAndPlan(observation, context);
      planner?.remember(taskId, decision);
      return annotate(decision, "strong", costOf(strong) || costs.strong, false);
    },

    // Fed by the worker so a struggling task is sent to the strong model.
    noteOutcome({ taskId, ok }) {
      if (!taskId) return;
      recentFailures.set(taskId, ok ? 0 : (recentFailures.get(taskId) ?? 0) + 1);
    },

    finish(taskId) {
      recentFailures.delete(taskId);
      planner?.forget(taskId);
    },
  };
}
