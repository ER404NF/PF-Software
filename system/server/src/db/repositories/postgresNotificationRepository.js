import crypto from "node:crypto";
import { encryptNotificationBody, decryptNotificationBody } from "../../accountNotificationStore.js";
import { assertNotificationRepository } from "../../persistence/notificationRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSafeNotification(row) {
  if (!row) return null;
  return {
    id: row.id, to: row.to_email, from: row.from_email, subject: row.subject,
    ...(row.body !== null ? { body: row.body } : {}), kind: row.kind,
    deliveryState: row.delivery_state, attemptCount: row.attempt_count,
    attemptCycleCount: row.attempt_cycle_count, manualRetryCount: row.manual_retry_count,
    lastManualRetryAt: iso(row.last_manual_retry_at),
    nextAttemptAt: iso(row.next_attempt_at), sentAt: iso(row.sent_at),
    permanentFailureAt: iso(row.permanent_failure_at), reconciliationAt: iso(row.reconciliation_at),
    lastFailureCategory: row.last_failure_category, createdAt: iso(row.created_at),
  };
}

function toWorkerNotification(row) {
  const safe = toSafeNotification(row);
  return safe ? { ...safe, workerOrganizationId: row.organization_id } : null;
}

function legacyMessage({ fullName, username, status, recoveryToken }) {
  const accepted = status === "approved";
  const rejected = status === "rejected";
  const recovery = status === "recovery";
  const received = status === "received";
  if (!accepted && !rejected && !recovery && !received) throw new Error("unsupported account notification status");
  return {
    kind: recovery ? "account_recovery" : `account_${status}`,
    subject: recovery ? "Phone Farm account recovery"
      : received ? "Your Phone Farm application was received"
        : accepted ? "Your Phone Farm account was accepted" : "Your Phone Farm account application was not accepted",
    body: recovery
      ? `Hello ${fullName}, use this one-time recovery token within 30 minutes: ${recoveryToken}`
      : received
        ? `Hello ${fullName}, we've received your application (${username}) to join Phone Farm. Your onboarding is being reviewed, and you'll be notified as soon as a decision is made.`
        : accepted
          ? `Hello ${fullName}, your Phone Farm account (${username}) was accepted. You can now sign in and complete two-factor setup.`
          : `Hello ${fullName}, your Phone Farm account application (${username}) was not accepted.`,
    sensitive: recovery,
  };
}

