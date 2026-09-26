// PostgreSQL-backed repository for identity.invitations (M04 part 3).
// Stores only the hashed invitation token, matching the session/site token
// hashing convention used elsewhere in this codebase.

export function createInvitationRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("invitation repository requires a pg Pool or client");
  }

  return {
    async create({ organizationId, emailNormalized, tokenHash, invitedByUserId = null, expiresAt, roleKey }, runner = pool) {
      const result = await runner.query(
        `INSERT INTO identity.invitations (organization_id, email_normalized, token_hash, invited_by_user_id, expires_at, role_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [organizationId, emailNormalized, tokenHash, invitedByUserId, expiresAt, roleKey],
      );
      return result.rows[0];
    },

    async getByTokenHash(tokenHash, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.invitations WHERE token_hash = $1", [tokenHash]);
      return result.rows[0] ?? null;
    },

    async getById(id, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.invitations WHERE id = $1", [id]);
      return result.rows[0] ?? null;
    },

    async listForOrganization(organizationId, runner = pool) {
      const result = await runner.query(
        "SELECT * FROM identity.invitations WHERE organization_id = $1 ORDER BY created_at DESC",
        [organizationId],
      );
      return result.rows;
    },

    async markAccepted(id, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.invitations SET accepted_at = now()
         WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async markRevoked(id, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },
  };
}
