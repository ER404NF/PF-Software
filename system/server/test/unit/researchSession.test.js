import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBudget, buildSessionReport, scoreCandidate, DEFAULT_SCORING_PROFILE, SESSION_OUTCOMES } from "../../src/researchSession.js";

const clock = (start = 1_000_000) => { let now = start; return { now: () => now, advance: ms => { now += ms; } }; };

// ---- scoring --------------------------------------------------------------------------

test("a candidate that matches the profile's keywords, is engaging and fresh scores high; an irrelevant stale one scores low", () => {
  const profile = { ...DEFAULT_SCORING_PROFILE, keywords: ["harbour", "sunrise", "boats"] };
  const good = scoreCandidate({ text_extract: "Sunrise over the harbour, boats returning", metrics: { likes: 8000, comments: 400, age_hours: 2 } }, profile);
  const poor = scoreCandidate({ text_extract: "My lunch today", metrics: { likes: 3, age_hours: 200 } }, profile);
  assert.ok(good.score > 0.8, `good was ${good.score}`);
  assert.ok(poor.score < 0.2, `poor was ${poor.score}`);
  assert.equal(good.keep, true);
  assert.equal(poor.keep, false);
  assert.deepEqual(Object.keys(good.parts).sort(), ["engagement", "recency", "relevance"], "the reasons are visible to a reviewer");
});

test("scores stay within 0..1 whatever the input, and weights can be re-balanced per profile", () => {
  const weird = scoreCandidate({ metrics: { likes: 1e12, comments: -5, age_hours: -100 } }, { keywords: [] });
  assert.ok(weird.score >= 0 && weird.score <= 1);
  const onlyRelevance = { weights: { relevance: 1, engagement: 0, recency: 0 }, keywords: ["harbour"] };
  assert.equal(scoreCandidate({ text_extract: "harbour", metrics: {} }, onlyRelevance).score, 1);
  assert.equal(scoreCandidate({ text_extract: "kitchen", metrics: { likes: 99999 } }, onlyRelevance).score, 0);
});

// ---- stop conditions ------------------------------------------------------------------

test("a session that reaches its candidate quota stops as SUCCEEDED", () => {
  const budget = new SessionBudget({ quota: { maxCandidates: 2 } });
  budget.recordStep({ action: "capture", candidate: { id: 1 }, keep: true });
  assert.equal(budget.check().stop, false);
  budget.recordStep({ action: "capture", candidate: { id: 2 }, keep: true });
  assert.deepEqual(budget.check(), { stop: true, outcome: SESSION_OUTCOMES.SUCCEEDED, reason: "candidate quota reached (2)" });
});

test("candidates that score too low do not count towards the quota", () => {
  const budget = new SessionBudget({ quota: { maxCandidates: 1 } });
  budget.recordStep({ candidate: { id: 1 }, keep: false });
  assert.equal(budget.check().stop, false);
});

test("cost, step and time ceilings stop the session as PARTIAL, with the reason", () => {
  const cost = new SessionBudget({ quota: { maxCostUsd: 1 } });
  cost.recordStep({ costUsd: 0.6 });
  cost.recordStep({ costUsd: 0.6 });
  assert.match(cost.check().reason, /cost budget/);
  assert.equal(cost.check().outcome, SESSION_OUTCOMES.PARTIAL);

  const steps = new SessionBudget({ quota: { maxSteps: 3 } });
  for (let index = 0; index < 3; index += 1) steps.recordStep({});
  assert.match(steps.check().reason, /step budget/);

  const time = clock();
  const timed = new SessionBudget({ quota: { maxMinutes: 10 }, now: time.now });
  timed.recordStep({});
  time.advance(9 * 60_000);
  assert.equal(timed.check().stop, false);
  time.advance(2 * 60_000);
  assert.equal(timed.check().outcome, SESSION_OUTCOMES.PARTIAL, "did some work, then ran out of time");

  const idle = new SessionBudget({ quota: { maxMinutes: 10 }, now: time.now });
  idle.start();
  time.advance(11 * 60_000);
  assert.equal(idle.check().outcome, SESSION_OUTCOMES.EXPIRED, "never got anything done");
});

