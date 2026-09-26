// First database slice (M03, per docs/productionization/DATABASE_GAP_ANALYSIS.md
// "First database slice recommendation"): the identity/organization schema
// only. No application code reads or writes this schema yet — that is M04.
//
// Deliberately NOT run against a live database by the author of this
// migration (no PostgreSQL is available in that environment). It is
// exercised for real by .github/workflows/db-migrations.yml against an
// ephemeral PostgreSQL service container in CI. Do not treat this file as
// verified until that workflow has run green at least once.
//
// Deviations from PF_SOFTWARE_DATABASE_LOGICAL_PHYSICAL_SCHEMA.md, matching
// DATABASE_GAP_ANALYSIS.md's "Schema disagreements and adjustments" §1:
// uses core gen_random_uuid() (built into PostgreSQL 13+, no extension
// required) instead of requiring PostgreSQL 18's uuidv7() — so this does not
// force a PostgreSQL 18 deployment requirement.
//
// Database roles (pf_owner/pf_app/pf_migrator/...) are deliberately NOT
// created by this migration — role topology is an environment/deployment
// decision (managed PostgreSQL providers vary in what they allow), not
// portable schema. See docs/productionization/M03_POSTGRES_FOUNDATION.md.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE SCHEMA IF NOT EXISTS identity;

    CREATE TABLE identity.organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL,
        display_name text NOT NULL,
        legal_name text,
        status text NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','suspended','deleting','deleted')),
        default_timezone text NOT NULL DEFAULT 'UTC',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deletion_requested_at timestamptz,
        deleted_at timestamptz,
        UNIQUE (slug)
    );

    CREATE TABLE identity.workspaces (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES identity.organizations(id),
        name text NOT NULL,
        slug text NOT NULL,
        status text NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','archived')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, slug)
    );

    CREATE TABLE identity.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status text NOT NULL DEFAULT 'active'
            CHECK (status IN ('pending','active','suspended','deleting','deleted')),
        display_name text,
        password_hash text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deletion_requested_at timestamptz,
        deleted_at timestamptz
    );

    CREATE TABLE identity.user_emails (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
        email text NOT NULL,
        normalized_email text NOT NULL,
        is_primary boolean NOT NULL DEFAULT false,
        verified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (normalized_email)
    );

    CREATE UNIQUE INDEX user_one_primary_email
    ON identity.user_emails(user_id)
    WHERE is_primary;

    CREATE TABLE identity.memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES identity.organizations(id),
        user_id uuid NOT NULL REFERENCES identity.users(id),
        status text NOT NULL DEFAULT 'active'
            CHECK (status IN ('invited','active','suspended','removed')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, user_id)
    );

    CREATE TABLE identity.roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid REFERENCES identity.organizations(id),
        key text NOT NULL,
        name text NOT NULL,
        is_system_template boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX roles_org_key_unique
    ON identity.roles (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

    CREATE TABLE identity.permissions (
        key text PRIMARY KEY,
        description text NOT NULL
    );

    CREATE TABLE identity.role_permissions (
        role_id uuid NOT NULL REFERENCES identity.roles(id) ON DELETE CASCADE,
        permission_key text NOT NULL REFERENCES identity.permissions(key) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_key)
    );

    CREATE TABLE identity.membership_roles (
        membership_id uuid NOT NULL REFERENCES identity.memberships(id) ON DELETE CASCADE,
        role_id uuid NOT NULL REFERENCES identity.roles(id) ON DELETE CASCADE,
        PRIMARY KEY (membership_id, role_id)
    );

    CREATE TABLE identity.invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES identity.organizations(id),
        email_normalized text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        invited_by_user_id uuid REFERENCES identity.users(id),
        expires_at timestamptz NOT NULL,
        accepted_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE identity.sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        last_seen_at timestamptz,
        revoked_at timestamptz,
        ip inet,
        user_agent text,
        device_label text
    );

    CREATE INDEX sessions_user_active_idx
    ON identity.sessions(user_id, expires_at)
    WHERE revoked_at IS NULL;

    CREATE TABLE identity.mfa_methods (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
        method_type text NOT NULL CHECK (method_type IN ('totp','webauthn')),
        label text,
        secret_ref text,
        credential_data jsonb,
        verified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz
    );

    CREATE TABLE identity.recovery_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
        code_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        consumed_at timestamptz,
        UNIQUE (user_id, code_hash)
    );

    CREATE TABLE identity.security_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid REFERENCES identity.users(id) ON DELETE CASCADE,
        organization_id uuid REFERENCES identity.organizations(id),
        event_type text NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        ip inet,
        user_agent text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX security_events_user_time_idx
    ON identity.security_events(user_id, occurred_at DESC);
  `);

  // Row-Level Security: defense in depth, per DATABASE_GAP_ANALYSIS.md §8/§9.
  // Tenant-scoped tables carry organization_id and are restricted to
  // app.current_organization_id, set transaction-locally by trusted server
  // middleware (M04, not yet built). Global-reference tables (permissions)
  // and platform-admin-only tables intentionally have no policy here.
  //
  // UNVERIFIED: no cross-tenant negative test has run against these policies
  // outside .github/workflows/db-migrations.yml. Do not treat RLS as proven
  // correct until that workflow's tenant-isolation test is green.
  pgm.sql(`
    ALTER TABLE identity.workspaces ENABLE ROW LEVEL SECURITY;
    ALTER TABLE identity.workspaces FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_workspaces ON identity.workspaces
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

    ALTER TABLE identity.memberships ENABLE ROW LEVEL SECURITY;
    ALTER TABLE identity.memberships FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_memberships ON identity.memberships
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

    ALTER TABLE identity.invitations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE identity.invitations FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_invitations ON identity.invitations
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

    ALTER TABLE identity.roles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE identity.roles FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_roles ON identity.roles
      FOR ALL
      USING (organization_id IS NULL OR organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id IS NULL OR organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

    ALTER TABLE identity.security_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE identity.security_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_security_events ON identity.security_events
      FOR ALL
      USING (organization_id IS NULL OR organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id IS NULL OR organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
  // identity.users, identity.user_emails, identity.sessions, identity.mfa_methods,
  // and identity.recovery_codes are intentionally NOT organization-scoped: a
  // user is a global identity that can belong to multiple organizations
  // (ADR-0006/ADR-0007), so tenant isolation for those is enforced through
  // the membership relationship at the application layer, not row-level
  // organization_id filtering on the user record itself.
}

export async function down(pgm) {
  pgm.sql(`DROP SCHEMA IF EXISTS identity CASCADE;`);
}
