import {
  completeEmailRecovery,
  configureOperatorTwoFactor,
  createEmailRecoveryToken,
  createSignupAccount,
  operators,
  prunePendingSignupAccounts,
  verifyOperatorSecondFactor,
} from "../authStore.js";
import { assertOperatorIdentityRepository } from "./operatorIdentityRepository.js";

// Adapts the current in-memory view of operators.config.json to the identity
// port. The async method shape is intentional: a future database-backed
// adapter can replace this one without changing route or middleware APIs.
export function createFileOperatorIdentityRepository(legacyStore = {
  registry: operators,
  completeEmailRecovery,
  configureOperatorTwoFactor,
  createEmailRecoveryToken,
  createSignupAccount,
  prunePendingSignupAccounts,
  verifyOperatorSecondFactor,
}) {
  return assertOperatorIdentityRepository({
    async getIdentityRecord(username) {
      if (typeof username !== "string") return null;
      return legacyStore.registry.get(username) ?? null;
    },
    async createSignupAccount(input) {
      return legacyStore.createSignupAccount(input);
    },
    async prunePendingSignupAccounts(options) {
      return legacyStore.prunePendingSignupAccounts(options);
    },
    async configureTwoFactor(username, encryptedSecret, recoveryCodeDigests) {
      return legacyStore.configureOperatorTwoFactor(username, encryptedSecret, recoveryCodeDigests);
    },
    async verifySecondFactor(username, code, masterKey) {
      return legacyStore.verifyOperatorSecondFactor(username, code, masterKey);
    },
    async createEmailRecoveryToken(identifier) {
      return legacyStore.createEmailRecoveryToken(identifier);
    },
    async completeEmailRecovery(token, password, passwordConfirmation) {
      return legacyStore.completeEmailRecovery(token, password, passwordConfirmation);
    },
  });
}
