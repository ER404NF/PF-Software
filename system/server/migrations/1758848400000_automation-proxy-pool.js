// M05, eighth domain: the shared proxy pool (proxyPool.js). Mirrors its
// exact fields plus organization_id, scoped to the single default
// organization per the owner decision in M05_DURABLE_DOMAIN_MIGRATION.md.
//
// id keeps the file store's own "px_<uuid>" text format rather than
// switching to a bare uuid column, since callers already treat proxy ids as
// opaque prefixed strings (routes, the public shape, tests).
//
// password_encrypted is text, not jsonb — proxyPool.js's own encryption
// helper (twoFactor.js's encryptTotpSecret/decryptTotpSecret, the same
// AES-256-GCM helper TOTP secrets use) already serializes to one
// delimited "iv.tag.ciphertext" string, so the column just stores that
// string unchanged.
//
// A partial unique index enforces the "a device holds at most one leased
// proxy" invariant assignProxyToDevice() already maintains in application
// code — a real database-level backstop for the same rule, not a
// duplicate implementation of it.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE TABLE automation.proxy_pool (
      id text PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES identity.organizations(id),
      provider text NOT NULL,
      protocol text NOT NULL CHECK (protocol IN ('http', 'https', 'socks5')),
      host text NOT NULL,
      port integer NOT NULL,
      username text NOT NULL,
      password_encrypted text NOT NULL,
      country text NOT NULL,
      label text NOT NULL,
      leased_to_device_id text,
      health jsonb,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );

    CREATE INDEX proxy_pool_organization_idx ON automation.proxy_pool(organization_id);
    CREATE UNIQUE INDEX proxy_pool_device_lease_idx
      ON automation.proxy_pool(organization_id, leased_to_device_id)
      WHERE leased_to_device_id IS NOT NULL;
  `);

  await pgm.db.query(`
    ALTER TABLE automation.proxy_pool ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.proxy_pool FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_proxy_pool ON automation.proxy_pool
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP TABLE IF EXISTS automation.proxy_pool");
}
