import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstagramSkill } from "../../src/platformSkills/instagramSkill.js";
import { MockDevice } from "../../src/mockDevice.js";
import { StateCache, withStateCache, observationFingerprint } from "../../src/optimization/stateCache.js";
import { classifyScreen, LocalPlanner } from "../../src/optimization/screenClassifier.js";
import { createModelRouter } from "../../src/optimization/modelRouter.js";
import { AdaptivePacing } from "../../src/optimization/adaptivePacing.js";
import { ResearchIndex, tokenize } from "../../src/optimization/researchIndex.js";
import { analyzeInterventions } from "../../src/optimization/interventionAnalytics.js";
import { assertValidStructuredDecision } from "../../src/modelProvider.js";

const skill = () => createInstagramSkill({ appVersion: "test" });
const observe = async device => ({ source: "ui_tree", ui_tree: await device.getUiTree(), platform: "instagram" });

async function screens() {
  const device = new MockDevice("m", "M");
  const springboard = await observe(device);
  device.tap(70 / 375, 120 / 667);
  const feed = await observe(device);
  return { springboard, feed, device };
}

// ---- state cache ---------------------------------------------------------------------------

test("identical screens share one detection; any visible change is a fresh detection", async () => {
  const { springboard, feed } = await screens();
  let calls = 0;
  const base = skill();
  const original = base.detectState.bind(base);
  base.detectState = async observation => { calls += 1; return original(observation); };
  const cached = withStateCache(base);

  assert.equal(await cached.detectState(springboard), "springboard");
  assert.equal(await cached.detectState(structuredClone(springboard)), "springboard", "equal content, different object");
  assert.equal(await cached.detectState(feed), "feed");
  assert.equal(calls, 2);
  assert.equal(cached.stateCache.hits, 1);
  assert.equal(cached.stateCache.misses, 2);
  assert.equal(cached.stateCache.hitRate, 1 / 3);
  assert.notEqual(observationFingerprint(springboard), observationFingerprint(feed));
});

test("a challenge screen and a detection error are never served from cache", async () => {
  const challenge = { ui_tree: { screen: "app", elements: [{ type: "staticText", label: "Enter the verification code we sent" }] } };
  let calls = 0;
  const base = skill();
  const original = base.detectState.bind(base);
  base.detectState = async observation => { calls += 1; return original(observation); };
  const cached = withStateCache(base);
  assert.equal(await cached.detectState(challenge), "security_challenge");
  assert.equal(await cached.detectState(challenge), "security_challenge");
  assert.equal(calls, 2, "checked afresh every time");

  const broken = { ui_tree: {} };
  await assert.rejects(() => cached.detectState(broken));
  await assert.rejects(() => cached.detectState(broken));
  assert.equal(cached.stateCache.entries.size, 0);
});

test("the cache is bounded and evicts the least recently used entry", () => {
  const cache = new StateCache({ maxEntries: 2 });
  cache.set("a", "feed");
  cache.set("b", "post");
  cache.get("a");
  cache.set("c", "profile");
  assert.equal(cache.get("b"), undefined, "b was the least recently used");
  assert.equal(cache.get("a"), "feed");
  assert.equal(cache.entries.size, 2);
});

// ---- local classification and planning ---------------------------------------------------------

test("screens are classified locally from the accessibility tree", async () => {
  const { springboard, feed } = await screens();
  assert.deepEqual(await classifyScreen(springboard, skill()), { state: "springboard", known: true, challenge: false });
  assert.deepEqual(await classifyScreen(feed, skill()), { state: "feed", known: true, challenge: false });
  const unknown = await classifyScreen({ ui_tree: { screen: "app", elements: [{ type: "staticText", label: "Something new" }] } }, skill());
  assert.equal(unknown.known, false);
  assert.equal((await classifyScreen({ ui_tree: null }, skill())).known, false, "an unreadable screen is unknown, not an error");
  assert.equal((await classifyScreen({ ui_tree: { elements: [{ label: "Enter the verification code" }] } }, skill())).challenge, true);
});

test("the local planner handles only the two mechanical steps, and only when they are permitted", () => {
  const planner = new LocalPlanner();
  const springboard = { state: "springboard", known: true, challenge: false };
  const feed = { state: "feed", known: true, challenge: false };
  assert.equal(planner.plan({ screen: springboard, platform: "instagram", taskId: "t", permittedActions: ["open_feed"] }).action, "open_feed");
  assert.equal(planner.plan({ screen: springboard, platform: "instagram", taskId: "t", permittedActions: [] }), null, "not permitted: ask instead");
  assert.equal(planner.plan({ screen: feed, taskId: "t", permittedActions: ["scroll_next"] }), null, "nothing recorded yet: a judgement call");
  planner.remember("t", { candidate: { canonical_url: "https://x/1" } });
  assert.equal(planner.plan({ screen: feed, taskId: "t", permittedActions: ["scroll_next"] }).action, "scroll_next");
  assert.equal(planner.plan({ screen: feed, taskId: "t", permittedActions: [] }), null);
  assert.equal(planner.plan({ screen: { state: "security_challenge", known: true, challenge: true }, taskId: "t", permittedActions: ["scroll_next"] }), null, "never plans over a challenge");
  assert.equal(planner.plan({ screen: { state: "unknown", known: false, challenge: false }, taskId: "t", permittedActions: ["open_feed"] }), null);
  planner.forget("t");
  assert.equal(planner.plan({ screen: feed, taskId: "t", permittedActions: ["scroll_next"] }), null);
});

