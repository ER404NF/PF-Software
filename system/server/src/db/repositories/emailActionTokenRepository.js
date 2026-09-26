// PostgreSQL-backed repository for identity.email_action_tokens (M04 part
// 5), shared by email verification and password reset. Stores only the
// hashed token.

export function createEmailActionTokenRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("email action token repository requires a pg Pool or client");
  }

  return {
    async create({ userId, purpose, tokenHash, expiresAt }, runner = pool) {
      const result = await runner.query(
        `INSERT INTO identity.email_action_tokens (user_id, purpose, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, purpose, tokenHash, expiresAt],
      );
      return result.rows[0];
    },

    async getByTokenHash(tokenHash, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.email_action_tokens WHERE token_hash = $1", [tokenHash]);
      return result.rows[0] ?? null;
    },

    async consume(id, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.email_action_tokens SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    // Called before issuing a new token so a user never has more than one
    // live reset/verification link at a time — an old, still-unread email
    // becomes inert the moment a new one is requested.
    async invalidateActiveForUser({ userId, purpose }, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.email_action_tokens SET consumed_at = now()
         WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
         RETURNING id`,
        [userId, purpose],
      );
      return result.rowCount;
    },
  };
}
