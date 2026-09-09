import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPlatformSkill, assertPlatformSkillContract, executeSkillAction } from "../../src/platformSkill.js";

function fakeSkill(overrides = {}) {
  const calls = [];
  return {
    name: "fixture-skill", platform: "fixture", skillVersion: "1.0.0", appVersion: "fixture-1",
    supportedActions: ["observe", "scroll_next"], calls,
    async detectState(observation) { calls.push(["detect", observation]); return "feed"; },
    async availableActions(state) { calls.push(["available", state]); return ["observe", "scroll_next"]; },
    async execute(decision, context) { calls.push(["execute", decision, context]); return { sent: true }; },
    async verify(decision, after) { calls.push(["verify", decision, after]); return true; },
    async recover(error, context) { calls.push(["recover", error.message, context]); return { recovered: true }; },
    ...overrides,
  };
}
const decision = { action: "scroll_next", target: "feed" };
const allowed = { outcome: "ALLOWED", action: "scroll_next", reason: null };

test("platform-skill contract requires version metadata, known actions and every lifecycle method", async () => {
  assertPlatformSkill(fakeSkill());
  assert.deepEqual(await assertPlatformSkillContract(fakeSkill()), { state: "feed", available: ["observe", "scroll_next"] });
  assert.throws(() => assertPlatformSkill(fakeSkill({ appVersion: "" })), /appVersion/);
  assert.throws(() => assertPlatformSkill(fakeSkill({ supportedActions: ["magic"] })), /unknown action/);
  assert.throws(() => assertPlatformSkill(fakeSkill({ verify: null })), /verify/);
});

test("an allowed and available action executes once and verifies against a fresh observation", async () => {
  const skill = fakeSkill();
  const result = await executeSkillAction({ skill, decision, observation: { frame: 1 }, policyResult: allowed,
    observeAfter: async () => ({ frame: 2 }), canExecute: () => true, context: { deviceId: "mock-1" } });
  assert.equal(result.outcome, "VERIFIED");
  assert.deepEqual(skill.calls.map(([name]) => name), ["detect", "available", "execute", "verify"]);
  assert.equal(skill.calls[2][2].deviceId, "mock-1");
  assert.deepEqual(result.observationAfter, { frame: 2 });
});

test("policy and state availability both block execution before a device action", async () => {
  const policyBlocked = fakeSkill();
  assert.equal((await executeSkillAction({ skill: policyBlocked, decision, observation: {},
    policyResult: { outcome: "DENIED", action: "scroll_next", reason: "disabled" } })).outcome, "BLOCKED");
  assert.deepEqual(policyBlocked.calls, []);

  const stateBlocked = fakeSkill({ async availableActions() { return ["observe"]; } });
  const result = await executeSkillAction({ skill: stateBlocked, decision, observation: {}, policyResult: allowed, canExecute: () => true });
  assert.equal(result.outcome, "BLOCKED");
  assert.match(result.reason, /not available/);
  assert.equal(stateBlocked.calls.some(([name]) => name === "execute"), false);
});

test("failed verification invokes recovery and reports a non-success result", async () => {
  const skill = fakeSkill({ async verify(decisionArg, after) { this.calls.push(["verify", decisionArg, after]); return false; } });
  const result = await executeSkillAction({ skill, decision, observation: {}, policyResult: allowed, observeAfter: async () => ({ changed: false }), canExecute: () => true });
  assert.equal(result.outcome, "FAILED_VERIFICATION");
  assert.deepEqual(result.recovery, { recovered: true });
  assert.equal(skill.calls.at(-1)[0], "recover");
});

test("execution and post-observation failures invoke recovery instead of escaping silently", async () => {
  for (const args of [
    { skill: fakeSkill({ async execute() { throw new Error("device failed"); } }), observeAfter: async () => ({}) },
    { skill: fakeSkill(), observeAfter: async () => { throw new Error("observation failed"); } },
  ]) {
    const result = await executeSkillAction({ ...args, decision, observation: {}, policyResult: allowed, canExecute: () => true });
    assert.equal(result.outcome, "FAILED");
    assert.match(result.error, /failed/);
    assert.equal(args.skill.calls.at(-1)[0], "recover");
  }
});

test("a failed recovery is reported once without rejecting the worker action", async () => {
  let recoveryCalls = 0;
  const skill = fakeSkill({
    async execute() { throw new Error("device failed"); },
    async recover() { recoveryCalls += 1; throw new Error("recovery failed"); },
  });
  const result = await executeSkillAction({ skill, decision, observation: {}, policyResult: allowed,
    observeAfter: async () => ({}), canExecute: () => true });
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.error, "device failed");
  assert.equal(result.recovery, null);
  assert.equal(result.recoveryError, "recovery failed");
  assert.equal(recoveryCalls, 1);
});

test("recovery cannot touch the device after the AI lease is revoked", async () => {
  let lease = true;
  let recoveryCalls = 0;
  const skill = fakeSkill({
    async execute() { lease = false; throw new Error("interrupted action"); },
    async recover() { recoveryCalls += 1; return { recovered: true }; },
  });
  const result = await executeSkillAction({ skill, decision, observation: {}, policyResult: allowed,
    observeAfter: async () => ({}), canExecute: () => lease });
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.recovery, null);
  assert.match(result.recoveryError, /authorization is no longer active/);
  assert.equal(recoveryCalls, 0);
});

test("a lease revoked during state detection blocks execution at the last responsible moment", async () => {
  let lease = true;
  const skill = fakeSkill({ async availableActions(state) { this.calls.push(["available", state]); lease = false; return ["scroll_next"]; } });
  const result = await executeSkillAction({ skill, decision, observation: {}, policyResult: allowed,
    canExecute: () => lease, observeAfter: async () => ({}) });
  assert.equal(result.outcome, "BLOCKED");
  assert.match(result.reason, /lease/);
  assert.equal(skill.calls.some(([name]) => name === "execute"), false);
});

test("runtime undeclared actions and a missing lease guard fail before execution", async () => {
  const undeclared = fakeSkill({ async availableActions() { return ["scroll_next", "like"]; } });
  assert.equal((await executeSkillAction({ skill: undeclared, decision, observation: {}, policyResult: allowed, canExecute: () => true })).outcome, "FAILED");
  const noGuard = fakeSkill();
  const result = await executeSkillAction({ skill: noGuard, decision, observation: {}, policyResult: allowed, observeAfter: async () => ({}) });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(noGuard.calls.some(([name]) => name === "execute"), false);
});

test("a skill cannot advertise undeclared actions at runtime", async () => {
  const skill = fakeSkill({ async availableActions() { return ["like"]; } });
  await assert.rejects(() => assertPlatformSkillContract(skill), /does not declare/);
});
