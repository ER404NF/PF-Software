// Async-first persistence port for authentication and live identity reads.
// Records returned by this contract are internal and may contain password or
// MFA material. Callers must use publicOperator() before sending an identity
// to a browser.

export const OPERATOR_IDENTITY_REPOSITORY_METHODS = Object.freeze([
  "getIdentityRecord",
  "createSignupAccount",
  "prunePendingSignupAccounts",
  "configureTwoFactor",
  "verifySecondFactor",
  "createEmailRecoveryToken",
  "completeEmailRecovery",
]);

export function assertOperatorIdentityRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("operator identity repository must be an object");
  }
  for (const method of OPERATOR_IDENTITY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`operator identity repository requires ${method}()`);
    }
  }
  return repository;
}
