// M04 part 1: seed the permission catalog and system-template roles from the
// master productionization prompt §4's "Initial role model" and permission
// list. This is a reasonable STARTING default, not a finalized product/
// business decision — see docs/productionization/M04_ORGANIZATION_IDENTITY.md
// "Open decisions" for what remains owner-decision territory (e.g. exactly
// what distinguishes Owner from Administrator once organization-lifecycle
// permissions like deletion/transfer exist; how this reconciles with the
// existing file-backed 5-role operator system in roleCapabilities.js).
//
// System-template roles have organization_id = NULL (per the roles table's
// own design in the identity-and-organizations migration) and are shared
// across every organization; an organization may still define its own
// custom roles later with a non-null organization_id.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

const PERMISSIONS = [
  ["device:view", "View device/fleet status"],
  ["device:control", "Send input to a device"],
  ["device:assign", "Assign a device to an operator or account"],
  ["account:view", "View platform account details"],
  ["account:operate", "Act on a platform account (research/automation)"],
  ["research:view", "View research runs/candidates"],
  ["research:run", "Start or advance a research run"],
  ["research:review", "Review/decide research candidates"],
  ["ai:start", "Start AI VA execution on a device"],
  ["ai:stop", "Stop/take over AI VA execution on a device"],
  ["ai:approve_action", "Approve a REQUIRE_APPROVAL platform action"],
  ["proxy:view", "View the proxy pool (no credentials)"],
  ["proxy:manage", "Add/remove/assign proxy pool credentials"],
  ["member:invite", "Invite a member to the organization"],
  ["member:manage", "Change a member's role or remove them"],
  ["site:view", "View registered sites/hosts"],
  ["site:manage", "Register/rotate/remove a site"],
  ["billing:view", "View subscription/billing state"],
  ["billing:manage", "Change plan/payment/billing settings"],
  ["audit:view", "View audit events"],
  ["organization:manage", "Change organization-level settings"],
];

const ALL_PERMISSION_KEYS = PERMISSIONS.map(([key]) => key);

const ROLES = {
  owner: ALL_PERMISSION_KEYS,
  administrator: ALL_PERMISSION_KEYS,
  manager: [
    "device:view", "device:control", "device:assign",
    "account:view", "account:operate",
    "research:view", "research:run", "research:review",
    "ai:start", "ai:stop",
    "proxy:view",
    "member:invite", "member:manage",
    "site:view",
    "audit:view",
  ],
  va_operator: ["device:view", "device:control", "account:view", "account:operate", "research:view"],
  researcher: ["research:view", "research:run", "account:view"],
  reviewer: ["research:view", "research:review", "audit:view"],
  billing_admin: ["billing:view", "billing:manage", "audit:view"],
};

// Uses pgm.db.query() (standard $1/$2 positional pg parameters, executed
// immediately) rather than pgm.sql()'s own {name}-style templating — safer
// and more familiar than learning that templating engine's escaping rules
// for something this migration cannot be tested against a live database
// before merge.
export async function up(pgm) {
  for (const [key, description] of PERMISSIONS) {
    await pgm.db.query(
      "INSERT INTO identity.permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
      [key, description],
    );
  }
  for (const [roleKey, permissionKeys] of Object.entries(ROLES)) {
    // roles has no plain unique constraint on (organization_id, key) — only
    // the COALESCE-expression index from the identity-and-organizations
    // migration — so this uses WHERE NOT EXISTS rather than an ON CONFLICT
    // target that would have to exactly match that expression.
    await pgm.db.query(
      `INSERT INTO identity.roles (organization_id, key, name, is_system_template)
       SELECT NULL, $1, $2, true
       WHERE NOT EXISTS (SELECT 1 FROM identity.roles WHERE organization_id IS NULL AND key = $1)`,
      [roleKey, roleName(roleKey)],
    );
    for (const permissionKey of permissionKeys) {
      await pgm.db.query(
        `INSERT INTO identity.role_permissions (role_id, permission_key)
         SELECT id, $2 FROM identity.roles WHERE organization_id IS NULL AND key = $1
         ON CONFLICT (role_id, permission_key) DO NOTHING`,
        [roleKey, permissionKey],
      );
    }
  }
}

function roleName(key) {
  return key.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

export async function down(pgm) {
  await pgm.db.query(`
    DELETE FROM identity.role_permissions
    WHERE role_id IN (SELECT id FROM identity.roles WHERE organization_id IS NULL AND is_system_template)
  `);
  await pgm.db.query("DELETE FROM identity.roles WHERE organization_id IS NULL AND is_system_template");
  await pgm.db.query("DELETE FROM identity.permissions");
}
