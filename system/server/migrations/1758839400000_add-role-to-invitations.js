// M04 part 3: an invitation needs to remember which role it grants on
// acceptance. PF_SOFTWARE_DATABASE_LOGICAL_PHYSICAL_SCHEMA.md §7.1's
// invitations table doesn't have this column — recorded here as a
// deliberate, small, additive schema disagreement rather than silently
// working around it in application code. No foreign key: identity.roles.key
// is only unique per (organization_id, key) via a COALESCE expression index
// (see the identity-and-organizations migration), not globally, so this is
// validated by services/invitationService.js at write time instead.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  // No existing rows to backfill (identity.invitations is unused before
  // this milestone), so this can require the value outright rather than
  // add-then-drop a temporary default.
  await pgm.db.query("ALTER TABLE identity.invitations ADD COLUMN role_key text NOT NULL");
}

export async function down(pgm) {
  await pgm.db.query("ALTER TABLE identity.invitations DROP COLUMN role_key");
}
