// One bounded MS8 research-worker step. researchTaskRunner owns queue
// subscription and looping; this unit connects observation -> model -> policy
// -> skill while preserving the existing task/lease handoff path.

import { saveResearchEvidence } from "./researchEvidenceStore.js";
import { captureObservation } from "./observationPackage.js";
import { validateAction } from "./actionPolicy.js";
import { executeSkillAction } from "./platformSkill.js";
import { TASK_STATES, hasExecutionExpired } from "./taskSpec.js";
import { checkComment, COMMENT_REJECTION_TEXT } from "./commentGuard.js";
import { isCommentAction } from "./actionCatalog.js";

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
  saveEvidence = saveResearchEvidence,
  // MS9/MS10: platform-visible actions. All optional; without them such actions can
  // only ever be DENIED (no record lookup) or held for approval.
  approvals = null,
  commentLedger = null,
  templates = null,
  commentPolicy = undefined,
  locateCandidate = null,
  recordPlatformAction = null,
} = {}) {
  if (!task || task.state !== TASK_STATES.RUNNING) throw new Error("research step requires a RUNNING task");
  if (!device || task.deviceSelector?.deviceId !== device.id) throw new Error("research step device does not match the dispatched task");
  if (!provider || typeof provider.observeAndPlan !== "function") throw new Error("research step requires a model provider");
  if (!taskQueue || !deviceLease) throw new Error("research step requires the task queue and device lease");
  if (typeof canAccessAccount !== "function") throw new Error("research step requires a live account authorization check");
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("confidenceThreshold must be between 0 and 1");
  }
  if (hasExecutionExpired(task)) {
    taskQueue.tick(new Date());
    return { outcome: taskQueue.getTask(task.id)?.state ?? TASK_STATES.EXPIRED };
  }
  if (!deviceLease.canAiAct(device.id)) throw new Error("AI input lease is not active");
  if (!canAccessAccount()) throw new Error("research account authorization is not active");

  const leaseToken = deviceLease.getAiToken(device.id);
  const ownsTask = () => {
    const current = taskQueue.getTask(task.id);
    if (current?.state === TASK_STATES.RUNNING && hasExecutionExpired(current)) taskQueue.tick(new Date());
    return current?.state === TASK_STATES.RUNNING && deviceLease.getAiToken(device.id) === leaseToken;
  };

  async function reportIfRunning(outcome, detail) {
    const current = taskQueue.getTask(task.id);
    if (!ownsTask()) return current?.state ?? null;
    await taskQueue.reportResult(task.id, outcome, { detail });
    return outcome;
  }

  let observation;
  let decision;
  try {
    observation = await captureObservation(device, {
      goal: task.goal,
      canObserve: () => ownsTask() && canAccessAccount(),
      platform: task.accountSelector?.platform ?? skill?.platform ?? null,
      accountId,
      taskId: task.id,
    });
    if (!ownsTask()) return { outcome: taskQueue.getTask(task.id)?.state ?? "CANCELLED", observation };
    if (!canAccessAccount()) {
      const detail = "research authorization was revoked before model submission";
      return { outcome: await reportIfRunning(TASK_STATES.FAILED_FINAL, detail), observation, detail };
    }
    // The second argument is optional context for routing providers (MS13.2); plain providers ignore it.
    decision = await provider.observeAndPlan(observation, {
      taskId: task.id,
      platform: task.accountSelector?.platform ?? skill?.platform ?? null,
      permittedActions: Array.isArray(task.allowedActions) ? task.allowedActions : [],
    });
  } catch (error) {
    const outcome = await reportIfRunning(canAccessAccount() ? TASK_STATES.FAILED_RETRYABLE : TASK_STATES.FAILED_FINAL, error.message);
    return { outcome, error: error.message, observation: observation ?? null };
  }

  // A late model response must not replace the new owner's pending action.
  if (!ownsTask()) {
    return { outcome: taskQueue.getTask(task.id)?.state ?? "CANCELLED", decision, observation };
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
    allowedActions: task.allowedActions, approvals,
    hasResearchRecord: target => Boolean(locateCandidate?.(target)) });
  const commentText = decision.comment?.text ?? null;
  if (policyResult.outcome === "REQUIRES_APPROVAL") {
    // A human decides; the request is bound to this exact action, target and wording.
    const approval = approvals?.request?.({ workspaceId, accountId, taskId: task.id, deviceId: device.id,
      action: decision.action, target: decision.target, commentText, requestedBy: task.createdBy,
      context: { reason: decision.reason, source: decision.comment?.source ?? null } }) ?? null;
    const detail = approval
      ? `${decision.action} is waiting for approval (${approval.id})`
      : `${decision.action} requires explicit approval`;
    auditLog?.logEvent({ type: "approval_requested", deviceId: device.id, operator: task.createdBy,
      detail: { taskId: task.id, accountId, workspaceId, action: decision.action, target: decision.target,
        approvalId: approval?.id ?? null } });
    const outcome = await reportIfRunning(TASK_STATES.NEEDS_HUMAN, detail);
    return { outcome, decision, observation, policyResult, detail, approval };
  }
  if (policyResult.outcome !== "ALLOWED") {
    // Acting before recording the content is the model's mistake, not a permanent
    // failure: let the task's normal retry give it another go.
    const outcome = await reportIfRunning(policyResult.code === "NO_RECORD" ? TASK_STATES.FAILED_RETRYABLE : TASK_STATES.FAILED_FINAL, policyResult.reason);
    return { outcome, decision, observation, policyResult };
  }

  // Comments: application-level safety, checked here and never left to the prompt.
  let located = null;
  if (policyResult.platformVisible) located = locateCandidate?.(decision.target) ?? null;
  if (isCommentAction(decision.action)) {
    const candidate = located?.candidate;
    const template = decision.comment.source === "preset" ? templates?.get?.(workspaceId, decision.comment.template_id) ?? null : null;
    const groundingText = [candidate?.text_extract, candidate?.ai_summary, candidate?.selection_reason,
      candidate?.source_handle, ...(candidate?.tags ?? [])].filter(Boolean).join(" ");
    const contentKey = candidate?.canonical_url ?? candidate?.platform_content_id ?? decision.target;
    const guard = checkComment({ text: decision.comment.text, source: decision.comment.source, contentKey,
      workspaceId, accountId, ledger: commentLedger, groundingText, template, policy: commentPolicy });
    if (!guard.ok) {
      const detail = `comment not sent: ${guard.reasons.map(reason => COMMENT_REJECTION_TEXT[reason] ?? reason).join("; ")}`;
      auditLog?.logEvent({ type: "comment_rejected", deviceId: device.id, operator: task.createdBy,
        detail: { taskId: task.id, accountId, workspaceId, reasons: guard.reasons } });
      const outcome = await reportIfRunning(TASK_STATES.NEEDS_HUMAN, detail);
      return { outcome, decision, observation, policyResult, detail, guard };
    }
    // Recorded BEFORE it is sent: if the post succeeds but cannot be confirmed, a retry
    // sees it in the ledger and refuses to post it a second time.
    commentLedger?.record({ workspaceId, accountId, platform: skill?.platform ?? null, contentKey,
      text: decision.comment.text, source: decision.comment.source, taskId: task.id });
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
    canExecute: () => ownsTask() && deviceLease.canAiAct(device.id, leaseToken) && canAccessAccount(),
    observeAfter: () => captureObservation(device, {
      goal: task.goal,
      canObserve: () => ownsTask() && canAccessAccount(),
      platform: task.accountSelector?.platform ?? skill.platform,
      accountId,
      taskId: task.id,
    }),
    context: { device, deviceId: device.id, taskId: task.id, accountId, workspaceId,
      saveScreenshot: frame => saveEvidence(workspaceId, accountId, frame) },
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
    if (!ownsTask()) {
      return { ...result, outcome: current?.state ?? "CANCELLED", decision, observation, policyResult };
    }
    if (policyResult.platformVisible) {
      // Used up (single-use), audited, and mirrored into the research record.
      if (policyResult.approvalId) approvals?.consume?.(policyResult.approvalId);
      const status = result.execution?.outcome === "NOOP" ? "NOOP" : "VERIFIED";
      const mirrored = located && recordPlatformAction?.(workspaceId, accountId, located.runId, located.candidate.id, {
        action: decision.action, status, text: commentText, task_id: task.id,
        approval_id: policyResult.approvalId ?? null, source: decision.comment?.source ?? null });
      auditLog?.logEvent({ type: "platform_action", deviceId: device.id, operator: task.createdBy,
        detail: { taskId: task.id, accountId, workspaceId, action: decision.action, target: decision.target, status,
          policy: policyResult.policy, approvalId: policyResult.approvalId ?? null,
          candidateId: located?.candidate?.id ?? null, mirrored: Boolean(mirrored) } });
    }
    taskQueue.checkpoint(task.id, { action: decision.action, target: decision.target, verified: true,
      screenState: decision.screen_state, observationRef: result.execution?.evidence?.ref ?? result.observationAfter?.screenshot_ref ?? null });
  }
  // A platform-visible action that did not verify is never retried automatically: it may
  // have partly taken effect, and repeating it could be seen by other people. A human checks.
  if (policyResult.platformVisible && ["FAILED", "FAILED_VERIFICATION"].includes(result.outcome) && ownsTask()) {
    const detail = `${decision.action} could not be confirmed (${result.error || result.outcome}); check the account before repeating it`;
    auditLog?.logEvent({ type: "platform_action_unconfirmed", deviceId: device.id, operator: task.createdBy,
      detail: { taskId: task.id, accountId, workspaceId, action: decision.action, target: decision.target, reason: result.error || result.outcome } });
    const outcome = await reportIfRunning(canAccessAccount() ? TASK_STATES.NEEDS_HUMAN : TASK_STATES.FAILED_FINAL, detail);
    return { ...result, outcome, decision, observation, policyResult, detail };
  }
  if (["FAILED", "FAILED_VERIFICATION"].includes(result.outcome)
    && ownsTask()) {
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
  if (["BLOCKED", "NEEDS_HUMAN"].includes(result.outcome) && ownsTask()) {
    const outcome = await reportIfRunning(canAccessAccount() ? TASK_STATES.NEEDS_HUMAN : TASK_STATES.FAILED_FINAL, result.reason);
    return { ...result, outcome, decision, observation, policyResult };
  }
  return { ...result, decision, observation, policyResult };
}

export { CHALLENGE_STATES };
