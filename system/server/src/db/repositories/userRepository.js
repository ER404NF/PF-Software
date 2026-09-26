// PostgreSQL-backed user repository (M04 part 1). A user is a global
// identity that can belong to multiple organizations (ADR-0006/ADR-0007),
// so this repository has no organization_id concept at all — see
// membershipRepository.js for the organization relationship.

export function createUserRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("user repository requires a pg Pool or client");
  }

  return {
    // Creates the user and their primary email atomically. Both
    // identity.users.id and identity.user_emails have independent
    // uniqueness constraints (normalized_email is globally unique); a
    // duplicate email surfaces as the underlying pg unique_violation
    // (error.code === '23505') for the caller to translate.
    async createWithPrimaryEmail({ email, passwordHash, displayName = null }, runner = pool) {
      const normalizedEmail = email.trim().toLowerCase();
      const userResult = await runner.query(
        `INSERT INTO identity.users (display_name, password_hash, status)
         VALUES ($1, $2, 'active')
         RETURNING *`,
        [displayName, passwordHash],
      );
      const user = userResult.rows[0];
      const emailResult = await runner.query(
        `INSERT INTO identity.user_emails (user_id, email, normalized_email, is_primary, verified_at)
         VALUES ($1, $2, $3, true, NULL)
         RETURNING *`,
        [user.id, email.trim(), normalizedEmail],
      );
      return { ...user, primaryEmail: emailResult.rows[0] };
    },

    async getById(id, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.users WHERE id = $1", [id]);
      return result.rows[0] ?? null;
    },

    async getByEmail(email, runner = pool) {
      const result = await runner.query(
        `SELECT u.* FROM identity.users u
         JOIN identity.user_emails e ON e.user_id = u.id
         WHERE e.normalized_email = $1`,
        [email.trim().toLowerCase()],
      );
      return result.rows[0] ?? null;
    },

    async updatePasswordHash(userId, passwordHash, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.users SET password_hash = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [userId, passwordHash],
      );
      return result.rows[0] ?? null;
    },

    async markPrimaryEmailVerified(userId, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.user_emails SET verified_at = now()
         WHERE user_id = $1 AND is_primary = true AND verified_at IS NULL
         RETURNING *`,
        [userId],
      );
      return result.rows[0] ?? null;
    },

    async getPrimaryEmail(userId, runner = pool) {
      const result = await runner.query(
        "SELECT * FROM identity.user_emails WHERE user_id = $1 AND is_primary = true",
        [userId],
      );
      return result.rows[0] ?? null;
    },
  };
}
