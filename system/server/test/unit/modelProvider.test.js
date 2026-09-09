import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValidStructuredDecision, assertProviderContract, FIXTURE_OBSERVATION } from "../../src/modelProvider.js";

const VALID = {
  screen_state: "instagram_reel",
  goal_progress: "candidate_found",
  action: "observe",
  target: "current_post",
  reason: "Strong hook",
  confidence: 0.9,
  candidate: { platform_content_id: "fixture-post-1", canonical_url: "https://example.com/fixture-post-1" },
};

test("assertValidStructuredDecision accepts a well-formed decision, including a null target", () => {
  assert.equal(assertValidStructuredDecision(VALID), VALID);
  assert.equal(assertValidStructuredDecision({ ...VALID, target: null }).target, null);
});

test("assertValidStructuredDecision rejects a non-object decision", () => {
  for (const bad of [null, undefined, "a string", 42, ["array"]]) {
    assert.throws(() => assertValidStructuredDecision(bad, "test-provider"), /non-object decision/);
  }
});

test("assertValidStructuredDecision rejects a decision missing any required string field", () => {
  for (const field of ["screen_state", "goal_progress", "action", "reason"]) {
    const decision = { ...VALID, [field]: undefined };
    assert.throws(() => assertValidStructuredDecision(decision, "test-provider"), new RegExp(field));
  }
  for (const field of ["screen_state", "goal_progress", "action", "reason"]) {
    assert.throws(() => assertValidStructuredDecision({ ...VALID, [field]: "  " }, "test-provider"), new RegExp(field));
  }
});

test("assertValidStructuredDecision rejects a non-string, non-null target", () => {
  assert.throws(() => assertValidStructuredDecision({ ...VALID, target: 5 }), /target/);
});

test("assertValidStructuredDecision rejects an out-of-range or non-numeric confidence", () => {
  for (const bad of [-0.1, 1.1, NaN, Infinity, "0.9", null, undefined]) {
    assert.throws(() => assertValidStructuredDecision({ ...VALID, confidence: bad }), /confidence/);
  }
  assert.equal(assertValidStructuredDecision({ ...VALID, confidence: 0 }).confidence, 0);
  assert.equal(assertValidStructuredDecision({ ...VALID, confidence: 1 }).confidence, 1);
});

test("candidate discoveries require a stable validated reference", () => {
  assert.throws(() => assertValidStructuredDecision({ ...VALID, candidate: undefined }), /requires candidate details/);
  assert.throws(() => assertValidStructuredDecision({ ...VALID, candidate: {} }), /platform_content_id or canonical_url/);
  assert.throws(() => assertValidStructuredDecision({ ...VALID,
    candidate: { canonical_url: "javascript:alert(1)" } }), /canonical_url/);
  assert.throws(() => assertValidStructuredDecision({ ...VALID,
    candidate: { platform_content_id: "post", score: 2 } }), /score/);
  assert.throws(() => assertValidStructuredDecision({ ...VALID, action: "scroll_next" }), /non-navigating/);
  const accepted = assertValidStructuredDecision({ ...VALID,
    candidate: { canonical_url: "https://example.com/post", tags: ["hook"] } });
  assert.equal(accepted.candidate.tags[0], "hook");
});

test("assertProviderContract passes for a well-behaved provider and surfaces the fixture observation it was called with", async () => {
  let received;
  const provider = {
    name: "fake",
    async observeAndPlan(observation) {
      received = observation;
      return VALID;
    },
  };
  await assertProviderContract(provider);
  assert.deepEqual(received, FIXTURE_OBSERVATION);
});

test("assertProviderContract rejects a provider missing a name or observeAndPlan", async () => {
  await assert.rejects(() => assertProviderContract({ observeAndPlan: async () => VALID }), /non-empty string .name/);
  await assert.rejects(() => assertProviderContract({ name: "fake" }), /must implement observeAndPlan/);
});

test("assertProviderContract rejects a provider that returns a malformed decision", async () => {
  const provider = { name: "fake", async observeAndPlan() { return { screen_state: "x" }; } };
  await assert.rejects(() => assertProviderContract(provider), /fake decision missing required string field/);
});
