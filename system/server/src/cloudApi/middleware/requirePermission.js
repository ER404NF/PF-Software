// M04 part 6: RBAC permission check. Must run after requireMembership() —
// the permission is always evaluated for req.membership, never a
// client-supplied membership id, so this cannot be used to check someone
// else's permissions.

export function createRequirePermission({ roleRepository }) {
  if (!roleRepository) throw new TypeError("requirePermission middleware requires roleRepository");

  return function requirePermission(permissionKey) {
    return async (req, res, next) => {
      if (!req.membership) return res.status(500).json({ error: "requirePermission used before requireMembership" });
      const allowed = await roleRepository.hasPermission(req.membership.id, permissionKey);
      if (!allowed) return res.status(403).json({ error: `missing required permission: ${permissionKey}` });
      next();
    };
  };
}
