// M04 part 6 (HTTP layer): "list every organization I belong to" is a
// legitimate cross-tenant read from the authenticated user's own
// perspective — their memberships can span many different organizations —
// but the existing tenant_isolation_memberships policy only ever makes one
// organization_id visible per transaction (app.current_organization_id).
// Multiple PERMISSIVE policies on the same table are OR'd together by
// PostgreSQL (documented behavior, not an assumption this migration
// invents), so this adds a second, SELECT-only policy: a row is also
// visible when its user_id matches a NEW GUC, app.current_user_id.
//
// Deliberately SELECT-only, not FOR ALL: allowing INSERT/UPDATE/DELETE
// under "user_id = me" would let any authenticated user insert or modify a
// membership row for an organization they don't belong to, just by setting
// user_id to their own id — which is exactly the escalation the org-scoped
// policy exists to prevent. Only the addMember()/acceptInvitation()-style
// service paths, which set app.current_organization_id and verify the
// target organization first, may create or change membership rows.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE POLICY memberships_self_read ON identity.memberships
    FOR SELECT
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP POLICY IF EXISTS memberships_self_read ON identity.memberships");
}
