// PostgreSQL-backed role/permission repository (M04 part 1). Role
// resolution prefers an organization-specific role over the system-template
// (organization_id IS NULL) role of the same key, so an organization can
// override a system role's name/permissions later without a schema change.

export function createRoleRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("role repository requires a pg Pool or client");
  }

  return {
    async getByKey({ organizationId = null, key }, runner = pool) {
      const result = await runner.query(
        `SELECT * FROM identity.roles
         WHERE key = $2 AND (organization_id = $1 OR organization_id IS NULL)
         ORDER BY organization_id IS NOT NULL DESC
         LIMIT 1`,
        [organizationId, key],
      );
      return result.rows[0] ?? null;
    },

    async assignToMembership({ membershipId, roleId }, runner = pool) {
      await runner.query(
        `INSERT INTO identity.membership_roles (membership_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT (membership_id, role_id) DO NOTHING`,
        [membershipId, roleId],
      );
    },

    async removeFromMembership({ membershipId, roleId }, runner = pool) {
      await runner.query(
        "DELETE FROM identity.membership_roles WHERE membership_id = $1 AND role_id = $2",
        [membershipId, roleId],
      );
    },

    async rolesForMembership(membershipId, runner = pool) {
      const result = await runner.query(
        `SELECT r.* FROM identity.roles r
         JOIN identity.membership_roles mr ON mr.role_id = r.id
         WHERE mr.membership_id = $1`,
        [membershipId],
      );
      return result.rows;
    },

    async permissionsForMembership(membershipId, runner = pool) {
      const result = await runner.query(
        `SELECT DISTINCT rp.permission_key FROM identity.role_permissions rp
         JOIN identity.membership_roles mr ON mr.role_id = rp.role_id
         WHERE mr.membership_id = $1`,
        [membershipId],
      );
      return result.rows.map((row) => row.permission_key);
    },

    async hasPermission(membershipId, permissionKey, runner = pool) {
      const result = await runner.query(
        `SELECT 1 FROM identity.role_permissions rp
         JOIN identity.membership_roles mr ON mr.role_id = rp.role_id
         WHERE mr.membership_id = $1 AND rp.permission_key = $2
         LIMIT 1`,
        [membershipId, permissionKey],
      );
      return result.rowCount > 0;
    },
  };
}
