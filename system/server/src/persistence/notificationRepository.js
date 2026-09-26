// Persistence port for queued account-lifecycle notifications (acceptance,
// rejection, recovery emails).

export const NOTIFICATION_REPOSITORY_METHODS = Object.freeze([
  "queue",
  "list",
  "deliveryContent",
  "markCommitted",
  "markAborted",
  "markSent",
  "markFailed",
  "canSecureRecovery",
]);

export function assertNotificationRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("notification repository must be an object");
  }
  for (const method of NOTIFICATION_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`notification repository requires ${method}()`);
    }
  }
  return repository;
}
