// M05, second domain: approvals (roadmap MS10.4). Mirrors the file-backed
// ApprovalStore's exact fields (system/server/src/approvalStore.js) plus
// organization_id, scoped to the single default organization per the owner
// decision in M05_DURABLE_DOMAIN_MIGRATION.md.
//
// requested_at/expires_at/decided_at/consumed_at are bigint (epoch
// milliseconds), NOT timestamptz — deliberately matching the existing file
// store's Date.now()-based numeric timestamps exactly, so the Postgres
// adapter returns identically-typed values to any caller (a timestamptz
// would come back as a Date/string, silently changing the contract).
//
// workspace_id here is the existing research-workspace slug (e.g.
// "client-a"), a different and older tenant-like boundary than the new
// identity.organizations model — preserved as-is (plain text, not a foreign
// key to anything), not conflated with organization_id, which exists purely
// for this milestone's own RLS tenant-isolation layer.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE SCHEMA IF NOT EXISTS automation;

    CREATE TABLE automation.approvals (
      id text PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES identity.organizations(id),
      fingerprint text NOT NULL,
      workspace_id text NOT NULL,
      account_id text NOT NULL,
      task_id text,
      device_id text,
      action text NOT NULL,
      target text,
      comment_text text,
      requested_by text,
      context jsonb,
      state text NOT NULL CHECK (state IN ('PENDING','APPROVED','REJECTED','EXPIRED','CONSUMED')),
      requested_at bigint NOT NULL,
      expires_at bigint NOT NULL,
      decided_at bigint,
      decided_by text,
      reason text,
      consumed_at bigint
    );

    CREATE INDEX approvals_organization_idx ON automation.approvals(organization_id);
    CREATE INDEX approvals_fingerprint_idx ON automation.approvals(organization_id, fingerprint);
  `);

  await pgm.db.query(`
    ALTER TABLE automation.approvals ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.approvals FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_approvals ON automation.approvals
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP SCHEMA IF EXISTS automation CASCADE");
}
