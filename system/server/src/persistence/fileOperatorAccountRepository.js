import {
  createOperatorAccount,
  getOperatorRecentLoginIps,
  invalidateOperatorSessions,
  listOperatorAccounts,
  renameOperatorAccount,
  requestOperatorDeletion,
  resetOperatorSecondFactor,
  setOperatorAccountStatus,
  updateOperatorAccount,
  validateOperatorDeletionRequest,
  finalizeOperatorPrivacyDeletion,
} from "../authStore.js";
import { assertOperatorAccountRepository } from "./operatorAccountRepository.js";

export function createFileOperatorAccountRepository(legacyStore = {
  createOperatorAccount,
  getOperatorRecentLoginIps,
  invalidateOperatorSessions,
  listOperatorAccounts,
  renameOperatorAccount,
  requestOperatorDeletion,
  resetOperatorSecondFactor,
  setOperatorAccountStatus,
  updateOperatorAccount,
  validateOperatorDeletionRequest,
  finalizeOperatorPrivacyDeletion,
}) {
  return assertOperatorAccountRepository({
    async getAccount(username) {
      return legacyStore.listOperatorAccounts().find(account => account.username === username) ?? null;
    },
    async getRecentLoginIps(username) {
      return legacyStore.getOperatorRecentLoginIps(username);
    },
    async listAccounts() {
      return legacyStore.listOperatorAccounts();
    },
    async createAccount(input, { authorize = null } = {}) {
      await authorize?.();
      return legacyStore.createOperatorAccount(input);
    },
    async updateAccount(username, patch, { authorize = null } = {}) {
      await authorize?.();
      return legacyStore.updateOperatorAccount(username, patch);
    },
    async setAccountStatus(username, status, metadata, { authorize = null } = {}) {
      await authorize?.();
      return legacyStore.setOperatorAccountStatus(username, status, metadata);
    },
    async renameAccount(username, nextUsername, { authorize = null } = {}) {
      await authorize?.();
      return legacyStore.renameOperatorAccount(username, nextUsername);
    },
    async invalidateSessions(username, { authorize = null } = {}) {
      await authorize?.();
      return legacyStore.invalidateOperatorSessions(username);
    },
    async resetSecondFactor(username, { authorize = null } = {}) {
      await authorize?.();
      return legacyStore.resetOperatorSecondFactor(username);
    },
    async validateDeletion(username, password, { authorize = null } = {}) {
      await authorize?.();
      return legacyStore.validateOperatorDeletionRequest(username, password);
    },
    async requestDeletion(username, password, { authorize = null } = {}) {
      await authorize?.();
      return legacyStore.requestOperatorDeletion(username, password);
    },
    async finalizePrivacyDeletion(username, tombstone, requestId, { authorize = null } = {}) {
      await authorize?.();
      return legacyStore.finalizeOperatorPrivacyDeletion(username, tombstone, requestId);
    },
  });
}
