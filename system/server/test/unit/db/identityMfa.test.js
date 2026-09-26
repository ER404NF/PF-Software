import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityMfaRepository } from "../../../src/db/repositories/identityMfaRepository.js";
import { createIdentityMfaService } from "../../../src/services/identityMfaService.js";

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

test("identityMfaRepository requires a queryable pool", () => {
  assert.throws(() => createIdentityMfaRepository(null), TypeError);
});

test("identityMfaRepository.addTotpMethod inserts method_type totp with an encrypted secret_ref", async () => {
  const pool = fakePool([[{ id: "method-1" }]]);
  const repository = createIdentityMfaRepository(pool);
  await repository.addTotpMethod({ userId: "user-1", label: "Phone", secretRef: "encrypted-blob" });
  assert.match(pool.calls[0].text, /INSERT INTO identity\.mfa_methods/);
  assert.deepEqual(pool.calls[0].params, ["user-1", "Phone", "encrypted-blob"]);
});

// Fake, in-memory implementations of twoFactor.js's exports, so this file
// tests identityMfaService.js's own composition logic without depending on
// the real crypto (which is already covered by twoFactor.js's own tests).
function fakeCrypto() {
  const encrypted = new Map();
  let nextSecret = 1;
  return {
    generateTotpSecret: () => `SECRET${nextSecret++}`,
    verifyTotp: (secret, code) => code === `code-for-${secret}`,
    encryptTotpSecret: (secret) => { const ref = `enc(${secret})`; encrypted.set(ref, secret); return ref; },
    decryptTotpSecret: (ref) => encrypted.get(ref),
    generateRecoveryCodes: () => ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"],
    recoveryCodeDigest: (code) => `digest(${code})`,
    verifyRecoveryCode: (code, digests) => digests.indexOf(`digest(${code})`),
    otpauthUri: ({ secret, email }) => `otpauth://totp/${email}?secret=${secret}`,
  };
}

function fakeRepository() {
  const methods = new Map();
  const recoveryCodes = new Map();
  let nextMethodId = 1;
  let nextCodeId = 1;
  return {
    methods, recoveryCodes,
    async addTotpMethod({ userId, label, secretRef }) {
      const id = `method-${nextMethodId++}`;
      const row = { id, user_id: userId, method_type: "totp", label, secret_ref: secretRef, verified_at: null, disabled_at: null };
      methods.set(id, row);
      return row;
    },
    async getById(id) { return methods.get(id) ?? null; },
    async markVerified(id) { const row = methods.get(id); if (row) row.verified_at = new Date(); return row; },
    async listActiveForUser(userId) { return [...methods.values()].filter((m) => m.user_id === userId && !m.disabled_at); },
    async disable(id) { const row = methods.get(id); if (row) row.disabled_at = new Date(); return row; },
    async insertRecoveryCodes(userId, codeHashes) {
      return codeHashes.map((codeHash) => {
        const id = `code-${nextCodeId++}`;
        const row = { id, user_id: userId, code_hash: codeHash, consumed_at: null };
        recoveryCodes.set(id, row);
        return row;
      });
    },
    async listUnconsumedRecoveryCodes(userId) {
      return [...recoveryCodes.values()].filter((r) => r.user_id === userId && !r.consumed_at);
    },
    async consumeRecoveryCode(id) {
      const row = recoveryCodes.get(id);
      if (!row || row.consumed_at) return null;
      row.consumed_at = new Date();
      return row;
    },
  };
}

function serviceWith() {
  const repository = fakeRepository();
  const crypto_ = fakeCrypto();
  return { service: createIdentityMfaService({ repository, masterKey: "test-key", ...crypto_ }), repository, crypto_ };
}

test("identityMfaService requires every named dependency", () => {
  assert.throws(() => createIdentityMfaService({}), /repository/);
});

test("enrollTotp stores only the encrypted secret, never the plaintext, in the repository", async () => {
  const { service, repository } = serviceWith();
  const { methodId, secret, otpauthUri } = await service.enrollTotp({ userId: "user-1", email: "va@example.com" });
  const stored = repository.methods.get(methodId);
  assert.notEqual(stored.secret_ref, secret);
  assert.match(otpauthUri, /va@example\.com/);
  assert.equal(stored.verified_at, null, "unconfirmed enrollment must not be usable yet");
});

test("confirmTotp with the wrong code leaves the method unverified and issues no recovery codes", async () => {
  const { service, repository } = serviceWith();
  const { methodId } = await service.enrollTotp({ userId: "user-1", email: "va@example.com" });
  const result = await service.confirmTotp({ methodId, code: "000000" });
  assert.equal(result, null);
  assert.equal(repository.methods.get(methodId).verified_at, null);
  assert.equal(repository.recoveryCodes.size, 0);
});

test("confirmTotp with the right code verifies the method and issues recovery codes", async () => {
  const { service, repository } = serviceWith();
  const { methodId, secret } = await service.enrollTotp({ userId: "user-1", email: "va@example.com" });
  const result = await service.confirmTotp({ methodId, code: `code-for-${secret}` });
  assert.ok(Array.isArray(result.recoveryCodes) && result.recoveryCodes.length === 2);
  assert.notEqual(repository.methods.get(methodId).verified_at, null);
  assert.equal(repository.recoveryCodes.size, 2);
});

test("verifyLogin only accepts a code against a verified method, not a pending one", async () => {
  const { service } = serviceWith();
  const { methodId, secret } = await service.enrollTotp({ userId: "user-1", email: "va@example.com" });
  assert.equal(await service.verifyLogin({ userId: "user-1", code: `code-for-${secret}` }), null, "not yet confirmed");
  await service.confirmTotp({ methodId, code: `code-for-${secret}` });
  assert.equal(await service.verifyLogin({ userId: "user-1", code: `code-for-${secret}` }), methodId);
  assert.equal(await service.verifyLogin({ userId: "user-1", code: "wrong" }), null);
});

test("disableMethod stops verifyLogin from accepting that method's codes", async () => {
  const { service } = serviceWith();
  const { methodId, secret } = await service.enrollTotp({ userId: "user-1", email: "va@example.com" });
  await service.confirmTotp({ methodId, code: `code-for-${secret}` });
  await service.disableMethod(methodId);
  assert.equal(await service.verifyLogin({ userId: "user-1", code: `code-for-${secret}` }), null);
});

test("consumeRecoveryCode consumes a code exactly once, then rejects it", async () => {
  const { service } = serviceWith();
  const { methodId, secret } = await service.enrollTotp({ userId: "user-1", email: "va@example.com" });
  const { recoveryCodes } = await service.confirmTotp({ methodId, code: `code-for-${secret}` });

  assert.equal(await service.consumeRecoveryCode({ userId: "user-1", code: recoveryCodes[0] }), true);
  assert.equal(await service.consumeRecoveryCode({ userId: "user-1", code: recoveryCodes[0] }), false, "reused code must fail");
  assert.equal(await service.consumeRecoveryCode({ userId: "user-1", code: "NOPE-NOPE-NOPE" }), false);
  assert.equal(await service.consumeRecoveryCode({ userId: "user-1", code: recoveryCodes[1] }), true, "the other code is unaffected");
});
