import {
  createOperatorAccount,
  invalidateOperatorSessions,
  listOperatorAccounts,
  renameOperatorAccount,
  resetOperatorSecondFactor,
  setOperatorAccountStatus,
  updateOperatorAccount,
} from "../authStore.js";
import { assertOperatorAccountRepository } from "./operatorAccountRepository.js";

export function createFileOperatorAccountRepository(legacyStore = {
  createOperatorAccount,
  invalidateOperatorSessions,
  listOperatorAccounts,
  renameOperatorAccount,
  resetOperatorSecondFactor,
  setOperatorAccountStatus,
  updateOperatorAccount,
}) {
  return assertOperatorAccountRepository({
    async getAccount(username) {
      return legacyStore.listOperatorAccounts().find(account => account.username === username) ?? null;
    },
    async listAccounts() {
      return legacyStore.listOperatorAccounts();
    },
    async createAccount(input) {
      return legacyStore.createOperatorAccount(input);
    },
    async updateAccount(username, patch) {
      return legacyStore.updateOperatorAccount(username, patch);
    },
    async setAccountStatus(username, status) {
      return legacyStore.setOperatorAccountStatus(username, status);
    },
    async renameAccount(username, nextUsername) {
      return legacyStore.renameOperatorAccount(username, nextUsername);
    },
    async invalidateSessions(username) {
      return legacyStore.invalidateOperatorSessions(username);
    },
    async resetSecondFactor(username) {
      return legacyStore.resetOperatorSecondFactor(username);
    },
  });
}
