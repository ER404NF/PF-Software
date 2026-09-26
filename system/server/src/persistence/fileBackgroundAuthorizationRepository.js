import { canAccessDevice, operatorByUsername } from "../authStore.js";
import { researchWorkspaceFor } from "../researchAccess.js";
import { assertBackgroundAuthorizationRepository } from "./backgroundAuthorizationRepository.js";

// Adapts the current live in-memory operator registry and research config
// to the background authorization port. No behavior changes here: every
// method delegates directly to the existing implementation.
export function createFileBackgroundAuthorizationRepository(legacy = {
  operatorByUsername,
  canAccessDevice,
  researchWorkspaceFor,
}) {
  return assertBackgroundAuthorizationRepository({
    getOperatorByUsername(username) {
      return legacy.operatorByUsername(username);
    },
    canAccessDevice(operator, deviceId) {
      return legacy.canAccessDevice(operator, deviceId);
    },
    researchWorkspaceFor(operator, accountId) {
      return legacy.researchWorkspaceFor(operator, accountId);
    },
  });
}