// ---- model routing ----------------------------------------------------------------------------------

function fakeProvider(name, cost, answer) {
  const provider = { name, costPerStepUsd: cost, calls: 0, async observeAndPlan(observation, context) { provider.calls += 1; return answer(observation, context); } };
  return provider;
}
const decision = (action, confidence = 0.95, extra = {}) => ({ screen_state: "feed", goal_progress: "working", action, target: null, reason: "r", confidence, ...extra });

test("routing: mechanical steps cost nothing, routine screens use the cheap model, anything else the strong one", async () => {
  const { springboard, feed } = await screens();
  const strong = fakeProvider("strong", 0.05, () => decision("scroll_next"));
  const cheap = fakeProvider("cheap", 0.005, () => decision("scroll_next", 0.9));
  const router = createModelRouter({ strong, cheap, skill: skill(), planner: new LocalPlanner() });
  const context = { taskId: "t", platform: "instagram", permittedActions: ["open_feed", "scroll_next", "observe"] };

  const first = await router.observeAndPlan(springboard, context);
  assert.deepEqual([first.action, first.usage.tier, first.usage.cost_usd], ["open_feed", "local", 0]);
  const second = await router.observeAndPlan(feed, context);
  assert.deepEqual([second.usage.tier, second.usage.cost_usd, cheap.calls, strong.calls], ["cheap", 0.005, 1, 0]);
  const hard = await router.observeAndPlan({ ui_tree: { elements: [{ label: "A screen nobody has seen" }] } }, context);
  assert.equal(hard.usage.tier, "strong");
  assert.equal(strong.calls, 1);
  assert.equal(router.stats.steps, 3);
  assert.equal(router.stats.costUsd.toFixed(3), "0.055");
  assertValidStructuredDecision(first, "router");
});

test("a cheap answer that is not confident is discarded and the strong model decides (quality is never traded away)", async () => {
  const { feed } = await screens();
  const strong = fakeProvider("strong", 0.05, () => decision("observe", 0.95, { candidate: { canonical_url: "https://x/1" } }));
  const cheap = fakeProvider("cheap", 0.005, () => decision("scroll_next", 0.4));
  const router = createModelRouter({ strong, cheap, skill: skill(), planner: new LocalPlanner() });
  const result = await router.observeAndPlan(feed, { taskId: "t", permittedActions: ["observe", "scroll_next"] });
  assert.equal(result.action, "observe", "the strong model's answer, not the cheap one's");
  assert.deepEqual([result.usage.tier, result.usage.escalated], ["strong", true]);
  assert.equal(result.usage.cost_usd, 0.055, "the wasted cheap attempt is still counted");
  assert.equal(router.stats.escalations, 1);
});

test("challenges, unknown screens and tasks that just failed always go to the strong model", async () => {
  const { feed } = await screens();
  const strong = fakeProvider("strong", 0.05, () => decision("observe"));
  const cheap = fakeProvider("cheap", 0.005, () => decision("scroll_next"));
  const router = createModelRouter({ strong, cheap, skill: skill(), planner: new LocalPlanner() });
  await router.observeAndPlan({ ui_tree: { elements: [{ label: "Enter the verification code" }] } }, { taskId: "t", permittedActions: [] });
  assert.equal(cheap.calls, 0);
  router.noteOutcome({ taskId: "t", ok: false });
  await router.observeAndPlan(feed, { taskId: "t", permittedActions: [] });
  assert.equal(cheap.calls, 0, "a struggling task is not given the cheap model");
  router.noteOutcome({ taskId: "t", ok: true });
  await router.observeAndPlan(feed, { taskId: "t", permittedActions: [] });
  assert.equal(cheap.calls, 1, "recovered: routine work goes back to the cheap tier");
  router.finish("t");
});

test("without a cheap model the router simply uses the strong one, and it insists on the pieces it needs", async () => {
  const { feed } = await screens();
  const strong = fakeProvider("strong", 0.05, () => decision("observe"));
  const router = createModelRouter({ strong, skill: skill() });
  assert.equal((await router.observeAndPlan(feed, {})).usage.tier, "strong");
  assert.throws(() => createModelRouter({ skill: skill() }), /strong provider/);
  assert.throws(() => createModelRouter({ strong }), /platform skill/);
});

// ---- pacing ----------------------------------------------------------------------------------------

