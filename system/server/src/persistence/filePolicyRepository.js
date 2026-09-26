import { PolicyStore } from "../policyStore.js";
import { assertPolicyRepository } from "./policyRepository.js";

// Adapts the existing in-memory/file-backed PolicyStore to the policy
// repository port. Accepts an already-constructed store (for tests/
// injection) or builds one from the given options, exactly as index.js did
// before this slice.
export function createFilePolicyRepository(storeOrOptions) {
  const store = storeOrOptions instanceof PolicyStore ? storeOrOptions : new PolicyStore(storeOrOptions);

  return assertPolicyRepository({
    set(accountId, action, value, by) { return store.set(accountId, action, value, by); },
    clear(accountId, action) { return store.clear(accountId, action); },
    effective(basePolicies) { return store.effective(basePolicies); },
    describe(accountId, basePolicies) { return store.describe(accountId, basePolicies); },
  });
}
