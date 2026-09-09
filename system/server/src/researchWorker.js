// One bounded MS8 research-worker step. researchTaskRunner owns queue
// subscription and looping; this unit connects observation -> model -> policy
// -> skill while preserving the existing task/lease handoff path.

import { captureObservation } from "./observationPackage.js";
import { validateAction } from "./actionPolicy.js";
import { executeSkillAction } from "./platformSkill.js";
import { TASK_STATES } from "./taskSpec.js";

const CHALLENGE_STATES = new Set(["mfa", "captcha", "security_challenge", "account_recovery", "login_ambiguity"]);

export async function runResearchStep({
  task,
  device,
  accountId,
  workspaceId,
  provider,
  skill,
  accountWorkspaces,
  accountPolicies,
  taskQueue,
  deviceLease,
  auditLog,
  canAccessAccount,
  confidenceThreshold = 0.6,
} = {}) {
  if (!task || task.state !== TASK_STATES.RUNNING) throw new Error("research step requires a RUNNING task");
  if (!device || task.deviceSelector?.deviceId !== device.id) throw new Error("research step device does not match the dispatched task");
  if (!provider || typeof provider.observeAndPlan !== "function") throw new Error("research step requires a model provider");
  if (!taskQueue || !deviceLease) throw new Error("research step requires the task queue and device lease");
  if (typeof canAccessAccount !== "function") throw new Error("research step requires a live account authorization check");
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("confidenceThreshold must be between 0 and 1");
  }
  if (!deviceLease.canAiAct(device.id)) throw new Error("AI input lease is not active");
  if (!canAccessAccount()) throw new Error("research account authorization is not active");

  async function reportIfRunning(outcome, detail) {
    const current = taskQueue.getTask(task.id);
    if (current?.state !== TASK_STATES.RUNNING) return current?.state ?? null;
    await taskQueue.reportResult(task.id, outcome, { detail });
    return outcome;
  }

  let observation;
  let decision;
  try {
    observation = await captureObservation(device, {
      goal: task.goal,
      platform: task.accountSelector?.platform ?? skill?.platform ?? null,
      accountId,
      taskId: task.id,
    });
    decision = await provider.observeAndPlan(observation);
  } catch (error) {
    const outcome = await reportIfRunning(TASK_STATES.FAILED_RETRYABLE, error.message);
    return { outcome, error: error.message, observation: observation ?? null };
  }

  if (decision.confidence < confidenceThreshold || CHALLENGE_STATES.has(decision.screen_state)) {
    const detail = CHALLENGE_STATES.has(decision.screen_state)
      ? `security or account challenge: ${decision.screen_state}`
      : `model confidence ${decision.confidence} is below ${confidenceThreshold}`;
    const outcome = await reportIfRunning(TASK_STATES.NEEDS_HUMAN, detail);
    auditLog?.logEvent({ type: "research_needs_human", deviceId: device.id,
      operator: task.createdBy, detail: { taskId: task.id, accountId, workspaceId, reason: detail } });
    return { outcome, decision, observation, detail };
  }

  const policyResult = validateAction({ decision, workspaceId, accountId, accountWorkspaces, accountPolicies,
    allowedActions: task.allowedActions });
  if (policyResult.outcome === "REQUIRES_APPROVAL") {
    const detail = `${decision.action} requires explicit approval`;
    const outcome = await reportIfRunning(TASK_STATES.NEEDS_HUMAN, detail);
    return { outcome, decision, observation, policyResult, detail };
  }
  if (policyResult.outcome !== "ALLOWED") {
    const outcome = await reportIfRunning(TASK_STATES.FAILED_FINAL, policyResult.reason);
    return { outcome, decision, observation, policyResult };
  }
  if (!canAccessAccount()) {
    const detail = "research account authorization was revoked before execution";
    const outcome = await reportIfRunning(TASK_STATES.FAILED_FINAL, detail);
    return { outcome, decision, observation, policyResult, detail };
  }

  const actionPromise = executeSkillAction({
    skill,
    decision,
    observation,
    policyResult,
    canExecute: () => deviceLease.canAiAct(device.id) && canAccessAccount(),
    observeAfter: () => captureObservation(device, {
      goal: task.goal,
      platform: task.accountSelector?.platform ?? skill.platform,
      accountId,
      taskId: task.id,
    }),
    context: { device, deviceId: device.id, taskId: task.id, accountId, workspaceId },
  });
  deviceLease.registerPendingAiAction(device.id, actionPromise);
  let result;
  try {
    result = await actionPromise;
  } catch (error) {
    const message = error?.message || String(error);
    const outcome = await reportIfRunning(TASK_STATES.FAILED_RETRYABLE, message);
    return { outcome, error: message, decision, observation, policyResult };
  } finally {
    deviceLease.clearPendingAiAction?.(device.id, actionPromise);
  }
  if (result.outcome === "VERIFIED") {
    const current = taskQueue.getTask(task.id);
    if (current?.state !== TASK_STATES.RUNNING) {
      return { ...result, outcome: current?.state ?? "CANCELLED", decision, observation, policyResult };
    }
    taskQueue.checkpoint(task.id, { action: decision.action, target: decision.target, verified: true,
      screenState: decision.screen_state, observationRef: result.observationAfter?.screenshot_ref ?? null });
  }
  if (["FAILED", "FAILED_VERIFICATION"].includes(result.outcome)
    && taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING) {
    if (!canAccessAccount()) {
      const detail = "research account authorization was revoked during execution";
      const outcome = await reportIfRunning(TASK_STATES.FAILED_FINAL, detail);
      return { ...result, outcome, decision, observation, policyResult, detail };
    }
    if (!deviceLease.canAiAct(device.id)) {
      const detail = "AI input lease was revoked during execution";
      const outcome = await reportIfRunning(TASK_STATES.NEEDS_HUMAN, detail);
      return { ...result, outcome, decision, observation, policyResult, detail };
    }
    const outcome = await reportIfRunning(TASK_STATES.FAILED_RETRYABLE, result.error || result.outcome);
    return { ...result, outcome, decision, observation, policyResult };
  }
  if (result.outcome === "BLOCKED" && taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING) {
    const outcome = await reportIfRunning(TASK_STATES.NEEDS_HUMAN, result.reason);
    return { ...result, outcome, decision, observation, policyResult };
  }
  return { ...result, decision, observation, policyResult };
}

export { CHALLENGE_STATES };
