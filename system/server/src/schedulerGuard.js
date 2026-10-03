import { logOperationalFailure, operationalErrorKind } from "./safeOperationalLog.js";

export function createSchedulerGuard({ taskQueue, expireAssignments, auditLog = null, logError = console.error } = {}) {
  if (!taskQueue?.tick || typeof expireAssignments !== "function") {
    throw new Error("scheduler guard requires task and assignment runners");
  }
  const health = { state: "healthy", lastSuccessAt: null, lastErrorAt: null, failedComponent: null };

  function recordFailure(component, error, at) {
    health.state = "degraded";
    health.lastErrorAt = at.toISOString();
    health.failedComponent = component;
    logOperationalFailure(`Scheduled ${component} maintenance failed`, error, logError);
    try {
      auditLog?.logEvent({ type: "scheduler_persistence_failed",
        detail: { component, errorName: operationalErrorKind(error) } });
    } catch (auditError) {
      logOperationalFailure("Scheduler failure audit could not be written", auditError, logError);
    }
  }

  function run(at = new Date()) {
    let failed = false;
    try { taskQueue.tick(at); }
    catch (error) { failed = true; recordFailure("task_queue", error, at); }
    try { expireAssignments(at); }
    catch (error) { failed = true; recordFailure("assignments", error, at); }
    if (!failed) {
      health.state = "healthy";
      health.lastSuccessAt = at.toISOString();
      health.failedComponent = null;
    }
    return !failed;
  }

  function status() {
    return { ...health };
  }

  return { run, status };
}
