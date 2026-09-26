import test from "node:test";
import assert from "node:assert/strict";
import { createEmailActionTokenRepository } from "../../../src/db/repositories/emailActionTokenRepository.js";
import { createEmailActionService } from "../../../src/services/emailActionService.js";

function fakePool(rowsByCall = []) {
  const calls = [];
  let index = 0;
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      const rows = rowsByCall[index] ?? [];
      index += 1;
      return { rows, rowCount: rows.length };
    },
  };
}

test("emailActionTokenRepository requires a queryable pool", () => {
  assert.throws(() => createEmailActionTokenRepository(null), TypeError);
});

test("emailActionTokenRepository.create inserts user_id/purpose/token_hash/expires_at", async () => {
  const pool = fakePool([[{ id: "token-1" }]]);
  const repository = createEmailActionTokenRepository(pool);
  await repository.create({ userId: "user-1", purpose: "verify_email", tokenHash: "hash", expiresAt: new Date("2026-01-01") });
  assert.deepEqual(pool.calls[0].params, ["user-1", "verify_email", "hash", new Date("2026-01-01")]);
});

test("emailActionService requires its named dependencies", () => {
  assert.throws(() => createEmailActionService({}), /pool/);
});

function fakeTokenRepository() {
  const tokens = new Map();
  let nextId = 1;
  return {
    tokens,
    async create({ userId, purpose, tokenHash, expiresAt }) {
      const id = `token-${nextId++}`;
      const row = { id, user_id: userId, purpose, token_hash: tokenHash, expires_at: expiresAt, consumed_at: null };
      tokens.set(id, row);
      return row;
    },
    async getByTokenHash(tokenHash) {
      return [...tokens.values()].find((row) => row.token_hash === tokenHash) ?? null;
    },
    async consume(id) {
      const row = tokens.get(id);
      if (!row || row.consumed_at) return null;
      row.consumed_at = new Date();
      return row;
    },
    async invalidateActiveForUser({ userId, purpose }) {
      let count = 0;
      for (const row of tokens.values()) {
        if (row.user_id === userId && row.purpose === purpose && !row.consumed_at) { row.consumed_at = new Date(); count += 1; }
      }
      return count;
    },
  };
}

function fakeUserRepository() {
  const users = new Map([["user-1", { id: "user-1", password_hash: "old-hash" }]]);
  const verifiedEmails = new Set();
  return {
    users, verifiedEmails,
    async updatePasswordHash(userId, passwordHash) {
      const user = users.get(userId);
      user.password_hash = passwordHash;
      return user;
    },
    async markPrimaryEmailVerified(userId) {
      verifiedEmails.add(userId);
      return { user_id: userId, verified_at: new Date() };
    },
  };
}

function serviceWith({ sessionRepository } = {}) {
  const pool = fakePool();
  const withTransaction = async (_pool, fn) => fn(pool);
  const emailActionTokenRepository = fakeTokenRepository();
  const userRepository = fakeUserRepository();
  const service = createEmailActionService({
    pool, withTransaction, emailActionTokenRepository, userRepository, sessionRepository,
    hashPassword: (pw) => `hashed(${pw})`,
  });
  return { service, emailActionTokenRepository, userRepository };
}

test("issueEmailVerificationToken invalidates a prior unconsumed token for the same purpose", async () => {
  const { service, emailActionTokenRepository } = serviceWith();
  const first = await service.issueEmailVerificationToken("user-1");
  const second = await service.issueEmailVerificationToken("user-1");
  assert.equal(emailActionTokenRepository.tokens.get(first.record.id).consumed_at !== null, true);
  assert.equal(emailActionTokenRepository.tokens.get(second.record.id).consumed_at, null);
});

test("confirmEmailVerification marks the primary email verified exactly once", async () => {
  const { service, userRepository } = serviceWith();
  const { token } = await service.issueEmailVerificationToken("user-1");
  const result = await service.confirmEmailVerification(token);
  assert.notEqual(result, null);
  assert.ok(userRepository.verifiedEmails.has("user-1"));
  assert.equal(await service.confirmEmailVerification(token), null, "the same token cannot be used twice");
});

test("a password-reset token cannot be replayed as an email-verification token", async () => {
  const { service } = serviceWith();
  const { token } = await service.issuePasswordResetToken("user-1");
  assert.equal(await service.confirmEmailVerification(token), null);
});

test("resetPassword updates the password hash and consumes the token exactly once", async () => {
  const { service, userRepository } = serviceWith();
  const { token } = await service.issuePasswordResetToken("user-1");
  const updated = await service.resetPassword({ token, newPassword: "new correct horse battery staple" });
  assert.equal(updated.password_hash, "hashed(new correct horse battery staple)");
  assert.equal(userRepository.users.get("user-1").password_hash, "hashed(new correct horse battery staple)");
  assert.equal(await service.resetPassword({ token, newPassword: "again" }), null, "reused reset token must fail");
});

test("resetPassword revokes every existing session for that user when a session repository is provided", async () => {
  const revoked = [];
  const sessionRepository = { async revokeAllForUser(userId) { revoked.push(userId); } };
  const { service } = serviceWith({ sessionRepository });
  const { token } = await service.issuePasswordResetToken("user-1");
  await service.resetPassword({ token, newPassword: "new passphrase entirely" });
  assert.deepEqual(revoked, ["user-1"]);
});

test("an expired token is rejected for both verification and reset", async () => {
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const pool = fakePool();
  const withTransaction = async (_pool, fn) => fn(pool);
  const emailActionTokenRepository = fakeTokenRepository();
  const userRepository = fakeUserRepository();
  const service = createEmailActionService({
    pool, withTransaction, emailActionTokenRepository, userRepository, hashPassword: (pw) => `hashed(${pw})`, now: () => clock,
  });
  const { token } = await service.issuePasswordResetToken("user-1");
  clock = new Date(clock.getTime() + 24 * 3_600_000);
  assert.equal(await service.resetPassword({ token, newPassword: "x" }), null);
});
