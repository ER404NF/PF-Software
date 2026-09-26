// Persistence port for the platform-action approval gate (roadmap MS10.4).

export const APPROVAL_REPOSITORY_METHODS = Object.freeze([
  "request",
  "decide",
  "findApproved",
  "consume",
  "get",
  "list",
]);

export function assertApprovalRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("approval repository must be an object");
  }
  for (const method of APPROVAL_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`approval repository requires ${method}()`);
    }
  }
  return repository;
}
