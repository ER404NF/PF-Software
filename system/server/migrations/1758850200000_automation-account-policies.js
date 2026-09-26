// M05, tenth domain: per-account action policy overrides (policyStore.js).
// Mirrors its exact fields plus organization_id, scoped to the single
// default organization per the owner decision in
// M05_DURABLE_DOMAIN_MIGRATION.md.
//
// account_id is plain text, not a foreign key — same precedent as every
// other automation.* table's operator/account fields, since accounts here
// are platform research accounts (research.config.json), not
// identity.users.
//
// Unlike every prior automation.* table, this one is read from a
// synchronous hot path (actionPolicy.js's validateAction(), called inline
// from the task queue's dispatch predicate) that cannot await a query per
// read — see persistence/policyRepository.js's header and
// server/src/syncCache.js for why the adapter that reads this table keeps
// a synchronously-readable in-memory cache instead of querying per call.
// That constraint shapes the adapter, not this schema, which is an
// ordinary relational mirror of the override map.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE TABLE automation.account_policies (
      organization_id uuid NOT NULL REFERENCES identity.organizations(id),
      account_id text NOT NULL,
      action text NOT NULL,
      value text NOT NULL CHECK (value IN ('ALLOW_AUTONOMOUS', 'REQUIRE_APPROVAL', 'DISABLED')),
      changed_by text,
      changed_at timestamptz NOT NULL,
      PRIMARY KEY (organization_id, account_id, action)
    );

    CREATE INDEX account_policies_organization_idx ON automation.account_policies(organization_id);
  `);

  await pgm.db.query(`
    ALTER TABLE automation.account_policies ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.account_policies FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_account_policies ON automation.account_policies
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP TABLE IF EXISTS automation.account_policies");
}
