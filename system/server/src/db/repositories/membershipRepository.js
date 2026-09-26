// PostgreSQL-backed organization-membership repository (M04 part 1).

export function createMembershipRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("membership repository requires a pg Pool or client");
  }

  return {
    async add({ organizationId, userId, status = "active" }, runner = pool) {
      const result = await runner.query(
        `INSERT INTO identity.memberships (organization_id, user_id, status)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [organizationId, userId, status],
      );
      return result.rows[0];
    },

    // Like listForOrganization below, requires the caller's connection to
    // already have app.current_organization_id set to organizationId — this
    // table is RLS-protected, and a plain pool connection with no context
    // (or the wrong context) set will silently see zero rows rather than
    // error, which is correct fail-closed behavior but easy to mistake for
    // "no such membership" if a caller forgets to open the transaction.
    async get(organizationId, userId, runner = pool) {
      const result = await runner.query(
        "SELECT * FROM identity.memberships WHERE organization_id = $1 AND user_id = $2",
        [organizationId, userId],
      );
      return result.rows[0] ?? null;
    },

    // A user's own memberships across every organization. Requires the
    // caller's connection to have app.current_user_id set to userId (see
    // db/transaction.js's userId option and the membership-self-read-policy
    // migration) — the org-scoped RLS policy alone would hide every row
    // here, since there is no single organization_id for "all of my orgs".
    // userId must come from the authenticated caller's own verified
    // identity, never a client-supplied parameter — the self-read policy
    // only checks user_id against the session GUC, so passing an arbitrary
    // userId here (with a connection that has current_user_id set to that
    // same value) is exactly how one would read someone else's memberships;
    // the WHERE clause and the RLS policy both key off the same value, so
    // neither is a real check unless the caller enforces userId === the
    // authenticated user before ever reaching this method.
    async listForUser(userId, runner = pool) {
      const result = await runner.query(
        "SELECT * FROM identity.memberships WHERE user_id = $1 ORDER BY created_at",
        [userId],
      );
      return result.rows;
    },

    async getById(membershipId, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.memberships WHERE id = $1", [membershipId]);
      return result.rows[0] ?? null;
    },

    // Requires the caller's connection to already have
    // app.current_organization_id set to organizationId (see
    // db/transaction.js) — this table is RLS-protected.
    async listForOrganization(organizationId, runner = pool) {
      const result = await runner.query(
        "SELECT * FROM identity.memberships WHERE organization_id = $1 ORDER BY created_at",
        [organizationId],
      );
      return result.rows;
    },

    async setStatus(membershipId, status, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.memberships SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [membershipId, status],
      );
      return result.rows[0] ?? null;
    },
  };
}
