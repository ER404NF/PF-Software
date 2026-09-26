// Persistence port for the site registry (a Mac mini and its phones at some
// office or city, plus its hashed enrollment token). The current
// implementation stores site identity and credential material together in
// one record; DATABASE_GAP_ANALYSIS.md's proposed `sites`/`site_credentials`
// split is a later migration-design decision, not something this interface
// slice changes.

export const SITE_REPOSITORY_METHODS = Object.freeze([
  "list",
  "get",
  "create",
  "rotate",
  "update",
  "remove",
  "verifyToken",
  "markSeen",
]);

export function assertSiteRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("site repository must be an object");
  }
  for (const method of SITE_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`site repository requires ${method}()`);
    }
  }
  return repository;
}
