// Persistence port for research runs/candidates/observations (roadmap MS8;
// DATABASE_GAP_ANALYSIS.md's research_sessions/research_candidates/
// research_observations domain). Every method already takes workspaceId and
// account explicitly rather than depending on an injected store handle, so
// this contract mainly names the boundary that index.js and
// researchTaskRunner.js used to reach via direct free-function imports.

export const RESEARCH_RUN_REPOSITORY_METHODS = Object.freeze([
  "listRuns",
  "getRun",
  "createRun",
  "appendCandidate",
  "locateCandidate",
  "recordPlatformAction",
  "finalizeRun",
  "setCandidateStatus",
]);

export function assertResearchRunRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("research run repository must be an object");
  }
  for (const method of RESEARCH_RUN_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`research run repository requires ${method}()`);
    }
  }
  return repository;
}
