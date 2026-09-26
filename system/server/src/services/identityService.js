import { assertOperatorIdentityRepository } from "../persistence/operatorIdentityRepository.js";

function approvedActive(record) {
  return Boolean(record
    && record.active !== false
    && (record.accountStatus ?? "approved") === "approved");
}

function matchingVersion(record, principal) {
  return (principal?.authVersion ?? 0) === (record?.authVersion ?? 0);
}

export function createIdentityService({ repository, verifyPassword }) {
  assertOperatorIdentityRepository(repository);
  if (typeof verifyPassword !== "function") {
    throw new TypeError("identity service requires verifyPassword()");
  }

  return {
    // Authentication deliberately returns an internal record even when the
    // account is pending/rejected/inactive after a correct password. The HTTP
    // login route preserves its existing, status-specific response ordering.
    async authenticatePassword(username, password) {
      const record = await repository.getIdentityRecord(username);
      if (!record || !verifyPassword(password, record.passwordHash)) return null;
      return record;
    },

    async getIdentityRecord(username) {
      return await repository.getIdentityRecord(username) ?? null;
    },

    async createSignupAccount(input) {
      return repository.createSignupAccount(input);
    },

    async prunePendingSignupAccounts(options) {
      return repository.prunePendingSignupAccounts(options);
    },

    async configureTwoFactor(username, encryptedSecret, recoveryCodeDigests) {
      return repository.configureTwoFactor(username, encryptedSecret, recoveryCodeDigests);
    },

    async verifySecondFactor(username, code, masterKey) {
      return repository.verifySecondFactor(username, code, masterKey);
    },

    async createEmailRecoveryToken(identifier) {
      return repository.createEmailRecoveryToken(identifier);
    },

    async completeEmailRecovery(token, password, passwordConfirmation) {
      return repository.completeEmailRecovery(token, password, passwordConfirmation);
    },

    async resolveSessionPrincipal(principal) {
      if (!principal?.username) return null;
      const record = await repository.getIdentityRecord(principal.username);
      if (!approvedActive(record) || !matchingVersion(record, principal)) return null;
      return record;
    },

    async resolvePendingAuthentication(challenge, { now = Date.now() } = {}) {
      if (!challenge?.username || Date.parse(challenge.expiresAt) <= now) return null;
      const record = await repository.getIdentityRecord(challenge.username);
      if (!approvedActive(record) || !matchingVersion(record, challenge)) return null;
      return record;
    },
  };
}
