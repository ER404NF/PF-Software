import { InterventionQueue } from "../interventionQueue.js";
import { assertInterventionRepository } from "./interventionRepository.js";

// Adapts the existing file-backed InterventionQueue to the intervention
// repository port. Accepts an already-constructed queue (for tests/
// injection) or builds one from the given options, exactly as index.js did
// before this slice.
export function createFileInterventionRepository(queueOrOptions) {
  const queue = queueOrOptions instanceof InterventionQueue ? queueOrOptions : new InterventionQueue(queueOrOptions);

  return assertInterventionRepository({
    open(input) { return queue.open(input); },
    claim(id, by) { return queue.claim(id, by); },
    resolve(id, resolution) { return queue.resolve(id, resolution); },
    resolveForTask(taskId, resolution) { return queue.resolveForTask(taskId, resolution); },
    list(query) { return queue.list(query); },
    counts() { return queue.counts(); },
  });
}