test("pacing waits the base time while the screen changes, backs off while it is idle, and resets on change", () => {
  const pacing = new AdaptivePacing({ baseMs: 400, maxMs: 3000, settleMs: 300 });
  assert.equal(pacing.next("a"), 400);
  assert.equal(pacing.next("b"), 400);
  assert.equal(pacing.next("b"), 800);
  assert.equal(pacing.next("b"), 1600);
  assert.equal(pacing.next("b"), 3000, "capped");
  assert.equal(pacing.next("c"), 400, "something changed: back to full speed");
  assert.equal(pacing.next(null), 400, "an unreadable fingerprint never counts as idle");
  assert.equal(pacing.next(null), 400);
});

test("pacing never waits less than the app needs to finish drawing", () => {
  assert.throws(() => new AdaptivePacing({ baseMs: 100, settleMs: 300 }), /at least the settle time/);
});

// ---- search and near-duplicates -------------------------------------------------------------------------

const candidates = [
  { id: "c1", text_extract: "Sunrise over the harbour with fishing boats returning", tags: ["harbour", "sunrise"], source_handle: "@port" },
  { id: "c2", text_extract: "Sunrise over the harbour with the fishing boats returning home", tags: ["harbour"], source_handle: "@repost" },
  { id: "c3", text_extract: "Fresh pasta recipe with tomato and basil", tags: ["food"], source_handle: "@chef" },
  { id: "c4", text_extract: "Mountain hiking trail at dawn", tags: ["hiking"], source_handle: "@trail" },
];

test("search ranks the most relevant candidates first and ignores noise words", () => {
  const index = ResearchIndex.fromRuns([{ id: "run-1", candidates }]);
  assert.deepEqual(index.search("harbour sunrise").map(hit => hit.candidate.id).slice(0, 2).sort(), ["c1", "c2"]);
  assert.equal(index.search("recipe")[0].candidate.id, "c3");
  assert.deepEqual(index.search("the and of"), [], "only stop words");
  assert.deepEqual(index.search("nothingmatches"), []);
  assert.equal(index.search("harbour", { limit: 1 }).length, 1);
  assert.deepEqual(tokenize("The Harbour, and the #sunrise!"), ["harbour", "#sunrise"]);
});

test("near-duplicates are found across different links, but distinct content is not", () => {
  const index = ResearchIndex.fromRuns([{ id: "run-1", candidates }]);
  const matches = index.findNearDuplicates(candidates[0], { threshold: 0.5 });
  assert.deepEqual(matches.map(match => match.candidate.id), ["c2"]);
  assert.ok(matches[0].similarity > 0.5);
  assert.deepEqual(index.findNearDuplicates(candidates[2]), []);
});

test("an index built from one account's runs contains nothing from another", () => {
  const mine = ResearchIndex.fromRuns([{ id: "r", candidates: [candidates[0]] }]);
  const theirs = ResearchIndex.fromRuns([{ id: "r2", candidates: [candidates[2]] }]);
  assert.equal(mine.search("recipe").length, 0);
  assert.equal(theirs.search("harbour").length, 0);
  assert.equal(mine.size, 1);
});

// ---- intervention analytics ---------------------------------------------------------------------------------

test("intervention analytics: rate, speed, reasons, hot spots and what to look at first", () => {
  const at = hour => Date.UTC(2026, 8, 19, hour);
  const item = (id, kind, account, createdHour, extra = {}) => ({ id, kind, platform: "instagram", accountId: account, createdAt: at(createdHour), state: "OPEN", ...extra });
  const items = [
    item("1", "challenge", "a1", 9, { state: "RESOLVED", claimedAt: at(9) + 120_000, resolvedAt: at(9) + 600_000, resolvedBy: "va1" }),
    item("2", "challenge", "a1", 9, { state: "RESOLVED", claimedAt: at(9) + 60_000, resolvedAt: at(9) + 300_000, resolvedBy: "va1" }),
    item("3", "challenge", "a2", 14, { state: "RESOLVED", resolvedAt: at(14) + 10_000, resolvedBy: "system" }),
    item("4", "low_confidence", "a1", 9),
    item("5", "approval", "a3", 22),
  ];
  const report = analyzeInterventions(items, { steps: 250, now: at(23) });
  assert.equal(report.total, 5);
  assert.equal(report.open, 2);
  assert.equal(report.resolved, 3);
  assert.equal(report.autoResolved, 1);
  assert.equal(report.perHundredSteps, 2);
  assert.equal(report.medianSecondsToPickUp, 90);
  assert.equal(report.medianSecondsToResolve, 300);
  assert.deepEqual(report.topReasons[0], { kind: "challenge", count: 3 });
  assert.equal(report.byAccount.a1, 3);
  assert.equal(report.busiestHourUtc, 9);
  assert.equal(report.oldestOpenMinutes, 14 * 60);
  assert.ok(report.attention.some(text => /challenge is the most common reason/.test(text)));
  assert.ok(report.attention.some(text => /waiting/.test(text)));
});

test("analytics on nothing is well-formed", () => {
  const report = analyzeInterventions([]);
  assert.equal(report.total, 0);
  assert.equal(report.medianSecondsToResolve, null);
  assert.equal(report.busiestHourUtc, null);
  assert.deepEqual(report.attention, []);
});
