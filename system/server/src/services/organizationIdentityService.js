// M04 part 1: organization/identity/RBAC application service. Composes the
// db/repositories/* ports inside real transactions. Not wired into any
// route yet — see docs/productionization/M04_ORGANIZATION_IDENTITY.md for
// what is and isn't covered.
//
// Known gap, not silently omitted: identity.membership_roles has no RLS
// policy of its own (it has no organization_id column to filter on
// directly; a correct policy would need a subquery through memberships,
// which was left out of the M03 migration rather than ship an untested
// subquery-based policy). Cross-membership role tampering is currently
// prevented only by this service always deriving membershipId from a
// caller-verified membership, never from client input directly — a gap to
// close with a proper RLS policy once real usage patterns are clearer.

export function createOrganizationIdentityService({
  pool, withTransaction, organizationRepository, userRepository,
  membershipRepository, roleRepository, hashPassword,
}) {
  for (const [name, dep] of Object.entries({
    pool, withTransaction, organizationRepository, userRepository, membershipRepository, roleRepository, hashPassword,
  })) {
    if (!dep) throw new TypeError(`organization identity service requires ${name}`);
  }

  return {
    // Creates an organization, its first user, an active membership, and
    // assigns the 'owner' system-template role — all inside one
    // transaction, so a failure at any step leaves nothing behind.
    async createOrganizationWithOwner({ slug, displayName, legalName, defaultTimezone, ownerEmail, ownerPassword, ownerDisplayName }) {
      return withTransaction(pool, async (client) => {
        const organization = await organizationRepository.create({ slug, displayName, legalName, defaultTimezone }, client);
        // The membership insert below is RLS-protected and needs the
        // tenant context; the organization itself has no RLS policy (it IS
        // the tenant root), so this is the earliest point it can be set.
        await client.query("SELECT set_config('app.current_organization_id', $1, true)", [organization.id]);

        const passwordHash = hashPassword(ownerPassword);
        const user = await userRepository.createWithPrimaryEmail(
          { email: ownerEmail, passwordHash, displayName: ownerDisplayName ?? null },
          client,
        );
        const membership = await membershipRepository.add(
          { organizationId: organization.id, userId: user.id, status: "active" },
          client,
        );
        const ownerRole = await roleRepository.getByKey({ organizationId: organization.id, key: "owner" }, client);
        if (!ownerRole) {
          throw new Error("owner role is not seeded — run the seed-permissions-and-roles migration first");
        }
        await roleRepository.assignToMembership({ membershipId: membership.id, roleId: ownerRole.id }, client);

        return { organization, user, membership };
      });
    },

    // Adds an existing user (by id) to an organization with a given role.
    // Does not create the user or send an invitation email — that's a
    // separate, not-yet-built flow (see docs/productionization/M04_ORGANIZATION_IDENTITY.md).
    async addMember({ organizationId, userId, roleKey, status = "active" }) {
      return withTransaction(pool, async (client) => {
        const membership = await membershipRepository.add({ organizationId, userId, status }, client);
        const role = await roleRepository.getByKey({ organizationId, key: roleKey }, client);
        if (!role) throw new Error(`unknown role key: ${roleKey}`);
        await roleRepository.assignToMembership({ membershipId: membership.id, roleId: role.id }, client);
        return membership;
      }, { organizationId });
    },

    async hasPermission(membershipId, permissionKey) {
      return roleRepository.hasPermission(membershipId, permissionKey);
    },

    async permissionsForMembership(membershipId) {
      return roleRepository.permissionsForMembership(membershipId);
    },
  };
}
