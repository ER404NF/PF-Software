import { assertOperatorAccountRepository } from "../persistence/operatorAccountRepository.js";

export function createOperatorAccountService({ repository }) {
  assertOperatorAccountRepository(repository);

  return {
    async getAccount(username) {
      return await repository.getAccount(username) ?? null;
    },
    async getRecentLoginIps(username) {
      const ips = await repository.getRecentLoginIps(username);
      return Array.isArray(ips) ? [...ips] : [];
    },
    async usernameExists(username) {
      return Boolean(await repository.getAccount(username));
    },
    async listAccounts() {
      return repository.listAccounts();
    },
    async createAccount(input, options) {
      return repository.createAccount(input, options);
    },
    async updateAccount(username, patch, options) {
      return repository.updateAccount(username, patch, options);
    },
    async setAccountStatus(username, status, metadata, options) {
      return repository.setAccountStatus(username, status, metadata, options);
    },
    async renameAccount(username, nextUsername, options) {
      return repository.renameAccount(username, nextUsername, options);
    },
    async invalidateSessions(username, options) {
      return repository.invalidateSessions(username, options);
    },
    async resetSecondFactor(username, options) {
      return repository.resetSecondFactor(username, options);
    },
    async requestDeletion(username, password, options) {
      return repository.requestDeletion(username, password, options);
    },
    async validateDeletion(username, password, options) {
      return repository.validateDeletion(username, password, options);
    },
    async finalizePrivacyDeletion(username, tombstone, requestId, options) {
      return repository.finalizePrivacyDeletion(username, tombstone, requestId, options);
    },
  };
}
