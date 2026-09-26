// M05, seventh domain: the append-only audit trail (auditLog.js). Mirrors
// its exact fields plus organization_id, scoped to the single default
// organization per the owner decision in M05_DURABLE_DOMAIN_MIGRATION.md.
//
// `operator`/`device_id` are plain text, not identity.users/device FKs —
// same precedent as approvals/interventions/assignments: audit events
// reference the file-backed operator/device systems today, and reconciling
// that with M04's user model is a separate decision this slice does not
// force. `detail` is jsonb, matching the file store's guarantee that
// whatever detail object a caller passes round-trips exactly (callers, not
// this layer, are responsible for redacting sensitive fields before
// logging — see auditLog.test.js's `type_text` case).
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE TABLE automation.audit_events (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES identity.organizations(id),
      at timestamptz NOT NULL,
      operator text,
      type text NOT NULL,
      device_id text,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    -- Supports listEvents()'s "newest first" ordering and its operator/device filters.
    CREATE INDEX audit_events_organization_at_idx ON automation.audit_events(organization_id, at DESC);
    CREATE INDEX audit_events_operator_idx ON automation.audit_events(organization_id, operator) WHERE operator IS NOT NULL;
    CREATE INDEX audit_events_device_idx ON automation.audit_events(organization_id, device_id) WHERE device_id IS NOT NULL;
  `);

  await pgm.db.query(`
    ALTER TABLE automation.audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.audit_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_audit_events ON automation.audit_events
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP TABLE IF EXISTS automation.audit_events");
}
