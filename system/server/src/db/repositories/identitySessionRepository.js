// PostgreSQL-backed repository for identity.sessions (M04 part 2). Stores
// only the hashed token — never the raw value, matching siteStore.js's
// existing hashed-enrollment-token convention. Expiry/revocation decisions
// belong to services/identitySessionService.js, not here.

export function createIdentitySessionRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("identity session repository requires a pg Pool or client");
  }

  return {
    async create({ userId, tokenHash, expiresAt, ip = null, userAgent = null, deviceLabel = null }, runner = pool) {
      const result = await runner.query(
        `INSERT INTO identity.sessions (user_id, token_hash, expires_at, ip, user_agent, device_label)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [userId, tokenHash, expiresAt, ip, userAgent, deviceLabel],
      );
      return result.rows[0];
    },

    async getByTokenHash(tokenHash, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.sessions WHERE token_hash = $1", [tokenHash]);
      return result.rows[0] ?? null;
    },

    async getById(id, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.sessions WHERE id = $1", [id]);
      return result.rows[0] ?? null;
    },

    async touch(id, at = new Date(), runner = pool) {
      await runner.query("UPDATE identity.sessions SET last_seen_at = $2 WHERE id = $1", [id, at]);
    },

    async revoke(id, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async revokeAllForUser(userId, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [userId],
      );
      return result.rowCount;
    },

    async listActiveForUser(userId, runner = pool) {
      const result = await runner.query(
        `SELECT * FROM identity.sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC`,
        [userId],
      );
      return result.rows;
    },
  };
}
