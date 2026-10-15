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
    async queue(input) { return store.queue(input); },
    async list() { return store.list(); },
    async deliveryContent(id) { return store.deliveryContent(id); },
    async markCommitted(id) { return store.markCommitted(id); },
    async markAborted(id) { return store.markAborted(id); },
    async markSent(id) { return store.markSent(id); },
    async markFailed(id) { return store.markFailed(id); },
    async claimNext(options) { return store.claimNext(options); },
    async completeClaim(id, claimToken, outcome) { return store.completeClaim(id, claimToken, outcome); },
    async retryEligible(options) { return store.retryEligible(options); },
    canSecureRecovery() { return store.canSecureRecovery(); },
  });
}
