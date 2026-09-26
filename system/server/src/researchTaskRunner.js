import { canAccessDevice as defaultCanAccessDevice } from "./authStore.js";
import { runResearchStep } from "./researchWorker.js";
import { TASK_STATES } from "./taskSpec.js";
import { createRun, appendCandidate, finalizeRun, getRun, locateCandidate, recordPlatformAction } from "./researchStore.js";
import { SessionBudget, buildSessionReport, scoreCandidate, DEFAULT_SCORING_PROFILE, SESSION_OUTCOMES } from "./researchSession.js";
import { saveResearchEvidence } from "./researchEvidenceStore.js";
import { observationFingerprint } from "./optimization/stateCache.js";

const COMPLETE_PROGRESS = new Set(["complete", "completed", "done", "goal complete", "goal completed"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createResearchTaskRunner({
  taskQueue,
  devices,
  deviceLease,
  auditLog,
  accountWorkspaces,
  accountPolicies,
  providerForTask,
  skillForPlatform,
  operatorForUsername,
  workspaceForOperatorAccount,
  canAccessDevice = defaultCanAccessDevice,
  canUseDevice = () => true,
  stepDelayMs = 1000,
  sleep = wait,
  createRunRecord = createRun,
  appendCandidateRecord = appendCandidate,
  finalizeRunRecord = finalizeRun,
  saveEvidenceRecord = saveResearchEvidence,
  // MS9/MS10: platform-visible actions (all optional)
  approvals = null,
  commentLedger = null,
  templates = null,
  commentPolicy = undefined,
  locateCandidateRecord = locateCandidate,
  recordPlatformActionRecord = recordPlatformAction,
  // MS11: timed sessions
  getRunRecord = getRun,
  sessionQuotaForTask = () => ({}),
  scoringProfileForTask = () => DEFAULT_SCORING_PROFILE,
  now = () => Date.now(),
  // MS12: fleet monitoring
  interventions = null,
  spend = null,
  // MS13: optional adaptive pacing. A function returning a fresh AdaptivePacing-like
  // object ({ next(fingerprint) -> ms }) per session; without it the wait is the fixed stepDelayMs.
  pacingForTask = null,
} = {}) {
  if (!taskQueue || !devices || !deviceLease) throw new Error("research task runner requires queue, devices and lease");
  if (![providerForTask, skillForPlatform, operatorForUsername, workspaceForOperatorAccount, canAccessDevice, canUseDevice].every((fn) => typeof fn === "function")) {
    throw new Error("research task runner requires provider, skill and authorization resolvers");
  }
  if (!Number.isFinite(stepDelayMs) || stepDelayMs < 0) throw new Error("stepDelayMs must be non-negative");

  const active = new Map();
  const providersByTask = new Map(); // taskId -> provider in use, so a routing provider can be told the session ended
  const budgets = new Map(); // taskId -> SessionBudget, for the live monitor and reports
  let started = false;

  async function failIfRunning(task, detail) {
    if (taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING) {
      await taskQueue.reportResult(task.id, TASK_STATES.FAILED_FINAL, { detail });
    }
  }

  async function runTaskBody({ task, deviceId }) {
    if (task.kind !== "research") return { outcome: "IGNORED" };
    const accountId = task.accountSelector?.accountId;
    const platform = task.accountSelector?.platform;
    const workspaceId = accountWorkspaces?.get(accountId);
    const device = devices.get(deviceId);
    const skill = skillForPlatform(platform);
    const missing = [
      [!accountId || !workspaceId, "research task has no configured account/workspace"],
      [!device, "research task device is unavailable"],
      [!providerForTask(task, { workspaceId, deviceId }), "no model provider is configured for the research task"],
      [!skill, `no enabled ${platform || "requested"} platform skill is configured`],
    ].find(([condition]) => condition);
    if (missing) {
      await failIfRunning(task, missing[1]);
      return { outcome: TASK_STATES.FAILED_FINAL, error: missing[1] };
    }

    const canAccessAccount = () => {
      const operator = operatorForUsername(task.createdBy);
      return canAccessDevice(operator, deviceId) && canUseDevice(deviceId)
        && workspaceForOperatorAccount(operator, accountId) === workspaceId;
    };

    // The session's budget survives a restart: it is rebuilt from what was checkpointed.
    const budget = SessionBudget.fromCheckpoints(taskQueue.getTask(task.id)?.checkpoints ?? [],
      { quota: sessionQuotaForTask(task), now });
    budgets.set(task.id, budget);
    const pacing = pacingForTask?.(task) ?? null;
    const scoringProfile = scoringProfileForTask(task) ?? DEFAULT_SCORING_PROFILE;
    const interventionContext = { taskId: task.id, deviceId, accountId, workspaceId, platform };

    let runId = [...(task.checkpoints || [])].reverse()
      .find((checkpoint) => checkpoint.data?.researchRunId)?.data.researchRunId ?? null;
    function ensureRun(overview) {
      if (runId) return runId;
      const run = createRunRecord(workspaceId, accountId, {
        platform,
        timeWindow: { earliestStart: task.earliestStart, latestEnd: task.latestEnd },
        overview,
        candidates: [],
      });
      if (!run?.id) throw new Error("research run could not be created");
      runId = run.id;
      taskQueue.checkpoint(task.id, { researchRunId: runId, recordType: "research_run_started" });
      auditLog?.logEvent({ operator: task.createdBy, type: "research_run_started", deviceId,
        detail: { taskId: task.id, accountId, workspaceId, runId } });
      return runId;
    }

    // The session ended because a budget or quota said so (not because the model said "done").
    async function stopSession({ current, verdict }) {
      const stoppedRunId = ensureRun(verdict.reason);
      const run = getRunRecord(workspaceId, accountId, stoppedRunId);
      const report = buildSessionReport({ run, task: current, budget,
        interventions: interventions?.list().filter(item => item.taskId === task.id) ?? [], now });
      const finalOutcome = verdict.outcome === SESSION_OUTCOMES.SUCCEEDED ? TASK_STATES.SUCCEEDED
        : (current.checkpoints?.length ?? 0) > 0 || budget.state.steps > 0 ? TASK_STATES.PARTIAL : TASK_STATES.FAILED_FINAL;
      finalizeRunRecord(workspaceId, accountId, stoppedRunId, { overview: `Session stopped: ${verdict.reason}`, outcome: finalOutcome, session: report });
      taskQueue.checkpoint(task.id, { researchRunId: stoppedRunId, recordType: "research_run_completed" });
      auditLog?.logEvent({ operator: task.createdBy, type: "research_session_stopped", deviceId,
        detail: { taskId: task.id, accountId, workspaceId, runId: stoppedRunId, outcome: finalOutcome, reason: verdict.reason,
          steps: budget.state.steps, costUsd: report.cost.totalUsd } });
      if (taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING) {
        await taskQueue.reportResult(task.id, finalOutcome, { detail: verdict.reason });
      }
      return { outcome: finalOutcome, stoppedBy: verdict.reason, report };
    }

    while (true) {
      const current = taskQueue.getTask(task.id);
      if (!current || [TASK_STATES.CANCELLED, TASK_STATES.NEEDS_HUMAN, TASK_STATES.FAILED_FINAL,
        TASK_STATES.SUCCEEDED, TASK_STATES.PARTIAL, TASK_STATES.EXPIRED].includes(current.state)) {
        return { outcome: current?.state ?? "MISSING" };
      }
      if (current.state === TASK_STATES.PAUSED) {
        await sleep(stepDelayMs);
        continue;
      }
      if (current.state !== TASK_STATES.RUNNING) return { outcome: current.state };
      // The task is running again: whatever a person was needed for is over.
      interventions?.resolveForTask(task.id, { resolution: "task resumed" });

      const verdict = budget.check();
      if (verdict.stop) return stopSession({ current, verdict });

      const provider = providerForTask(current, { workspaceId, deviceId });
      if (!provider) {
        await failIfRunning(current, "the selected model provider is no longer available");
        return { outcome: TASK_STATES.FAILED_FINAL, error: "the selected model provider is no longer available" };
      }
      providersByTask.set(task.id, provider);
      const stepToken = deviceLease.getAiToken(deviceId);
      const stepStartedAt = now();
      const result = await runResearchStep({ task: current, device, accountId, workspaceId, provider, skill,
        accountWorkspaces, accountPolicies, taskQueue, deviceLease, auditLog, canAccessAccount, saveEvidence: saveEvidenceRecord,
        approvals, commentLedger, templates, commentPolicy,
        locateCandidate: target => locateCandidateRecord(workspaceId, accountId, target),
        recordPlatformAction: recordPlatformActionRecord });
      const costUsd = Number(result.decision?.usage?.cost_usd ?? provider.costPerStepUsd ?? 0) || 0;
      const stepOk = result.outcome === "VERIFIED";
      budget.recordStep({ action: result.decision?.action ?? null, ok: stepOk, latencyMs: now() - stepStartedAt, costUsd,
        error: stepOk ? null : (result.error || result.detail || result.outcome) });
      spend?.add(costUsd);
      provider.noteOutcome?.({ taskId: task.id, ok: stepOk });
      if (result.recovery?.recovered) budget.recordRecovery("app_recovered", result.recovery.destination ?? null);
      if (result.outcome === TASK_STATES.FAILED_RETRYABLE) budget.recordRecovery("step_retry", result.error || null);
      if (budget.state.steps % 5 === 0 && taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING) {
        taskQueue.checkpoint(task.id, budget.toCheckpoint());
      }
      if (result.outcome === TASK_STATES.NEEDS_HUMAN) {
        interventions?.open({ ...interventionContext, reason: result.detail || result.error || "a person is needed" });
      }
      if (result.outcome !== "VERIFIED") {
        // reportResult(FAILED_RETRYABLE) may release the device and
        // synchronously redispatch this same task before runResearchStep()
        // returns. launch() deliberately coalesces duplicate task IDs, so
        // this promise must own that new attempt instead of exiting and
        // leaving the redispatched task RUNNING without a worker.
        // A pause can happen inside a pending step, and can even be resumed
        // before that step returns. Keep this worker and obtain a fresh
        // decision on the next iteration; never reuse the stale result.
        const state = taskQueue.getTask(task.id)?.state;
        if (state === TASK_STATES.PAUSED || state === TASK_STATES.RUNNING) {
          await sleep(stepDelayMs);
          continue;
        }
        return result;
      }
      if (result.decision?.candidate) {
        const candidateRunId = ensureRun(result.decision.reason);
        const evidence = [];
        try {
          const frame = result.observation?.screenshot ?? (typeof device.render === "function" ? await device.render() : null);
          if (frame && taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING
            && deviceLease.getAiToken(deviceId) === stepToken && deviceLease.canAiAct(deviceId) && canAccessAccount()) {
            const saved = saveEvidenceRecord(workspaceId, accountId, frame);
            if (saved?.ref) evidence.push(saved.ref);
          }
        } catch (error) {
          auditLog?.logEvent({ operator: task.createdBy, type: "research_evidence_failed", deviceId,
            detail: { taskId: task.id, accountId, workspaceId, runId: candidateRunId,
              error: error?.message || String(error) } });
        }
        const afterCapture = taskQueue.getTask(task.id);
        if (afterCapture?.state !== TASK_STATES.RUNNING || deviceLease.getAiToken(deviceId) !== stepToken || !canAccessAccount()) {
          if (afterCapture?.state === TASK_STATES.RUNNING && !canAccessAccount()) {
            await failIfRunning(task, "research authorization was revoked during evidence capture");
          }
          const outcome = taskQueue.getTask(task.id)?.state ?? "CANCELLED";
          if ([TASK_STATES.PAUSED, TASK_STATES.RUNNING].includes(outcome)) continue;
          return { outcome };
        }
        // The scoring profile, not the model's own opinion, decides what is worth keeping.
        const scored = scoreCandidate({ ...result.decision.candidate, ai_summary: result.decision.candidate.ai_summary ?? result.decision.reason }, scoringProfile);
        budget.recordCandidate({ keep: scored.keep });
        const recorded = appendCandidateRecord(workspaceId, accountId, candidateRunId, {
          ...result.decision.candidate,
          score: scored.score,
          device_id: deviceId,
          task_id: task.id,
          selection_reason: result.decision.candidate.selection_reason ?? result.decision.reason,
          evidence_refs: evidence,
        });
        if (!recorded?.id) throw new Error("verified candidate could not be recorded");
        taskQueue.checkpoint(task.id, { researchRunId: candidateRunId, candidateId: recorded.id,
          recordType: "content_candidate" });
        auditLog?.logEvent({ operator: task.createdBy, type: "research_candidate_recorded", deviceId,
          detail: { taskId: task.id, accountId, workspaceId, runId: candidateRunId, candidateId: recorded.id } });
      }
      const progress = String(result.decision?.goal_progress ?? "").trim().toLowerCase();
      if (COMPLETE_PROGRESS.has(progress)) {
        const completedRunId = ensureRun(result.decision.reason);
        const finalized = finalizeRunRecord(workspaceId, accountId, completedRunId, {
          overview: result.decision.reason,
          outcome: TASK_STATES.SUCCEEDED,
          session: buildSessionReport({ run: getRunRecord(workspaceId, accountId, completedRunId), task: taskQueue.getTask(task.id), budget,
            interventions: interventions?.list().filter(item => item.taskId === task.id) ?? [], now }),
        });
        if (!finalized?.id) throw new Error("research run could not be finalized");
        taskQueue.checkpoint(task.id, { researchRunId: completedRunId, recordType: "research_run_completed" });
        if (taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING) {
          await taskQueue.reportResult(task.id, TASK_STATES.SUCCEEDED, { detail: "research goal completed" });
        }
        return { ...result, outcome: TASK_STATES.SUCCEEDED };
      }
      await sleep(pacing ? pacing.next(observationFingerprint(result.observation)) : stepDelayMs);
    }
  }

  async function runTask(payload) {
    try { return await runTaskBody(payload); }
    catch (error) {
      await failIfRunning(payload.task, error?.message || String(error));
      throw error;
    } finally {
      const task = taskQueue.getTask(payload.task.id);
      if ([TASK_STATES.CANCELLED, TASK_STATES.NEEDS_HUMAN, TASK_STATES.FAILED_FINAL,
        TASK_STATES.PARTIAL, TASK_STATES.EXPIRED].includes(task?.state)) {
        const runId = [...(task.checkpoints || [])].reverse().find(cp => cp.data?.researchRunId)?.data.researchRunId;
        if (runId) {
          const accountId = task.accountSelector?.accountId;
          finalizeRunRecord(accountWorkspaces.get(accountId), accountId, runId,
            { overview: task.result?.detail || "Research stopped before completion", outcome: task.state });
        }
      }
    }
  }

  function launch(payload) {
    if (payload.task.kind !== "research") return null;
    if (active.has(payload.task.id)) return active.get(payload.task.id);
    const promise = runTask(payload)
      .catch(async (error) => {
        await failIfRunning(payload.task, error?.message || String(error));
        return { outcome: TASK_STATES.FAILED_FINAL, error: error?.message || String(error) };
      })
      .finally(() => {
        active.delete(payload.task.id);
        providersByTask.get(payload.task.id)?.finish?.(payload.task.id);
        providersByTask.delete(payload.task.id);
      });
    active.set(payload.task.id, promise);
    return promise;
  }

  function start() {
    if (started) return;
    started = true;
    taskQueue.on("dispatched", launch);
  }

  return {
    start, launch, runTask, waitForTask: (taskId) => active.get(taskId) ?? null,
    // Live view of a session's budget (for the fleet monitor and the report endpoint).
    sessionBudget: taskId => budgets.get(taskId) ?? null,
    sessionSummaries: () => [...budgets].map(([taskId, budget]) => ({ taskId, steps: budget.state.steps })),
    activeTaskIds: () => [...active.keys()],
  };
}

export { COMPLETE_PROGRESS };
