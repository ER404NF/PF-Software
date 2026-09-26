// M05, fourth domain: assignments (ASSIGNMENTS.md). Mirrors the file-backed
// assignmentStore.js's exact fields plus organization_id, scoped to the
// single default organization per the owner decision in
// M05_DURABLE_DOMAIN_MIGRATION.md.
//
// assignee/created_by are plain text (operator username strings), not a
// foreign key to identity.users — same precedent already applied to
// approvals'/interventions' actor fields: assignments are tied to the
// file-backed authStore.js operator system today, and reconciling that with
// M04's user model is a separate, not-yet-made decision this slice does not
// force.
//
// start_at/end_at/created_at/updated_at/last_completed_at are real
// timestamptz columns (unlike approvals'/interventions' bigint epoch-ms
// choice) — the file contract already returns ISO strings for these, so the
// Postgres adapter explicitly re-serializes timestamptz values back to ISO
// strings rather than let the field type silently change what callers get.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE TABLE automation.assignments (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES identity.organizations(id),
      instructions text NOT NULL,
      assignee text NOT NULL,
      created_by text NOT NULL,
      device_id text,
      account_id text,
      start_at timestamptz,
      end_at timestamptz,
      exclusive boolean NOT NULL DEFAULT true,
      recurrence text NOT NULL CHECK (recurrence IN ('once','daily','weekly')),
      timezone text,
      occurrence integer NOT NULL DEFAULT 1,
      status text NOT NULL CHECK (status IN ('assigned','in_progress','completed','cancelled','expired')),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      last_completed_at timestamptz,
      history jsonb NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE INDEX assignments_organization_idx ON automation.assignments(organization_id);
    -- Supports assertNoOverlap()'s scan: active (non-terminal), exclusive,
    -- time-bounded assignments for this organization.
    CREATE INDEX assignments_overlap_scan_idx
      ON automation.assignments(organization_id, status)
      WHERE exclusive AND start_at IS NOT NULL;
  `);

  await pgm.db.query(`
    ALTER TABLE automation.assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.assignments FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_assignments ON automation.assignments
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP TABLE IF EXISTS automation.assignments");
}
