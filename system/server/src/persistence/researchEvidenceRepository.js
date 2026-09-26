// Persistence port for research evidence screenshots (DATABASE_GAP_ANALYSIS.md's
// storage.file_objects domain, scoped here to one research account's
// evidence directory rather than generic object storage).

export const RESEARCH_EVIDENCE_REPOSITORY_METHODS = Object.freeze(["save", "resolve"]);

export function assertResearchEvidenceRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("research evidence repository must be an object");
  }
  for (const method of RESEARCH_EVIDENCE_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`research evidence repository requires ${method}()`);
    }
  }
  return repository;
}
