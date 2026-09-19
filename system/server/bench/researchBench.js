// Research-pipeline benchmark (roadmap MS13 testing gate): "a benchmark suite comparing
// latency/cost before and after each optimization, regression-gated so no optimization
// is allowed to reduce action success rate."
//
// WHAT THIS MEASURES, honestly: the decision pipeline. The real platform skill, the real
// mock phone's accessibility trees, and the real optimization modules (state cache, local
// planner, model router, adaptive pacing) run over a seeded feed of posts. What is MODELED
// (constants below, not measured): what a model call costs and how long it takes, what a
// screenshot adds, and how long a screen needs to settle. So the numbers say "the
// pipeline makes N% fewer/cheaper model calls for the same outcomes", not "a real
// session costs $X". Real vendor pricing and real-device latency need the supervised run.
//
// Deterministic: seeded PRNG, simulated clock, no network, no wall time.

import { MockDevice } from "../src/mockDevice.js";
import { createInstagramSkill } from "../src/platformSkills/instagramSkill.js";
import { withStateCache, StateCache, observationFingerprint } from "../src/optimization/stateCache.js";
import { LocalPlanner } from "../src/optimization/screenClassifier.js";
import { createModelRouter } from "../src/optimization/modelRouter.js";
import { AdaptivePacing } from "../src/optimization/adaptivePacing.js";

export const MODEL = Object.freeze({
  strong: { costUsd: 0.05, latencyMs: 1800 },
  cheap: { costUsd: 0.005, latencyMs: 600 },
  vision: { costUsd: 0.02, latencyMs: 400 },   // added when a screenshot is attached to the request
  treeParseMs: 25,                              // detecting the screen from an uncached tree
  settleMs: 300,                                // how long the app needs to finish drawing
  fixedStepDelayMs: 1000,                       // the unoptimized fixed wait between steps
});

export const OPTIMIZATIONS = Object.freeze(["localPlanner", "router", "stateCache", "adaptivePacing", "treeOnly"]);
export const ALL_OFF = Object.freeze(Object.fromEntries(OPTIMIZATIONS.map(name => [name, false])));
export const ALL_ON = Object.freeze(Object.fromEntries(OPTIMIZATIONS.map(name => [name, true])));

