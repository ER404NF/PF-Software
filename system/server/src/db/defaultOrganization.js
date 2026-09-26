// M05: per the recorded owner decision (see
// docs/productionization/M05_DURABLE_DOMAIN_MIGRATION.md), the existing
// single-tenant deployment's data is wrapped in one auto-created "default"
// organization rather than left tenant-less. This is an APPLICATION-level
// idempotent bootstrap (each install ensures its own default organization
// exists at first use), not a migration — a migration runs once per schema
// version across potentially many installs/environments; "does *this*
// install have its default organization row yet" is a per-runtime concern.

const DEFAULT_ORGANIZATION_SLUG = "default";
const DEFAULT_ORGANIZATION_DISPLAY_NAME = "Default Organization";

// Idempotent: safe to call on every server startup / repository
// construction. Returns the existing row if already created, otherwise
// creates it. Uses ON CONFLICT rather than a check-then-insert, so two
// processes racing to bootstrap the same fresh database can't both succeed
// at inserting and hit a duplicate-slug error.
export async function ensureDefaultOrganization(pool, {
  slug = DEFAULT_ORGANIZATION_SLUG, displayName = DEFAULT_ORGANIZATION_DISPLAY_NAME,
} = {}) {
  const result = await pool.query(
    `INSERT INTO identity.organizations (slug, display_name)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING *`,
    [slug, displayName],
  );
  return result.rows[0];
}

export { DEFAULT_ORGANIZATION_SLUG, DEFAULT_ORGANIZATION_DISPLAY_NAME };
