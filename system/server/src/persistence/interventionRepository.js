// Persistence port for the human intervention queue (roadmap MS12.3).

export const INTERVENTION_REPOSITORY_METHODS = Object.freeze([
  "open",
  "claim",
  "resolve",
  "resolveForTask",
  "list",
  "counts",
]);

export function assertInterventionRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("intervention repository must be an object");
  }
  for (const method of INTERVENTION_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`intervention repository requires ${method}()`);
    }
  }
  return repository;
}
