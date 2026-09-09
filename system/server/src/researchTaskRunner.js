import { runResearchStep } from "./researchWorker.js";
import { TASK_STATES } from "./taskSpec.js";
import { createRun, appendCandidate } from "./researchStore.js";
import { saveResearchEvidence } from "./researchEvidenceStore.js";

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
  stepDelayMs = 1000,
  sleep = wait,
  createRunRecord = createRun,
  appendCandidateRecord = appendCandidate,
  saveEvidenceRecord = saveResearchEvidence,
} = {}) {
  if (!taskQueue || !devices || !deviceLease) throw new Error("research task runner requires queue, devices and lease");
  if (![providerForTask, skillForPlatform, operatorForUsername, workspaceForOperatorAccount].every((fn) => typeof fn === "function")) {
    throw new Error("research task runner requires provider, skill and authorization resolvers");
  }
  if (!Number.isFinite(stepDelayMs) || stepDelayMs < 0) throw new Error("stepDelayMs must be non-negative");

  const active = new Map();
  let started = false;

  async function failIfRunning(task, detail) {
    if (taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING) {
      await taskQueue.reportResult(task.id, TASK_STATES.FAILED_FINAL, { detail });
    }
  }

  async function runTask({ task, deviceId }) {
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
      return workspaceForOperatorAccount(operator, accountId) === workspaceId;
    };

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

      const provider = providerForTask(current, { workspaceId, deviceId });
      if (!provider) {
        await failIfRunning(current, "the selected model provider is no longer available");
        return { outcome: TASK_STATES.FAILED_FINAL, error: "the selected model provider is no longer available" };
      }
      const result = await runResearchStep({ task: current, device, accountId, workspaceId, provider, skill,
        accountWorkspaces, accountPolicies, taskQueue, deviceLease, auditLog, canAccessAccount });
      if (result.outcome !== "VERIFIED") {
        // reportResult(FAILED_RETRYABLE) may release the device and
        // synchronously redispatch this same task before runResearchStep()
        // returns. launch() deliberately coalesces duplicate task IDs, so
        // this promise must own that new attempt instead of exiting and
        // leaving the redispatched task RUNNING without a worker.
        if (result.outcome === TASK_STATES.FAILED_RETRYABLE
          && taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING) {
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
          if (frame && deviceLease.canAiAct(deviceId) && canAccessAccount()) {
            const saved = saveEvidenceRecord(workspaceId, accountId, frame);
            if (saved?.ref) evidence.push(saved.ref);
          }
        } catch (error) {
          auditLog?.logEvent({ operator: task.createdBy, type: "research_evidence_failed", deviceId,
            detail: { taskId: task.id, accountId, workspaceId, runId: candidateRunId,
              error: error?.message || String(error) } });
        }
        const recorded = appendCandidateRecord(workspaceId, accountId, candidateRunId, {
          ...result.decision.candidate,
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
        ensureRun(result.decision.reason);
        if (taskQueue.getTask(task.id)?.state === TASK_STATES.RUNNING) {
          await taskQueue.reportResult(task.id, TASK_STATES.SUCCEEDED, { detail: "research goal completed" });
        }
        return { ...result, outcome: TASK_STATES.SUCCEEDED };
      }
      await sleep(stepDelayMs);
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
      .finally(() => active.delete(payload.task.id));
    active.set(payload.task.id, promise);
    return promise;
  }

  function start() {
    if (started) return;
    started = true;
    taskQueue.on("dispatched", launch);
  }

  return { start, launch, runTask, waitForTask: (taskId) => active.get(taskId) ?? null };
}

export { COMPLETE_PROGRESS };
