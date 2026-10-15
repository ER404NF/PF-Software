// Durable notification leases, retry scheduling, and lifecycle idempotency.
// This is intentionally forward-only relative to the already-shipped
// 1758845700000 migration.

export const shorthands = undefined;

export async function up(pgm) {
  await pgm.db.query(`
    ALTER TABLE automation.account_notifications
      ADD COLUMN idempotency_key text,
      ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      ADD COLUMN attempt_cycle_count integer NOT NULL DEFAULT 0 CHECK (attempt_cycle_count >= 0),
      ADD COLUMN manual_retry_count integer NOT NULL DEFAULT 0 CHECK (manual_retry_count >= 0),
      ADD COLUMN last_manual_retry_at timestamptz,
      ADD COLUMN next_attempt_at timestamptz,
      ADD COLUMN claim_token uuid,
      ADD COLUMN claim_expires_at timestamptz,
      ADD COLUMN last_attempt_at timestamptz,
      ADD COLUMN sent_at timestamptz,
      ADD COLUMN permanent_failure_at timestamptz,
      ADD COLUMN reconciliation_at timestamptz,
      ADD COLUMN last_failure_category text;

    ALTER TABLE automation.account_notifications
      DROP CONSTRAINT IF EXISTS account_notifications_kind_check,
      DROP CONSTRAINT IF EXISTS account_notifications_delivery_state_check,
      DROP CONSTRAINT IF EXISTS account_notifications_check;

    ALTER TABLE automation.account_notifications
      ADD CONSTRAINT account_notifications_kind_check CHECK (kind IN (
        'account_received', 'account_approved', 'account_rejected', 'account_recovery',
        'invitation', 'email_verification', 'password_reset'
      )),
      ADD CONSTRAINT account_notifications_delivery_state_check CHECK (delivery_state IN (
        'pending_account_commit', 'queued', 'awaiting_sender_configuration',
        'sending', 'retry_scheduled', 'sent', 'permanently_failed',
        'needs_reconciliation', 'failed', 'aborted_account_change'
      )),
      ADD CONSTRAINT account_notifications_payload_check CHECK (
        (body IS NULL) <> (secure_payload IS NULL)
      ),
      ADD CONSTRAINT account_notifications_claim_check CHECK (
        (claim_token IS NULL AND claim_expires_at IS NULL)
        OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
      );

    CREATE UNIQUE INDEX account_notifications_idempotency_idx
      ON automation.account_notifications(organization_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX account_notifications_delivery_idx
      ON automation.account_notifications(organization_id, delivery_state, next_attempt_at, claim_expires_at, created_at);
  `);
}

export async function down(pgm) {
  void pgm;
  throw new Error("Migration 1758851100000 is intentionally irreversible: reverting would discard lifecycle notification audit and retry data. Restore from a verified backup instead.");
}
