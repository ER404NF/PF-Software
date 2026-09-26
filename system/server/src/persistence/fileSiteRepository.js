import { SiteStore } from "../siteStore.js";
import { assertSiteRepository } from "./siteRepository.js";

// Adapts the existing file-backed SiteStore to the site repository port.
// Accepts an already-constructed store (for tests/injection) or builds one
// from filePath/options, exactly as index.js did before this slice. No
// storage format or behavior changes: every method delegates unchanged.
export function createFileSiteRepository(filePathOrStore, options = {}) {
  const store = filePathOrStore instanceof SiteStore
    ? filePathOrStore
    : new SiteStore(filePathOrStore, options);

  return assertSiteRepository({
    list() { return store.list(); },
    get(id) { return store.get(id); },
    create(input) { return store.create(input); },
    rotate(id) { return store.rotate(id); },
    update(id, input) { return store.update(id, input); },
    remove(id) { return store.remove(id); },
    verifyToken(id, token) { return store.verifyToken(id, token); },
    markSeen(id, at) { return store.markSeen(id, at); },
  });
}