test("repeated failures stop the session instead of hammering the phone; a success resets the count", () => {
  const budget = new SessionBudget({ quota: { maxConsecutiveFailures: 3 } });
  budget.recordStep({ ok: false, error: "app crashed" });
  budget.recordStep({ ok: false, error: "app crashed" });
  budget.recordStep({ ok: true });
  budget.recordStep({ ok: false, error: "model timeout" });
  budget.recordStep({ ok: false, error: "model timeout" });
  assert.equal(budget.check().stop, false);
  budget.recordStep({ ok: false, error: "model timeout" });
  assert.match(budget.check().reason, /3 failures in a row/);
});

test("a crash and restart does not hand the session a fresh budget", () => {
  const time = clock();
  const before = new SessionBudget({ quota: { maxSteps: 4 }, now: time.now });
  for (let index = 0; index < 3; index += 1) before.recordStep({ costUsd: 0.1, action: "scroll_next" });
  const checkpoints = [{ data: { recordType: "other" } }, { data: before.toCheckpoint() }];
  const after = SessionBudget.fromCheckpoints(checkpoints, { quota: { maxSteps: 4 }, now: time.now });
  assert.equal(after.state.steps, 3);
  assert.equal(after.state.costUsd, 0.3);
  after.recordStep({});
  assert.match(after.check().reason, /step budget/, "the fourth step is the last one it gets");
  assert.equal(SessionBudget.fromCheckpoints([]).state.steps, 0);
});

test("recovery events are recorded so the report can show what was survived", () => {
  const budget = new SessionBudget();
  budget.recordRecovery("app_restarted", "returned to the springboard");
  assert.equal(budget.state.recoveries[0].kind, "app_restarted");
});

// ---- report ---------------------------------------------------------------------------

test("the session report shows what was found, done, spent, how fast it went, and where humans were needed", () => {
  const time = clock();
  const budget = new SessionBudget({ quota: { maxCandidates: 2 }, now: time.now });
  budget.recordStep({ action: "capture", candidate: {}, keep: true, latencyMs: 400, costUsd: 0.02 });
  time.advance(60_000);
  budget.recordStep({ action: "platform_save", latencyMs: 900, costUsd: 0.03 });
  budget.recordStep({ action: "capture", candidate: {}, keep: true, latencyMs: 500, costUsd: 0.02 });
  budget.recordStep({ action: "scroll_next", ok: false, error: "swipe failed", latencyMs: 2000 });
  const run = { id: "run-1", platform: "instagram", outcome: "SUCCEEDED", candidates: [
    { id: "c1", canonical_url: "https://x/1", score: 0.9, selection_reason: "great", review_state: "pending", platform_actions: [{ action: "platform_save", status: "VERIFIED" }] },
    { id: "c2", canonical_url: "https://x/2", score: 0.5, platform_actions: [] },
  ] };
  const report = buildSessionReport({ run, task: { id: "t1" }, budget, now: () => 42,
    interventions: [{ kind: "challenge", reason: "captcha", state: "RESOLVED", createdAt: 5 }] });
  assert.equal(report.outcome, "SUCCEEDED");
  assert.equal(report.stoppedBecause, "candidate quota reached (2)");
  assert.equal(report.steps, 4);
  assert.equal(report.candidates.kept, 2);
  assert.equal(report.candidates.top[0].id, "c1", "best first");
  assert.deepEqual(report.actions.byType, { capture: 2, platform_save: 1, scroll_next: 1 });
  assert.deepEqual(report.actions.platformVisible, { "platform_save:VERIFIED": 1 });
  assert.equal(report.cost.totalUsd, 0.07);
  assert.equal(report.cost.perCandidateUsd, 0.035);
  assert.equal(report.latencyMs.p50, 500);
  assert.equal(report.latencyMs.p95, 2000);
  assert.equal(report.failures[0].error, "swipe failed");
  assert.equal(report.interventions[0].reason, "captcha");
  assert.equal(report.minutes, 1);
  assert.equal(report.generatedAt, 42);
});

test("a report for a session that has not done anything yet is still well-formed", () => {
  const report = buildSessionReport({ budget: new SessionBudget() });
  assert.equal(report.outcome, "RUNNING");
  assert.equal(report.cost.perCandidateUsd, null);
  assert.equal(report.latencyMs.p50, null);
});

test("recording a candidate found during a step does not count as an extra step", () => {
  const budget = new SessionBudget({ quota: { maxCandidates: 1 } });
  budget.recordStep({ action: "capture" });
  budget.recordCandidate({ keep: true });
  assert.equal(budget.state.steps, 1);
  assert.equal(budget.state.keptCandidates, 1);
  assert.equal(budget.check().outcome, SESSION_OUTCOMES.SUCCEEDED);
});
