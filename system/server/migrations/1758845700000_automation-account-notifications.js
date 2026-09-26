// M05, fifth domain: account-lifecycle notifications (accountNotificationStore.js).
// Mirrors the file-backed store's exact fields plus organization_id, scoped to
// the single default organization per the owner decision in
// M05_DURABLE_DOMAIN_MIGRATION.md.
//
// `to_email`/`from_email` are plain text, not identity.users FKs — the
// recipient is frequently a not-yet-created applicant, not an existing
// platform user, so there is nothing to reference.
//
// `body`/`secure_payload` are mutually exclusive per the store's own
// `queue()` logic: non-recovery notifications get a plaintext `body`,
// recovery notifications get an encrypted `secure_payload` (AES-256-GCM
// ciphertext + iv + tag, produced by accountNotificationStore.js's
// encryptNotificationBody()) and no plaintext body at rest — this schema
// keeps that guarantee rather than flattening both into one column.
//
// Deliberately unverified outside CI — see the identity-and-organizations
// migration's own header for why.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    CREATE TABLE automation.account_notifications (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES identity.organizations(id),
      to_email text NOT NULL,
      from_email text,
      subject text NOT NULL,
      body text,
      secure_payload jsonb,
      kind text NOT NULL CHECK (kind IN ('account_approved', 'account_rejected', 'account_recovery')),
      delivery_state text NOT NULL CHECK (delivery_state IN (
        'pending_account_commit', 'queued', 'awaiting_sender_configuration', 'sent', 'failed', 'aborted_account_change'
      )),
      created_at timestamptz NOT NULL,
      CHECK ((kind = 'account_recovery' AND body IS NULL AND secure_payload IS NOT NULL)
          OR (kind <> 'account_recovery' AND body IS NOT NULL AND secure_payload IS NULL))
    );

    CREATE INDEX account_notifications_organization_idx ON automation.account_notifications(organization_id);
    CREATE INDEX account_notifications_created_at_idx ON automation.account_notifications(organization_id, created_at DESC);
  `);

  await pgm.db.query(`
    ALTER TABLE automation.account_notifications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE automation.account_notifications FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_account_notifications ON automation.account_notifications
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
  `);
}

export async function down(pgm) {
  await pgm.db.query("DROP TABLE IF EXISTS automation.account_notifications");
}
