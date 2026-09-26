// M05: PostgreSQL-backed adapter satisfying the exact same notification
// repository contract (persistence/notificationRepository.js) as
// fileNotificationRepository.js — same methods, same return shapes, same
// "only advance a state that hasn't already moved on" semantics as the
// file-backed accountNotificationStore.js. Every row is scoped to the
// install's single default organization (see db/defaultOrganization.js and
// the owner decision it documents).

import crypto from "node:crypto";
import { encryptNotificationBody, decryptNotificationBody } from "../../accountNotificationStore.js";
import { assertNotificationRepository } from "../../persistence/notificationRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Mirrors accountNotificationStore.js's safeItem(): the row minus
// secure_payload, and minus body entirely for recovery notifications (which
// never had a plaintext body to begin with).
function toSafeNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    to: row.to_email,
    from: row.from_email,
    subject: row.subject,
    ...(row.body !== null ? { body: row.body } : {}),
    kind: row.kind,
    deliveryState: row.delivery_state,
    createdAt: iso(row.created_at),
  };
}

export async function createPostgresNotificationRepository(pool, {
  now = () => new Date().toISOString(),
  companyEmail = null,
  encryptionKey = null,
} = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  async function setStateIfCurrentlyIn(client, id, expectedState, nextState) {
    const current = await client.query(
      "SELECT * FROM automation.account_notifications WHERE id = $1 AND organization_id = $2",
      [id, organizationId],
    );
    if (current.rowCount === 0) return null;
    if (current.rows[0].delivery_state !== expectedState) return toSafeNotification(current.rows[0]);
    const result = await client.query(
      `UPDATE automation.account_notifications SET delivery_state = $1 WHERE id = $2 AND organization_id = $3 RETURNING *`,
      [nextState, id, organizationId],
    );
    return toSafeNotification(result.rows[0]);
  }

  return assertNotificationRepository({
    async queue({ to, fullName, username, status, recoveryToken = null, holdForCommit = false }) {
      return withOrg(async (client) => {
        const accepted = status === "approved";
        const rejected = status === "rejected";
        const recovery = status === "recovery";
        if (!accepted && !rejected && !recovery) throw new Error("unsupported account notification status");

        const subject = recovery ? "Phone Farm account recovery"
          : accepted ? "Your Phone Farm account was accepted" : "Your Phone Farm account application was not accepted";
        const body = recovery
          ? `Hello ${fullName}, use this one-time recovery token within 30 minutes: ${recoveryToken}`
          : accepted
            ? `Hello ${fullName}, your Phone Farm account (${username}) was accepted. You can now sign in and complete two-factor setup.`
            : `Hello ${fullName}, your Phone Farm account application (${username}) was not accepted.`;

        const securePayload = recovery ? encryptNotificationBody(body, encryptionKey) : null;
        if (recovery && !securePayload) throw new Error("secure recovery notification storage is not configured");

        const id = crypto.randomUUID();
        const kind = recovery ? "account_recovery" : `account_${status}`;
        const deliveryState = holdForCommit ? "pending_account_commit"
          : companyEmail ? "queued" : "awaiting_sender_configuration";
        const at = now();

        const result = await client.query(
          `INSERT INTO automation.account_notifications
             (id, organization_id, to_email, from_email, subject, body, secure_payload, kind, delivery_state, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [id, organizationId, to, companyEmail, subject, recovery ? null : body,
            recovery ? JSON.stringify(securePayload) : null, kind, deliveryState, at],
        );
        return toSafeNotification(result.rows[0]);
      });
    },

    async list() {
      return withOrg(async (client) => {
        const result = await client.query(
          `SELECT * FROM automation.account_notifications WHERE organization_id = $1 ORDER BY created_at DESC`,
          [organizationId],
        );
        return result.rows.map(toSafeNotification);
      });
    },

    async deliveryContent(id) {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT * FROM automation.account_notifications WHERE id = $1 AND organization_id = $2",
          [id, organizationId],
        );
        const row = result.rows[0];
        if (!row) return null;
        const body = row.kind === "account_recovery" ? decryptNotificationBody(row.secure_payload, encryptionKey) : row.body;
        return {
          id: row.id,
          to: row.to_email,
          from: row.from_email,
          subject: row.subject,
          kind: row.kind,
          deliveryState: row.delivery_state,
          createdAt: iso(row.created_at),
          body,
        };
      });
    },

    async markCommitted(id) {
      return withOrg((client) => setStateIfCurrentlyIn(
        client, id, "pending_account_commit", companyEmail ? "queued" : "awaiting_sender_configuration",
      ));
    },

    async markAborted(id) {
      return withOrg((client) => setStateIfCurrentlyIn(client, id, "pending_account_commit", "aborted_account_change"));
    },

    async markSent(id) {
      return withOrg((client) => setStateIfCurrentlyIn(client, id, "queued", "sent"));
    },

    async markFailed(id) {
      return withOrg((client) => setStateIfCurrentlyIn(client, id, "queued", "failed"));
    },

    canSecureRecovery() {
      return typeof encryptionKey === "string" && Boolean(encryptionKey);
    },
  });
}
