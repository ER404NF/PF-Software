// M05: PostgreSQL-backed adapter satisfying the exact same approval
// repository contract (persistence/approvalRepository.js) as
// fileApprovalRepository.js — same methods, same return shapes, same
// ApprovalError class/codes, same lazy-expire-on-every-operation semantics
// as the file-backed ApprovalStore. Every row is scoped to the install's
// single default organization (see db/defaultOrganization.js and the owner
// decision it documents).

import crypto from "node:crypto";
import { ApprovalError, APPROVAL_STATES, approvalFingerprint } from "../../approvalStore.js";
import { assertApprovalRepository } from "../../persistence/approvalRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

function toApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    taskId: row.task_id,
    deviceId: row.device_id,
    action: row.action,
    target: row.target,
    commentText: row.comment_text,
    requestedBy: row.requested_by,
    context: row.context,
    state: row.state,
    requestedAt: Number(row.requested_at),
    expiresAt: Number(row.expires_at),
    decidedAt: row.decided_at === null ? null : Number(row.decided_at),
    decidedBy: row.decided_by,
    reason: row.reason,
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
  };
}

export async function createPostgresApprovalRepository(pool, { now = () => Date.now(), ttlMs = 24 * 3_600_000 } = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  // Same lazy-expiration semantics as the file-backed store: any PENDING or
  // APPROVED row past its expiry becomes EXPIRED before the operation that
  // triggered this check proceeds.
  async function expireDue(client) {
    const at = now();
    await client.query(
      `UPDATE automation.approvals
       SET state = 'EXPIRED', decided_at = $2
       WHERE organization_id = $1 AND state IN ('PENDING', 'APPROVED') AND expires_at < $2`,
      [organizationId, at],
    );
  }

  return assertApprovalRepository({
    async request({ workspaceId, accountId, taskId = null, deviceId = null, action, target = null, commentText = null, requestedBy = null, context = null }) {
      return withOrg(async (client) => {
        await expireDue(client);
        const fingerprint = approvalFingerprint({ workspaceId, accountId, action, target, commentText });
        const open = await client.query(
          `SELECT * FROM automation.approvals
           WHERE organization_id = $1 AND fingerprint = $2 AND state IN ('PENDING', 'APPROVED')`,
          [organizationId, fingerprint],
        );
        if (open.rowCount > 0) return toApproval(open.rows[0]);

        const at = now();
        const id = `apr-${crypto.randomUUID()}`;
        const result = await client.query(
          `INSERT INTO automation.approvals
             (id, organization_id, fingerprint, workspace_id, account_id, task_id, device_id, action, target,
              comment_text, requested_by, context, state, requested_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING *`,
          [id, organizationId, fingerprint, workspaceId, accountId, taskId, deviceId, action, target,
            commentText, requestedBy, context ? JSON.stringify(context) : null, APPROVAL_STATES.PENDING, at, at + ttlMs],
        );
        return toApproval(result.rows[0]);
      });
    },

    async decide(id, { decision, decidedBy = null, reason = null }) {
      return withOrg(async (client) => {
        await expireDue(client);
        const existing = await client.query("SELECT * FROM automation.approvals WHERE id = $1 AND organization_id = $2", [id, organizationId]);
        const approval = existing.rows[0];
        if (!approval) throw new ApprovalError("Unknown approval.", "unknown_approval");
        if (approval.state !== APPROVAL_STATES.PENDING) {
          throw new ApprovalError(`This request is already ${approval.state.toLowerCase()}.`, "not_pending");
        }
        if (!["approve", "reject"].includes(decision)) throw new ApprovalError("Decision must be approve or reject.", "bad_decision");

        const at = now();
        const nextState = decision === "approve" ? APPROVAL_STATES.APPROVED : APPROVAL_STATES.REJECTED;
        const nextExpiresAt = nextState === APPROVAL_STATES.APPROVED ? at + ttlMs : approval.expires_at;
        const truncatedReason = typeof reason === "string" ? reason.slice(0, 300) : null;
        const result = await client.query(
          `UPDATE automation.approvals
           SET state = $2, decided_at = $3, decided_by = $4, reason = $5, expires_at = $6
           WHERE id = $1
           RETURNING *`,
          [id, nextState, at, decidedBy, truncatedReason, nextExpiresAt],
        );
        return toApproval(result.rows[0]);
      });
    },

    async findApproved(subject) {
      return withOrg(async (client) => {
        await expireDue(client);
        const fingerprint = approvalFingerprint(subject);
        const result = await client.query(
          "SELECT * FROM automation.approvals WHERE organization_id = $1 AND fingerprint = $2 AND state = $3",
          [organizationId, fingerprint, APPROVAL_STATES.APPROVED],
        );
        return toApproval(result.rows[0]) ?? null;
      });
    },

    async consume(id) {
      return withOrg(async (client) => {
        await expireDue(client);
        const at = now();
        const result = await client.query(
          `UPDATE automation.approvals
           SET state = $3, consumed_at = $2
           WHERE id = $1 AND organization_id = $4 AND state = $5
           RETURNING *`,
          [id, at, APPROVAL_STATES.CONSUMED, organizationId, APPROVAL_STATES.APPROVED],
        );
        return toApproval(result.rows[0]) ?? null;
      });
    },

    async get(id) {
      return withOrg(async (client) => {
        await expireDue(client);
        const result = await client.query("SELECT * FROM automation.approvals WHERE id = $1 AND organization_id = $2", [id, organizationId]);
        return toApproval(result.rows[0]) ?? null;
      });
    },

    async list({ workspaceId = null, states = null } = {}) {
      return withOrg(async (client) => {
        await expireDue(client);
        const result = await client.query(
          `SELECT * FROM automation.approvals
           WHERE organization_id = $1
             AND ($2::text IS NULL OR workspace_id = $2)
             AND ($3::text[] IS NULL OR state = ANY($3))
           ORDER BY requested_at DESC`,
          [organizationId, workspaceId, states],
        );
        return result.rows.map(toApproval);
      });
    },
  });
}
