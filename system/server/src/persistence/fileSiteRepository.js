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
    create(input, { authorize = null } = {}) {
      return authorize ? Promise.resolve(authorize()).then(() => store.create(input)) : store.create(input);
    },
    rotate(id, { authorize = null } = {}) {
      return authorize ? Promise.resolve(authorize()).then(() => store.rotate(id)) : store.rotate(id);
    },
    update(id, input, { authorize = null } = {}) {
      return authorize ? Promise.resolve(authorize()).then(() => store.update(id, input)) : store.update(id, input);
    },
    remove(id, { authorize = null } = {}) {
      return authorize ? Promise.resolve(authorize()).then(() => store.remove(id)) : store.remove(id);
    },
    verifyToken(id, token) { return store.verifyToken(id, token); },
    markSeen(id, at) { return store.markSeen(id, at); },
  });
}
