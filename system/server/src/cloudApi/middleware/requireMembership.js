// M04 part 6: resolves and verifies the caller's membership in the
// organization named by a route param, opening a transaction with
// app.current_organization_id set — membershipRepository.get() is
// RLS-protected and returns nothing under a plain, context-less connection
// (see that repository's own comment). Must run after authenticate().

export function createRequireMembership({ pool, withTransaction, organizationRepository, membershipRepository }) {
  for (const [name, dep] of Object.entries({ pool, withTransaction, organizationRepository, membershipRepository })) {
    if (!dep) throw new TypeError(`requireMembership middleware requires ${name}`);
  }

  return function requireMembership(paramName = "organizationId") {
    return async (req, res, next) => {
      if (!req.userId) return res.status(500).json({ error: "requireMembership used before authenticate" });
      const organizationId = req.params[paramName];

      const organization = await organizationRepository.getById(organizationId);
      if (!organization || organization.status !== "active") {
        return res.status(404).json({ error: "unknown organization" });
      }

      const membership = await withTransaction(
        pool,
        (client) => membershipRepository.get(organizationId, req.userId, client),
        { organizationId },
      );
      if (!membership || membership.status !== "active") {
        // 403, not 404: the organization is real, the caller just isn't in
        // it — matches this codebase's existing "identity gone is 401,
        // authorization denied is 403/404 depending on what's safe to
        // reveal" convention (see authStore.js's history).
        return res.status(403).json({ error: "not an active member of this organization" });
      }

      req.organization = organization;
      req.membership = membership;
      next();
    };
  };
}
