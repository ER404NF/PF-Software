// PostgreSQL-backed organization repository (M04 part 1). Not wired into
// any route yet — see docs/productionization/M04_ORGANIZATION_IDENTITY.md.
// Nothing here bypasses RLS decisions; it issues plain parameterized SQL and
// relies on the caller (a transaction from db/transaction.js, typically) to
// have set the right session/role context when one is required.

export function createOrganizationRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("organization repository requires a pg Pool or client");
  }

  return {
    // `runner` optionally overrides `pool` with a transaction client, so
    // callers composing a multi-step transaction (see
    // organizationIdentityService.js) can pass the same client through.
    async create({ slug, displayName, legalName = null, defaultTimezone = "UTC" }, runner = pool) {
      const result = await runner.query(
        `INSERT INTO identity.organizations (slug, display_name, legal_name, default_timezone)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [slug, displayName, legalName, defaultTimezone],
      );
      return result.rows[0];
    },

    async getById(id, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.organizations WHERE id = $1", [id]);
      return result.rows[0] ?? null;
    },

    async getBySlug(slug, runner = pool) {
      const result = await runner.query("SELECT * FROM identity.organizations WHERE slug = $1", [slug]);
      return result.rows[0] ?? null;
    },

    async list({ limit = 100, offset = 0 } = {}, runner = pool) {
      const result = await runner.query(
        "SELECT * FROM identity.organizations ORDER BY created_at DESC LIMIT $1 OFFSET $2",
        [limit, offset],
      );
      return result.rows;
    },

    async updateStatus(id, status, runner = pool) {
      const result = await runner.query(
        `UPDATE identity.organizations SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, status],
      );
      return result.rows[0] ?? null;
    },
  };
}
