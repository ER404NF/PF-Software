// PostgreSQL-backed repository for identity.mfa_methods and
// identity.recovery_codes (M04 part 4). Stores only encrypted TOTP secrets
// (secret_ref) and hashed recovery codes — never plaintext — matching this
// schema's own documented intent and twoFactor.js's existing convention.

export function createIdentityMfaRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("identity MFA repository requires a pg Pool or client");
  }

  return {
    async addTotpMethod({ userId, label = null, secretRef }, runner = pool) {
      const result = await runner.query(
        `INSERT INTO identity.mfa_methods (user_id, method_type, label, secret_ref)
         VALUES ($1, 'totp', $2, $3)
         RETURNING *`,
        [userId, label, secretRef],
      );
      return result.rows[0];
    },

    async getById(id, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.mfa_methods WHERE id = $1", [id]);
      return result.rows[0] ?? null;
    },

    async markVerified(id, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.mfa_methods SET verified_at = now() WHERE id = $1 RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async listActiveForUser(userId, runner = pool) {
      const result = await runner.query(
        `SELECT * FROM identity.mfa_methods WHERE user_id = $1 AND disabled_at IS NULL ORDER BY created_at`,
        [userId],
      );
      return result.rows;
    },

    async disable(id, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.mfa_methods SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async insertRecoveryCodes(userId, codeHashes, runner = pool) {
      const rows = [];
      for (const codeHash of codeHashes) {
        const result = await runner.query(
          `INSERT INTO identity.recovery_codes (user_id, code_hash) VALUES ($1, $2) RETURNING *`,
          [userId, codeHash],
        );
        rows.push(result.rows[0]);
      }
      return rows;
    },

    async listUnconsumedRecoveryCodes(userId, runner = pool) {
      const result = await runner.query(
        `SELECT * FROM identity.recovery_codes WHERE user_id = $1 AND consumed_at IS NULL ORDER BY created_at`,
        [userId],
      );
      return result.rows;
    },

    async consumeRecoveryCode(id, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.recovery_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },
  };
}
