import { createAccountNotificationStore } from "../accountNotificationStore.js";
import { assertNotificationRepository } from "./notificationRepository.js";

// Adapts the existing file-backed account notification store to the
// notification repository port. Accepts an already-constructed store (for
// tests/injection) or builds one from the given options, exactly as
// index.js did before this slice.
export function createFileNotificationRepository(storeOrOptions) {
  const store = storeOrOptions && typeof storeOrOptions.queue === "function"
    ? storeOrOptions
    : createAccountNotificationStore(storeOrOptions);

  return assertNotificationRepository({
    queue(input) { return store.queue(input); },
    list() { return store.list(); },
    deliveryContent(id) { return store.deliveryContent(id); },
    markCommitted(id) { return store.markCommitted(id); },
    markAborted(id) { return store.markAborted(id); },
    markSent(id) { return store.markSent(id); },
    markFailed(id) { return store.markFailed(id); },
    canSecureRecovery() { return store.canSecureRecovery(); },
  });
}
