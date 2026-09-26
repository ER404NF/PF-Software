// M05 (durable domain migration), first domain: sites. Per the owner
// decision recorded in docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md,
// the existing single-tenant deployment's data is wrapped in one
// auto-created "default" organization (see db/defaultOrganization.js) rather
// than left tenant-less or requiring a real multi-tenant decision before any
// domain can be migrated at all.
//
// Mirrors the existing file-backed SiteStore's exact fields (system/server/
// src/siteStore.js) plus organization_id — site identity and its hashed
// enrollment token stay combined in one table, matching the M03 disagreement
// already recorded for the identity schema's own invitations/sessions design
// (a site/site_credentials split is a later migration-design decision, not
// something this slice changes). The site id itself is the primary key (a
// human-chosen slug like "downtown-office", exactly as SiteStore uses it
// today) — not a fresh UUID — so no translation layer is needed between the
// existing repository contract and this table.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE SCHEMA IF NOT EXISTS fleet;

    CREATE TABLE fleet.sites (
      id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$'),
      organization_id uuid NOT NULL REFERENCES identity.organizations(id),
      name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
      time_zone text NOT NULL,
      token_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      rotated_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz
    );

    CREATE INDEX sites_organization_idx ON fleet.sites(organization_id);
  `);

  // Row-Level Security: defense in depth, same pattern as the identity
  // schema's tenant-scoped tables (DATABASE_GAP_ANALYSIS.md §8/§9).
  // UNVERIFIED: see the identity-and-organizations migration's own RLS
  // comment for why this cannot be treated as proven outside CI.
  await pgm.db.query(`
    ALTER TABLE fleet.sites ENABLE ROW LEVEL SECURITY;
    ALTER TABLE fleet.sites FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_sites ON fleet.sites
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP SCHEMA IF EXISTS fleet CASCADE");
}
