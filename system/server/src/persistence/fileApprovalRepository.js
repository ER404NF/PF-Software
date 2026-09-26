import { ApprovalStore } from "../approvalStore.js";
import { assertApprovalRepository } from "./approvalRepository.js";

// Adapts the existing file-backed ApprovalStore to the approval repository
// port. Accepts an already-constructed store (for tests/injection) or builds
// one from the given options, exactly as index.js did before this slice.
export function createFileApprovalRepository(storeOrOptions) {
  const store = storeOrOptions instanceof ApprovalStore ? storeOrOptions : new ApprovalStore(storeOrOptions);

  return assertApprovalRepository({
    request(input) { return store.request(input); },
    decide(id, decision) { return store.decide(id, decision); },
    findApproved(subject) { return store.findApproved(subject); },
    consume(id) { return store.consume(id); },
    get(id) { return store.get(id); },
    list(query) { return store.list(query); },
  });
}
