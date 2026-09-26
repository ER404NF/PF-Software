// M05, third domain: interventions (roadmap MS12.3). Mirrors the file-backed
// InterventionQueue's exact fields (system/server/src/interventionQueue.js)
// plus organization_id, scoped to the single default organization per the
// owner decision in M05_DURABLE_DOMAIN_MIGRATION.md. Same shape/reasoning as
// the automation.approvals migration: timestamps are bigint epoch
// milliseconds (matching Date.now()-based values exactly, not timestamptz),
// workspace_id is the existing research-workspace slug preserved as plain
// text, not conflated with organization_id.
//
// Deliberately does NOT replicate InterventionQueue's own _trim() (bounding
// RESOLVED items to maxResolved to cap JSON file size) — a database table
// doesn't have the same unbounded-file-growth problem, and retention here is
// a policy decision for later (DATABASE_GAP_ANALYSIS.md's own "audit
// retention/anonymization as policy, not unrestricted cascade deletion"),
// not something to force into parity with a workaround that existed only
// because of the old storage format's limitations.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE TABLE automation.interventions (
      id text PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES identity.organizations(id),
      task_id text,
      device_id text,
      account_id text,
      workspace_id text,
      platform text,
      kind text NOT NULL,
      reason text,
      ref jsonb,
      state text NOT NULL CHECK (state IN ('OPEN','CLAIMED','RESOLVED')),
      created_at bigint NOT NULL,
      claimed_by text,
      claimed_at bigint,
      resolved_by text,
      resolved_at bigint,
      resolution text
    );

    CREATE INDEX interventions_organization_idx ON automation.interventions(organization_id);
    CREATE INDEX interventions_task_idx ON automation.interventions(organization_id, task_id);
  `);

  // Row-Level Security: defense in depth, same pattern as automation.approvals.
  // UNVERIFIED outside CI.
  await pgm.db.query(`
    ALTER TABLE automation.interventions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.interventions FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_interventions ON automation.interventions
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP TABLE IF EXISTS automation.interventions");
}
