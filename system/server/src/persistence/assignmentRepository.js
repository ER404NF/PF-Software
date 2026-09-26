// Persistence port for durable operator assignments (ASSIGNMENTS.md). Device
// LEASES are deliberately not part of this port: deviceLease.js is an
// in-process controller-mode state machine with no file store behind it —
// there is nothing to place a repository interface around until it moves to
// a shared/distributed backing (Redis, per ADR-0003), which is later,
// separate work (M06), not this interface slice.

export const ASSIGNMENT_REPOSITORY_METHODS = Object.freeze([
  "list",
  "get",
  "create",
  "setStatus",
  "reassign",
  "renamePrincipal",
  "reschedule",
  "expireDue",
]);

export function assertAssignmentRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("assignment repository must be an object");
  }
  for (const method of ASSIGNMENT_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`assignment repository requires ${method}()`);
    }
  }
  return repository;
}
