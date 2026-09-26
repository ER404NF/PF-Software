import { createAssignmentStore } from "../assignmentStore.js";
import { assertAssignmentRepository } from "./assignmentRepository.js";

// Adapts the existing file-backed assignment store to the assignment
// repository port. Accepts an already-constructed store (for tests/
// injection) or builds one from the given options, exactly as index.js did
// before this slice. No storage format or behavior changes.
export function createFileAssignmentRepository(storeOrOptions) {
  const store = storeOrOptions && typeof storeOrOptions.list === "function"
    ? storeOrOptions
    : createAssignmentStore(storeOrOptions);

  return assertAssignmentRepository({
    list() { return store.list(); },
    get(assignmentId) { return store.get(assignmentId); },
    create(input) { return store.create(input); },
    setStatus(assignmentId, status, actor) { return store.setStatus(assignmentId, status, actor); },
    reassign(assignmentId, assignee, actor) { return store.reassign(assignmentId, assignee, actor); },
    renamePrincipal(previousUsername, username, actor) { return store.renamePrincipal(previousUsername, username, actor); },
    reschedule(assignmentId, schedule, actor) { return store.reschedule(assignmentId, schedule, actor); },
    expireDue(at) { return store.expireDue(at); },
  });
}
