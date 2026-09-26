// M04 part 5: a single generic table backs both email verification and
// password reset — both are "prove control of this email/account, once,
// within a time window" flows with near-identical mechanics (generate a
// hashed token, email it, verify it, mark something, single-use, expiring).
// Neither PF_SOFTWARE_DATABASE_LOGICAL_PHYSICAL_SCHEMA.md §7.1 nor
// DATABASE_GAP_ANALYSIS.md's reconciliation named a table for this, so this
// is new, not a deviation from something already specified.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE TABLE identity.email_action_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
      purpose text NOT NULL CHECK (purpose IN ('verify_email', 'password_reset')),
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pgm.db.query(`
    CREATE INDEX email_action_tokens_user_purpose_idx
    ON identity.email_action_tokens(user_id, purpose)
    WHERE consumed_at IS NULL
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP TABLE IF EXISTS identity.email_action_tokens");
}