function prng(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

function makeWorld(seed, { posts = 12, relevantRate = 0.3 } = {}) {
  const random = prng(seed);
  return { posts: Array.from({ length: posts }, (_, index) => ({ url: `https://www.instagram.com/p/S${seed}P${index}/`, relevant: random() < relevantRate })), index: 0, captured: new Set() };
}

// The "model" answers from the world the way a capable one reads a screen. `silentErrorRate`
// builds a deliberately bad cheap model that confidently skips relevant posts, to prove the
// gate catches an optimization that costs accuracy.
function simulatedModel(kind, world, random, { silentErrorRate = 0 } = {}) {
  const spec = MODEL[kind];
  const model = {
    name: kind, costPerStepUsd: spec.costUsd, calls: 0,
    async observeAndPlan(observation) {
      model.calls += 1;
      const state = observation.__state;
      const current = world.posts[world.index];
      const base = { goal_progress: "working", target: null, reason: "bench", screen_state: state ?? "feed" };
      if (state === "springboard") return { ...base, action: "open_feed", target: "instagram", confidence: 0.99 };
      if (!current) return { ...base, goal_progress: "complete", action: "observe", confidence: kind === "cheap" ? 0.5 : 0.99 };
      if (current.relevant && !world.captured.has(current.url)) {
        if (kind === "cheap") {
          if (random() < silentErrorRate) return { ...base, action: "scroll_next", target: "feed", confidence: 0.95 }; // confident and wrong
          return { ...base, action: "scroll_next", target: "feed", confidence: 0.5 };                                 // honestly unsure
        }
        return { ...base, action: "observe", confidence: 0.99, candidate: { canonical_url: current.url, text_extract: "relevant post" } };
      }
      return { ...base, action: "scroll_next", target: "feed", confidence: kind === "cheap" ? 0.92 : 0.99 };
    },
  };
  return model;
}

async function runSession(seed, flags, options) {
  const random = prng(seed * 7919 + 13);
  const world = makeWorld(seed, options.world);
  const device = new MockDevice("bench", "Bench phone");
  const baseSkill = createInstagramSkill({ appVersion: "bench" });
  const cache = new StateCache();
  const skill = flags.stateCache ? withStateCache(baseSkill, cache) : baseSkill;
  const strong = simulatedModel("strong", world, random);
  const cheap = simulatedModel("cheap", world, random, options);
  const planner = flags.localPlanner ? new LocalPlanner() : null;
  const router = (flags.router || flags.localPlanner)
    ? createModelRouter({ strong, cheap: flags.router ? cheap : null, skill, planner }) : null;
  const pacing = flags.adaptivePacing ? new AdaptivePacing({ baseMs: 400, settleMs: MODEL.settleMs }) : null;
  const permittedActions = ["open_feed", "scroll_next", "observe"];

  const totals = { costUsd: 0, latencyMs: 0, modelCalls: 0, strongCalls: 0, screenshots: 0, steps: 0, wrongCaptures: 0, missed: 0, finished: false };
  let previousFingerprint = null;
  const maxSteps = world.posts.length * 3 + 10;

  for (let step = 0; step < maxSteps && !totals.finished; step += 1) {
    const delay = pacing ? pacing.next(previousFingerprint) : MODEL.fixedStepDelayMs;
    totals.latencyMs += delay;
    if (delay < MODEL.settleMs) throw new Error("bench: a step observed the screen before it settled");

    const tree = await device.getUiTree();
    // Each post has its own accessibility node, so the tree changes as the feed moves.
    const withPost = tree.screen === "app"
      ? { ...tree, elements: [...tree.elements, { type: "staticText", id: `post-${world.index}`, label: `post ${world.index}` }] } : tree;
    const observation = { source: "ui_tree", ui_tree: withPost, platform: "instagram" };
    previousFingerprint = observationFingerprint(observation);
    const state = await skill.detectState(observation);
    observation.__state = state;
    const hitBefore = cache.hits;
    if (!(flags.stateCache && cache.hits > hitBefore)) totals.latencyMs += MODEL.treeParseMs;
    if (!flags.treeOnly) { totals.screenshots += 1; totals.costUsd += MODEL.vision.costUsd; totals.latencyMs += MODEL.vision.latencyMs; }

    let decision;
    if (router) {
      decision = await router.observeAndPlan(observation, { taskId: `bench-${seed}`, platform: "instagram", permittedActions });
    } else {
      decision = await strong.observeAndPlan(observation);
      decision.usage = { cost_usd: MODEL.strong.costUsd, tier: "strong" };
    }
    const tier = decision.usage?.tier ?? "strong";
    totals.steps += 1;
    totals.costUsd += decision.usage?.cost_usd ?? 0;
    if (tier !== "local") totals.modelCalls += 1;
    if (tier === "strong") totals.strongCalls += 1;
    if (tier === "cheap") totals.latencyMs += MODEL.cheap.latencyMs;
    else if (tier === "strong") totals.latencyMs += MODEL.strong.latencyMs + (decision.usage?.escalated ? MODEL.cheap.latencyMs : 0);

    const current = world.posts[world.index];
    if (decision.goal_progress === "complete") { totals.finished = true; break; }
    if (decision.action === "open_feed") device.tap(70 / 375, 120 / 667);
    else if (decision.action === "observe" && decision.candidate) {
      if (current?.relevant && decision.candidate.canonical_url === current.url) world.captured.add(current.url);
      else totals.wrongCaptures += 1;
    } else if (decision.action === "scroll_next") {
      if (current?.relevant && !world.captured.has(current.url)) totals.missed += 1;
      world.index += 1;
      device.swipe("up");
    }
  }
  const relevant = world.posts.filter(post => post.relevant);
  totals.recall = relevant.length ? relevant.filter(post => world.captured.has(post.url)).length / relevant.length : 1;
  totals.success = totals.finished && totals.wrongCaptures === 0 && totals.missed === 0 && totals.recall === 1;
  totals.cacheHits = cache.hits;
  totals.cacheMisses = cache.misses;
  return totals;
}

export async function runBenchmark({ flags = ALL_OFF, sessions = 16, seed = 1, silentErrorRate = 0, world = {} } = {}) {
  const runs = [];
  for (let index = 0; index < sessions; index += 1) runs.push(await runSession(seed + index, { ...ALL_OFF, ...flags }, { silentErrorRate, world }));
  const sum = key => runs.reduce((total, run) => total + run[key], 0);
  const round = (value, places = 4) => Math.round(value * 10 ** places) / 10 ** places;
  const hits = sum("cacheHits");
  const lookups = hits + sum("cacheMisses");
  return {
    sessions,
    successRate: round(runs.filter(run => run.success).length / sessions),
    recall: round(sum("recall") / sessions),
    costPerSessionUsd: round(sum("costUsd") / sessions),
    latencyPerSessionMs: Math.round(sum("latencyMs") / sessions),
    modelCallsPerSession: round(sum("modelCalls") / sessions, 2),
    strongCallsPerSession: round(sum("strongCalls") / sessions, 2),
    screenshotsPerSession: round(sum("screenshots") / sessions, 2),
    stepsPerSession: round(sum("steps") / sessions, 2),
    wrongActionsPerSession: round((sum("wrongCaptures") + sum("missed")) / sessions, 3),
    cacheHitRate: lookups ? round(hits / lookups) : 0,
  };
}

// The gate. Returns the list of violations; empty means the optimization is allowed.
export function regressionViolations(baseline, candidate, { minCostSaving = 0, minLatencySaving = 0, tolerance = 1e-9 } = {}) {
  const problems = [];
  if (candidate.successRate + tolerance < baseline.successRate) problems.push(`success rate fell from ${baseline.successRate} to ${candidate.successRate}`);
  if (candidate.recall + tolerance < baseline.recall) problems.push(`recall fell from ${baseline.recall} to ${candidate.recall}`);
  if (candidate.wrongActionsPerSession > baseline.wrongActionsPerSession + tolerance) problems.push(`wrong actions rose from ${baseline.wrongActionsPerSession} to ${candidate.wrongActionsPerSession}`);
  const costSaving = 1 - candidate.costPerSessionUsd / baseline.costPerSessionUsd;
  const latencySaving = 1 - candidate.latencyPerSessionMs / baseline.latencyPerSessionMs;
  if (costSaving + tolerance < minCostSaving) problems.push(`cost saving ${(costSaving * 100).toFixed(1)}% is below the required ${(minCostSaving * 100).toFixed(0)}%`);
  if (latencySaving + tolerance < minLatencySaving) problems.push(`latency saving ${(latencySaving * 100).toFixed(1)}% is below the required ${(minLatencySaving * 100).toFixed(0)}%`);
  return problems;
}
