// M05: PostgreSQL-backed adapter satisfying the exact same intervention
// repository contract (persistence/interventionRepository.js) as
// fileInterventionRepository.js — same methods, same return shapes, same
// plain-Error messages as the file-backed InterventionQueue (it has no
// custom error class, unlike ApprovalStore/SiteStore). Every row is scoped
// to the install's single default organization (see
// db/defaultOrganization.js and the owner decision it documents).
//
// Deliberately does not replicate InterventionQueue's own _trim() (bounding
// RESOLVED items to cap JSON file size) — see the automation-interventions
// migration's own comment for why.

import crypto from "node:crypto";
import { classifyIntervention } from "../../interventionQueue.js";
import { assertInterventionRepository } from "../../persistence/interventionRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

function toIntervention(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    deviceId: row.device_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    platform: row.platform,
    kind: row.kind,
    reason: row.reason,
    ref: row.ref,
    state: row.state,
    createdAt: Number(row.created_at),
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    resolution: row.resolution,
  };
}

export async function createPostgresInterventionRepository(pool, { now = () => Date.now() } = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  return assertInterventionRepository({
    // One open item per task and kind — a worker that keeps handing off the
    // same problem does not bury the queue, matching the file store exactly.
    async open({ taskId, deviceId = null, accountId = null, workspaceId = null, platform = null, kind = null, reason = "", ref = null }) {
      const resolvedKind = kind ?? classifyIntervention(reason);
      return withOrg(async (client) => {
        const existing = await client.query(
          `SELECT * FROM automation.interventions
           WHERE organization_id = $1 AND task_id = $2 AND kind = $3 AND state != 'RESOLVED'`,
          [organizationId, taskId, resolvedKind],
        );
        if (existing.rowCount > 0) return toIntervention(existing.rows[0]);

        const id = `int-${crypto.randomUUID()}`;
        const result = await client.query(
          `INSERT INTO automation.interventions
             (id, organization_id, task_id, device_id, account_id, workspace_id, platform, kind, reason, ref, state, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'OPEN', $11)
           RETURNING *`,
          [id, organizationId, taskId, deviceId, accountId, workspaceId, platform, resolvedKind,
            String(reason).slice(0, 300), ref === null ? null : JSON.stringify(ref), now()],
        );
        return toIntervention(result.rows[0]);
      });
    },

    async claim(id, by) {
      return withOrg(async (client) => {
        const existing = await client.query("SELECT * FROM automation.interventions WHERE id = $1 AND organization_id = $2", [id, organizationId]);
        const item = existing.rows[0];
        if (!item) throw new Error("Unknown intervention.");
        if (item.state === "RESOLVED") throw new Error("That intervention is already resolved.");
        if (item.state === "CLAIMED" && item.claimed_by !== by) throw new Error(`Already claimed by ${item.claimed_by}.`);
        const result = await client.query(
          `UPDATE automation.interventions SET state = 'CLAIMED', claimed_by = $2, claimed_at = $3 WHERE id = $1 RETURNING *`,
          [id, by, now()],
        );
        return toIntervention(result.rows[0]);
      });
    },

    async resolve(id, { by = "system", resolution = null } = {}) {
      return withOrg(async (client) => {
        const existing = await client.query("SELECT * FROM automation.interventions WHERE id = $1 AND organization_id = $2", [id, organizationId]);
        const item = existing.rows[0];
        if (!item) throw new Error("Unknown intervention.");
        if (item.state === "RESOLVED") return toIntervention(item);
        const result = await client.query(
          `UPDATE automation.interventions
           SET state = 'RESOLVED', resolved_by = $2, resolved_at = $3, resolution = $4
           WHERE id = $1
           RETURNING *`,
          [id, by, now(), resolution ? String(resolution).slice(0, 300) : null],
        );
        return toIntervention(result.rows[0]);
      });
    },

    // Closes every open item for a task at once — when a task moves on by
    // itself (resumed, cancelled, finished), matching the file store.
    async resolveForTask(taskId, { by = "system", resolution = "task moved on" } = {}) {
      return withOrg(async (client) => {
        const result = await client.query(
          `UPDATE automation.interventions
           SET state = 'RESOLVED', resolved_by = $3, resolved_at = $4, resolution = $5
           WHERE organization_id = $1 AND task_id = $2 AND state != 'RESOLVED'`,
          [organizationId, taskId, by, now(), resolution],
        );
        return result.rowCount;
      });
    },

    async list({ states = null, workspaceId = null, workspaceIds = null } = {}) {
      return withOrg(async (client) => {
        const result = await client.query(
          `SELECT * FROM automation.interventions
           WHERE organization_id = $1
             AND ($2::text[] IS NULL OR state = ANY($2))
             AND ($3::text IS NULL OR workspace_id = $3)
             AND ($4::text[] IS NULL OR workspace_id = ANY($4))
           ORDER BY created_at`,
          [organizationId, states, workspaceId, workspaceIds],
        );
        return result.rows.map(toIntervention);
      });
    },

    async counts() {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT state, count(*) FROM automation.interventions WHERE organization_id = $1 GROUP BY state",
          [organizationId],
        );
        const counts = { OPEN: 0, CLAIMED: 0, RESOLVED: 0 };
        for (const row of result.rows) counts[row.state] = Number(row.count);
        return counts;
      });
    },
  });
}
