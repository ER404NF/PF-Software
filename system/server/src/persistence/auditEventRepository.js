// Stable persistence port for audit events. Implementations may use JSONL,
// PostgreSQL, or another durable store, but callers depend only on these two
// operations. Keep authorization out of the repository: it stores and queries
// events, while the audit service applies viewer-specific filtering.

export const AUDIT_EVENT_REPOSITORY_METHODS = Object.freeze([
  "logEvent",
  "listEvents",
]);

export function assertAuditEventRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("audit event repository must be an object");
  }
  for (const method of AUDIT_EVENT_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`audit event repository requires ${method}()`);
    }
  }
  return repository;
}
