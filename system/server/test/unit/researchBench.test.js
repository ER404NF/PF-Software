// The MS13 regression gate: optimizations may save cost and time, and must never cost
// accuracy. A deliberately bad optimization must FAIL this gate, otherwise the gate proves nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark, regressionViolations, ALL_OFF, ALL_ON, OPTIMIZATIONS } from "../../bench/researchBench.js";

const baselineFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../bench/baseline.json");

test("benchmark is deterministic", async () => {
  const first = await runBenchmark({ flags: ALL_ON, sessions: 4 });
  const second = await runBenchmark({ flags: ALL_ON, sessions: 4 });
  assert.deepEqual(first, second);
});

test("with every optimization off the pipeline completes every session (a meaningful baseline)", async () => {
  const off = await runBenchmark({ flags: ALL_OFF, sessions: 8 });
  assert.equal(off.successRate, 1);
  assert.equal(off.recall, 1);
  assert.equal(off.wrongActionsPerSession, 0);
});

test("all optimizations together: same accuracy, materially cheaper and faster", async () => {
  const off = await runBenchmark({ flags: ALL_OFF });
  const on = await runBenchmark({ flags: ALL_ON });
  assert.deepEqual(regressionViolations(off, on, { minCostSaving: 0.5, minLatencySaving: 0.3 }), []);
  assert.ok(on.strongCallsPerSession < off.strongCallsPerSession / 2, "strong-model calls at least halved");
  assert.equal(on.screenshotsPerSession, 0, "tree-first observation skips the screenshot");
  assert.ok(on.cacheHitRate > 0, "the state cache is actually used");
});

for (const name of OPTIMIZATIONS) {
  test(`ablation: ${name} alone never reduces success rate or accuracy, and never costs more`, async () => {
    const off = await runBenchmark({ flags: ALL_OFF });
    const only = await runBenchmark({ flags: { ...ALL_OFF, [name]: true } });
    assert.deepEqual(regressionViolations(off, only), []);
    assert.ok(only.costPerSessionUsd <= off.costPerSessionUsd + 1e-9);
    assert.ok(only.latencyPerSessionMs <= off.latencyPerSessionMs);
  });
}

test("the gate fails a bad optimization: a confidently-wrong cheap model is caught", async () => {
  const off = await runBenchmark({ flags: ALL_OFF });
  // Same optimizations, but the cheap tier now confidently skips relevant posts. The router's
  // job is to escalate on low confidence, so this simulates the failure it cannot see.
  const bad = await runBenchmark({ flags: ALL_ON, silentErrorRate: 1 });
  const problems = regressionViolations(off, bad);
  assert.ok(problems.length > 0, "a regression must be reported");
  assert.match(problems.join(" "), /success rate|recall|wrong actions/);
});

test("the gate also enforces required savings", () => {
  const baseline = { successRate: 1, recall: 1, wrongActionsPerSession: 0, costPerSessionUsd: 1, latencyPerSessionMs: 1000 };
  assert.deepEqual(regressionViolations(baseline, { ...baseline, costPerSessionUsd: 0.4, latencyPerSessionMs: 500 }, { minCostSaving: 0.5, minLatencySaving: 0.3 }), []);
  assert.match(regressionViolations(baseline, baseline, { minCostSaving: 0.5 }).join(), /cost saving/);
  assert.match(regressionViolations(baseline, { ...baseline, successRate: 0.9 }).join(), /success rate fell/);
  assert.match(regressionViolations(baseline, { ...baseline, wrongActionsPerSession: 0.1 }).join(), /wrong actions rose/);
});

test("the committed baseline still matches what the benchmark produces", async () => {
  const recorded = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  const off = await runBenchmark({ flags: ALL_OFF });
  const on = await runBenchmark({ flags: ALL_ON });
  // If this fails after an intentional change, run `npm run bench -- --update-baseline` and review the diff.
  assert.deepEqual(off, recorded.off);
  assert.deepEqual(on, recorded.on);
  assert.deepEqual(regressionViolations(recorded.off, on), []);
});
