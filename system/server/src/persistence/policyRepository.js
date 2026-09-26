// Persistence port for per-account action policy overrides (policyStore.js
// — roadmap MS10.1; `/policy get|set`). `effective()` is read from
// actionPolicy.js's validateAction() gate inline, never awaited — the same
// "callers need an immediate, non-awaited answer" constraint
// persistence/backgroundAuthorizationRepository.js's own header documents —
// so every method here is synchronous by contract, even though a
// PostgreSQL-backed adapter's `set()`/`clear()` persist durably in the
// background (see db/repositories/postgresPolicyRepository.js and
// src/syncCache.js).

export const POLICY_REPOSITORY_METHODS = Object.freeze(["set", "clear", "effective", "describe"]);

export function assertPolicyRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("policy repository must be an object");
  }
  for (const method of POLICY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`policy repository requires ${method}()`);
    }
  }
  return repository;
}