export async function createPostgresNotificationRepository(pool, {
  now = () => new Date().toISOString(), companyEmail = null, encryptionKey = null,
} = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;
  const withOrg = fn => withTransaction(pool, fn, { organizationId });

  async function byId(client, id, targetOrganizationId = organizationId) {
    const result = await client.query(
      "SELECT * FROM automation.account_notifications WHERE id = $1 AND organization_id = $2", [id, targetOrganizationId],
    );
    return result.rows[0] ?? null;
  }

  async function setStateIfCurrentlyIn(client, id, expectedStates, nextState) {
    const result = await client.query(
      `UPDATE automation.account_notifications SET delivery_state = $1
       WHERE id = $2 AND organization_id = $3 AND delivery_state = ANY($4::text[]) RETURNING *`,
      [nextState, id, organizationId, expectedStates],
    );
    return toSafeNotification(result.rows[0] ?? await byId(client, id));
  }

  async function workerOrganizationIds(id = null) {
    if (id) {
      const result = await pool.query(
        "SELECT organization_id FROM automation.account_notifications WHERE id = $1", [id],
      );
      return result.rows.map(row => row.organization_id);
    }
    const result = await pool.query("SELECT id FROM identity.organizations WHERE status = 'active' ORDER BY id");
    return result.rows.map(row => row.id);
  }

  function content(row) {
    const securePayload = typeof row.secure_payload === "string" ? JSON.parse(row.secure_payload) : row.secure_payload;
    return {
      ...toWorkerNotification(row),
      body: securePayload ? decryptNotificationBody(securePayload, encryptionKey) : row.body,
      ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    };
  }

  async function queueRow(client, input, targetOrganizationId = organizationId) {
    const message = input.kind
      ? { kind: input.kind, subject: input.subject, body: input.body, sensitive: input.sensitive === true }
      : legacyMessage(input);
    if (!message.kind || !message.subject || typeof message.body !== "string") {
      throw new Error("notification kind, subject, and body are required");
    }
    const securePayload = message.sensitive ? encryptNotificationBody(message.body, encryptionKey) : null;
    if (message.sensitive && !securePayload) throw new Error(message.kind === "account_recovery"
      ? "secure recovery notification storage is not configured"
      : "secure notification storage is not configured");
    const deliveryState = input.holdForCommit ? "pending_account_commit"
      : companyEmail ? "queued" : "awaiting_sender_configuration";
    const result = await client.query(
      `INSERT INTO automation.account_notifications
         (id, organization_id, to_email, from_email, subject, body, secure_payload, kind,
          delivery_state, created_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET
         idempotency_key = EXCLUDED.idempotency_key,
         delivery_state = CASE
           WHEN automation.account_notifications.delivery_state = 'aborted_account_change'
             AND EXCLUDED.delivery_state = 'pending_account_commit'
           THEN 'pending_account_commit'
           ELSE automation.account_notifications.delivery_state
         END
       RETURNING *`,
      [crypto.randomUUID(), targetOrganizationId, input.to, companyEmail, message.subject,
        message.sensitive ? null : message.body, message.sensitive ? JSON.stringify(securePayload) : null,
        message.kind, deliveryState, now(), input.idempotencyKey || null],
    );
    return toWorkerNotification(result.rows[0]);
  }

  return assertNotificationRepository({
    async queue(input) {
      return withOrg(client => queueRow(client, input));
    },

    async queueInTransaction(input, client, { organizationId: targetOrganizationId = organizationId } = {}) {
      if (!client?.query) throw new TypeError("queueInTransaction requires a transaction client");
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [targetOrganizationId]);
      return queueRow(client, input, targetOrganizationId);
    },

    async list() {
      return withOrg(async client => {
        const result = await client.query(
          "SELECT * FROM automation.account_notifications WHERE organization_id = $1 ORDER BY created_at DESC", [organizationId],
        );
        return result.rows.map(toSafeNotification);
      });
    },
    async deliveryContent(id) {
      return withOrg(async client => {
        const row = await byId(client, id);
        return row ? content(row) : null;
      });
    },
    async markCommitted(id) {
      return withOrg(client => setStateIfCurrentlyIn(client, id, ["pending_account_commit"], companyEmail ? "queued" : "awaiting_sender_configuration"));
    },
    async markAborted(id) {
      return withOrg(client => setStateIfCurrentlyIn(client, id, ["pending_account_commit"], "aborted_account_change"));
    },
    async markSent(id) {
      return withOrg(client => setStateIfCurrentlyIn(client, id, ["queued", "retry_scheduled", "failed"], "sent"));
    },
    async markFailed(id) {
      return withOrg(client => setStateIfCurrentlyIn(client, id, ["queued", "retry_scheduled"], "failed"));
    },

    async claimNext({ maxAttempts = 5, leaseMs = 60_000, id = null, organizationId: requestedOrganizationId = null } = {}) {
      // This is the trusted background-worker path. It discovers tenants
      // without exposing cross-tenant rows, then applies each claim inside
      // that tenant's RLS context. Tenant-facing list/retry methods below
      // remain scoped to the repository's default organization.
      const organizationIds = requestedOrganizationId ? [requestedOrganizationId] : await workerOrganizationIds(id);
      for (const targetOrganizationId of organizationIds) {
        const claim = await withTransaction(pool, async client => {
        const result = await client.query(
          `WITH candidate AS (
             SELECT id FROM automation.account_notifications
             WHERE organization_id = $1 AND ($2::uuid IS NULL OR id = $2) AND attempt_cycle_count < $3
               AND (delivery_state = 'queued'
                 OR (delivery_state = 'awaiting_sender_configuration' AND $4::boolean)
                 OR (delivery_state IN ('retry_scheduled', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
                 OR (delivery_state = 'sending' AND claim_expires_at <= now()))
             ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE automation.account_notifications AS n
             SET delivery_state = 'sending', attempt_count = n.attempt_count + 1,
                 attempt_cycle_count = n.attempt_cycle_count + 1,
                 last_attempt_at = now(), next_attempt_at = NULL,
                 claim_token = $5, claim_expires_at = now() + ($6::bigint * interval '1 millisecond'),
                 from_email = COALESCE(n.from_email, $7)
           FROM candidate WHERE n.id = candidate.id RETURNING n.*`,
          [targetOrganizationId, id, maxAttempts, Boolean(companyEmail), crypto.randomUUID(), leaseMs, companyEmail],
        );
        return result.rows[0] ? content(result.rows[0]) : null;
        }, { organizationId: targetOrganizationId });
        if (claim) return claim;
      }
      return null;
    },

    async completeClaim(id, claimToken, {
      sent, nextAttemptAt = null, permanent = false, failureCategory = null, workerOrganizationId = null,
    } = {}) {
      const [discoveredOrganizationId] = workerOrganizationId ? [] : await workerOrganizationIds(id);
      const targetOrganizationId = workerOrganizationId || discoveredOrganizationId;
      if (!targetOrganizationId) return null;
      return withTransaction(pool, async client => {
        const nextState = sent ? "sent" : permanent ? "permanently_failed" : "retry_scheduled";
        const result = await client.query(
          `UPDATE automation.account_notifications
             SET delivery_state = $1, claim_token = NULL, claim_expires_at = NULL,
                 next_attempt_at = $2, sent_at = CASE WHEN $3 THEN now() ELSE sent_at END,
                 permanent_failure_at = CASE WHEN $4 THEN now() ELSE permanent_failure_at END,
                 last_failure_category = $5
           WHERE id = $6 AND organization_id = $7 AND delivery_state = 'sending' AND claim_token = $8
           RETURNING *`,
          [nextState, sent || permanent ? null : nextAttemptAt, Boolean(sent), Boolean(permanent),
            sent ? null : failureCategory, id, targetOrganizationId, claimToken],
        );
        return toSafeNotification(result.rows[0] ?? await byId(client, id, targetOrganizationId));
      }, { organizationId: targetOrganizationId });
    },

    async retryEligible({ id = null } = {}) {
      return withOrg(async client => {
        const result = await client.query(
          `UPDATE automation.account_notifications
             SET delivery_state = $1, next_attempt_at = NULL, claim_token = NULL, claim_expires_at = NULL,
                 attempt_cycle_count = 0, manual_retry_count = manual_retry_count + 1,
                 last_manual_retry_at = now()
           WHERE organization_id = $2 AND ($3::uuid IS NULL OR id = $3)
             AND delivery_state IN ('retry_scheduled','permanently_failed','failed','awaiting_sender_configuration','needs_reconciliation')`,
          [companyEmail ? "queued" : "awaiting_sender_configuration", organizationId, id],
        );
        return result.rowCount;
      });
    },
    canSecureRecovery() { return typeof encryptionKey === "string" && Boolean(encryptionKey); },
  });
}
