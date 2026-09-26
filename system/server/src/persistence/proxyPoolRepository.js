// Persistence port for the shared proxy pool (credential storage and
// exclusive per-device lease). Pure transforms that don't touch storage —
// decryptProxyPassword(), publicProxy(), flagForCountry() — stay as direct
// proxyPool.js imports; they operate on an already-loaded record, not on the
// store.

export const PROXY_POOL_REPOSITORY_METHODS = Object.freeze([
  "load",
  "get",
  "create",
  "remove",
  "assignToDevice",
  "forDevice",
  "updateHealth",
  "publicList",
]);

export function assertProxyPoolRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("proxy pool repository must be an object");
  }
  for (const method of PROXY_POOL_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`proxy pool repository requires ${method}()`);
    }
  }
  return repository;
}
