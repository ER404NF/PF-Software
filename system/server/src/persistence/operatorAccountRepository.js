// Async-first persistence port for administrative operator-account lifecycle.
// File-backed implementations may complete immediately, but every method
// returns a Promise so a later PostgreSQL adapter does not force another API
// rewrite at the route/service boundary.

export const OPERATOR_ACCOUNT_REPOSITORY_METHODS = Object.freeze([
  "getAccount",
  "listAccounts",
  "createAccount",
  "updateAccount",
  "setAccountStatus",
  "renameAccount",
  "invalidateSessions",
  "resetSecondFactor",
]);

export function assertOperatorAccountRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("operator account repository must be an object");
  }
  for (const method of OPERATOR_ACCOUNT_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`operator account repository requires ${method}()`);
    }
  }
  return repository;
}
