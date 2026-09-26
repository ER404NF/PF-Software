// M05, ninth domain: research runs/candidates/observations (researchStore.js
// — roadmap MS8; DATABASE_GAP_ANALYSIS.md's research_sessions/
// research_candidates/research_observations domain).
//
// Like the task queue snapshot, this is stored as one opaque jsonb blob per
// key rather than normalized into per-run/per-candidate rows — but here the
// key is (organization_id, workspace_id, account), mirroring the file
// store's own "one JSON file per workspace/account" shape exactly (a run's
// candidates, and the cross-run dedup index that spans every run for that
// account, are only ever read/written together as one unit — every
// operation in researchStore.js loads the whole account file, mutates it,
// and writes it back as a whole). Normalizing this into relational tables
// would require re-deriving the same cross-run dedup index either as a
// second denormalized structure (this migration's blob approach) or as
// live queries replacing findIndexEntry()/upsertIndexEntry() (a genuine
// redesign, not a port) — the blob keeps this a faithful mirror instead of
// a redesign, matching every other domain in this file.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE TABLE automation.research_accounts (
      organization_id uuid NOT NULL REFERENCES identity.organizations(id),
      workspace_id text NOT NULL,
      account text NOT NULL,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (organization_id, workspace_id, account)
    );

    CREATE INDEX research_accounts_organization_idx ON automation.research_accounts(organization_id);
  `);

  await pgm.db.query(`
    ALTER TABLE automation.research_accounts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.research_accounts FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_research_accounts ON automation.research_accounts
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP TABLE IF EXISTS automation.research_accounts");
}
