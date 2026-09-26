// Synchronous-by-design authorization port for code paths that resolve a
// DIFFERENT operator's identity than the one already attached to the current
// request/connection: the task queue's dispatch decision, assignment target
// validation, and background task-access checks. These callers are not
// awaited per-decision (the task queue's dispatch predicate and the
// assignment routes' inline validation both need an immediate answer), so
// this contract stays synchronous rather than hiding asynchronous I/O behind
// a boolean callback. The resolvers behind it read a live in-memory
// projection today; a future database-backed identity source must publish a
// synchronously readable, refreshed snapshot behind this same boundary
// (mirroring the WebSocket identity snapshot) rather than making the task
// queue's dispatch loop itself async.

export const BACKGROUND_AUTHORIZATION_REPOSITORY_METHODS = Object.freeze([
  "getOperatorByUsername",
  "canAccessDevice",
  "researchWorkspaceFor",
]);

export function assertBackgroundAuthorizationRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("background authorization repository must be an object");
  }
  for (const method of BACKGROUND_AUTHORIZATION_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`background authorization repository requires ${method}()`);
    }
  }
  return repository;
}
