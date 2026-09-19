// Generic MS8.4 platform-skill boundary. Platform-specific selectors and UI
// assumptions live behind this contract; the scheduler/model layers never
// branch on Instagram/Reddit/X details.

import { ACTIONS } from "./actionPolicy.js";

const ACTION_SET = new Set(ACTIONS);
const REQUIRED_METHODS = ["detectState", "availableActions", "execute", "verify", "recover"];

async function recoverSafely(skill, error, context, canExecute) {
  let mayRecover = false;
  try {
    mayRecover = typeof canExecute === "function" && canExecute();
  } catch {
    mayRecover = false;
  }
  if (!mayRecover) {
    return { recovery: null, recoveryError: "recovery skipped because AI input authorization is no longer active" };
  }
  try {
    return { recovery: await skill.recover(error, context), recoveryError: null };
  } catch (recoveryError) {
    return { recovery: null, recoveryError: recoveryError?.message || String(recoveryError) };
  }
}

export function assertPlatformSkill(skill) {
  if (!skill || typeof skill !== "object") throw new Error("platform skill must be an object");
  for (const field of ["name", "platform", "skillVersion", "appVersion"] ) {
    if (typeof skill[field] !== "string" || !skill[field].trim()) throw new Error(`platform skill requires a non-empty ${field}`);
  }
  if (!Array.isArray(skill.supportedActions) || !skill.supportedActions.length) {
    throw new Error("platform skill requires at least one supported action");
  }
  for (const action of skill.supportedActions) {
    if (!ACTION_SET.has(action)) throw new Error(`${skill.name} declares unknown action "${action}"`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof skill[method] !== "function") throw new Error(`${skill.name} must implement ${method}()`);
  }
  return skill;
}

export async function executeSkillAction({ skill, decision, observation, policyResult, observeAfter, canExecute, context = {} } = {}) {
  assertPlatformSkill(skill);
  if (policyResult?.outcome !== "ALLOWED" || policyResult.action !== decision?.action) {
    return { outcome: "BLOCKED", reason: policyResult?.reason || "action did not pass policy validation" };
  }
  if (!skill.supportedActions.includes(decision.action)) {
    return { outcome: "BLOCKED", reason: `${skill.name} does not support ${decision.action}` };
  }

  let state;
  try {
    state = await skill.detectState(observation);
    if (typeof state !== "string" || !state) throw new Error("detectState() returned no state");
    const available = await skill.availableActions(state, observation);
    if (!Array.isArray(available) || !available.every((action) => typeof action === "string")) {
      throw new Error("availableActions() must return an array of action names");
    }
    if (!available.every((action) => skill.supportedActions.includes(action))) {
      throw new Error("availableActions() returned an action the skill does not declare");
    }
    if (!available.includes(decision.action)) {
      return { outcome: "BLOCKED", state, reason: `${decision.action} is not available from state ${state}` };
    }

    // Recheck after every awaited planning/state step, immediately before the
    // first device action. A human takeover can revoke the lease while this
    // function is detecting state; a stale check at function entry is unsafe.
    if (typeof canExecute !== "function" || !canExecute()) {
      return { outcome: "BLOCKED", state, reason: "AI input lease is no longer active" };
    }
    // `reobserve` lets a multi-step action (a toggle, a comment) take a fresh look between its own presses.
    const execution = await skill.execute(decision, { ...context, state, observation, canExecute, reobserve: observeAfter });
    if (!canExecute()) return { outcome: "BLOCKED", reason: "AI input authorization was revoked during execution", execution };
    if (typeof observeAfter !== "function") throw new Error("observeAfter callback is required for verification");
    const observationAfter = await observeAfter();
    if (!canExecute()) return { outcome: "BLOCKED", reason: "AI input authorization was revoked during observation", execution };
    const verified = await skill.verify(decision, observationAfter,
      { ...context, state, execution, observationBefore: observation });
    if (!canExecute()) return { outcome: "BLOCKED", reason: "AI input authorization was revoked during verification", execution };
    if (verified?.outcome === "NEEDS_HUMAN") return { ...verified, state, execution, observationAfter };
    if (!verified) {
      const failure = new Error("action did not verify");
      const { recovery, recoveryError } = await recoverSafely(skill, failure,
        { ...context, state, decision, observationAfter }, canExecute);
      return { outcome: "FAILED_VERIFICATION", state, execution, observationAfter, recovery, recoveryError };
    }
    return { outcome: "VERIFIED", state, execution, observationAfter };
  } catch (error) {
    const { recovery, recoveryError } = await recoverSafely(skill, error,
      { ...context, state: state ?? null, decision, observation }, canExecute);
    return { outcome: "FAILED", state: state ?? null, error: error?.message || String(error), recovery, recoveryError };
  }
}

export async function assertPlatformSkillContract(skill) {
  assertPlatformSkill(skill);
  const observation = { source: "ui_tree", ui_tree: { screen: "fixture" } };
  const state = await skill.detectState(observation);
  const available = await skill.availableActions(state, observation);
  if (!Array.isArray(available)) throw new Error(`${skill.name} availableActions() must return an array`);
  if (!available.every((action) => skill.supportedActions.includes(action))) {
    throw new Error(`${skill.name} returned an action it does not declare as supported`);
  }
  return { state, available };
}
