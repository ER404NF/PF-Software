// M04 part 4: TOTP MFA enrollment/verification and recovery codes against
// identity.mfa_methods/identity.recovery_codes. Reuses twoFactor.js's
// existing, already-audited TOTP/AES-GCM/recovery-code implementation
// rather than a second one — this service only adds the PostgreSQL
// persistence shape around it. Not wired into any route yet.

export function createIdentityMfaService({
  repository, masterKey, generateTotpSecret, verifyTotp, encryptTotpSecret, decryptTotpSecret,
  generateRecoveryCodes, recoveryCodeDigest, verifyRecoveryCode, otpauthUri,
}) {
  for (const [name, dep] of Object.entries({
    repository, masterKey, generateTotpSecret, verifyTotp, encryptTotpSecret, decryptTotpSecret,
    generateRecoveryCodes, recoveryCodeDigest, verifyRecoveryCode, otpauthUri,
  })) {
    if (!dep) throw new TypeError(`identity MFA service requires ${name}`);
  }

  return {
    // Returns the plaintext secret and an otpauth:// URI for a QR code —
    // both shown to the user exactly once, at enrollment time. The method
    // is not usable for login until confirmTotp() verifies a real code.
    async enrollTotp({ userId, email, label = null }) {
      const secret = generateTotpSecret();
      const method = await repository.addTotpMethod({ userId, label, secretRef: encryptTotpSecret(secret, masterKey) });
      return { methodId: method.id, secret, otpauthUri: otpauthUri({ secret, email }) };
    },

    // Confirms enrollment with a real code from the authenticator app, then
    // issues recovery codes (shown once, only their hashes are persisted).
    // Returns null if the code doesn't verify — the method stays unverified
    // and unusable for login either way.
    async confirmTotp({ methodId, code }) {
      const method = await repository.getById(methodId);
      if (!method || method.method_type !== "totp" || method.disabled_at) return null;
      const secret = decryptTotpSecret(method.secret_ref, masterKey);
      if (!verifyTotp(secret, code)) return null;
      await repository.markVerified(methodId);
      const recoveryCodes = generateRecoveryCodes();
      await repository.insertRecoveryCodes(method.user_id, recoveryCodes.map((c) => recoveryCodeDigest(c)));
      return { recoveryCodes };
    },

    // Verifies a login-time TOTP code against every verified, enabled TOTP
    // method the user has. Returns the matching method's id, or null.
    async verifyLogin({ userId, code }) {
      const methods = await repository.listActiveForUser(userId);
      for (const method of methods) {
        if (method.method_type !== "totp" || !method.verified_at) continue;
        const secret = decryptTotpSecret(method.secret_ref, masterKey);
        if (verifyTotp(secret, code)) return method.id;
      }
      return null;
    },

    // Consumes one recovery code for the user, returning true exactly once
    // per code — a reused or unknown code always returns false.
    async consumeRecoveryCode({ userId, code }) {
      const unconsumed = await repository.listUnconsumedRecoveryCodes(userId);
      const index = verifyRecoveryCode(code, unconsumed.map((row) => row.code_hash));
      if (index < 0 || index >= unconsumed.length) return false;
      const consumed = await repository.consumeRecoveryCode(unconsumed[index].id);
      return Boolean(consumed);
    },

    async disableMethod(methodId) {
      return repository.disable(methodId);
    },

    async listActiveMethods(userId) {
      return repository.listActiveForUser(userId);
    },
  };
}
