import { assertOperatorAccountRepository } from "../persistence/operatorAccountRepository.js";

export function createOperatorAccountService({ repository }) {
  assertOperatorAccountRepository(repository);

  return {
    async getAccount(username) {
      return await repository.getAccount(username) ?? null;
    },
    async usernameExists(username) {
      return Boolean(await repository.getAccount(username));
    },
    async listAccounts() {
      return repository.listAccounts();
    },
    async createAccount(input) {
      return repository.createAccount(input);
    },
    async updateAccount(username, patch) {
      return repository.updateAccount(username, patch);
    },
    async setAccountStatus(username, status) {
      return repository.setAccountStatus(username, status);
    },
    async renameAccount(username, nextUsername) {
      return repository.renameAccount(username, nextUsername);
    },
    async invalidateSessions(username) {
      return repository.invalidateSessions(username);
    },
    async resetSecondFactor(username) {
      return repository.resetSecondFactor(username);
    },
  };
}
