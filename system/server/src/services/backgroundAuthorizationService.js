import { assertBackgroundAuthorizationRepository } from "../persistence/backgroundAuthorizationRepository.js";

// Names one boundary for every place that resolves and checks a DIFFERENT
// operator's identity than the one already attached to the current
// request/connection: task-queue dispatch, assignment target validation, and
// background task-access checks. Consolidates what were previously several
// direct imports of authStore.js/researchAccess.js internals across
// index.js and researchTaskRunner.js. Deliberately synchronous — see
// persistence/backgroundAuthorizationRepository.js for why.
export function createBackgroundAuthorizationService({ repository }) {
  assertBackgroundAuthorizationRepository(repository);

  return {
    operatorForUsername(username) {
      return repository.getOperatorByUsername(username);
    },
    canAccessDevice(operator, deviceId) {
      return repository.canAccessDevice(operator, deviceId);
    },
    researchWorkspaceFor(operator, accountId) {
      return repository.researchWorkspaceFor(operator, accountId);
    },
  };
}
