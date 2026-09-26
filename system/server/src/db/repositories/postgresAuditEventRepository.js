// M05: PostgreSQL-backed adapter satisfying the exact same audit event
// repository contract (persistence/auditEventRepository.js) as
// fileAuditEventRepository.js (which wraps auditLog.js) — same two methods,
// same event shape, same "filter, newest first, then limit" listEvents()
// semantics. Every row is scoped to the install's single default
// organization (see db/defaultOrganization.js and the owner decision it
// documents).

import crypto from "node:crypto";
import { assertAuditEventRepository } from "../../persistence/auditEventRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    at: iso(row.at),
    operator: row.operator,
    type: row.type,
    deviceId: row.device_id,
    detail: row.detail,
  };
}

export async function createPostgresAuditEventRepository(pool, { now = () => new Date().toISOString() } = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  return assertAuditEventRepository({
    async logEvent({ operator = null, type, deviceId = null, detail = {} }) {
      return withOrg(async (client) => {
        const id = crypto.randomUUID();
        const at = now();
        const result = await client.query(
          `INSERT INTO automation.audit_events (id, organization_id, at, operator, type, device_id, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [id, organizationId, at, operator, type, deviceId, JSON.stringify(detail)],
        );
        return toEvent(result.rows[0]);
      });
    },

    async listEvents({ operator = null, deviceId = null, limit = 200 } = {}) {
      return withOrg(async (client) => {
        const result = await client.query(
          `SELECT * FROM automation.audit_events
           WHERE organization_id = $1
             AND ($2::text IS NULL OR operator = $2)
             AND ($3::text IS NULL OR device_id = $3)
           ORDER BY at DESC
           LIMIT $4`,
          [organizationId, operator, deviceId, limit],
        );
        return result.rows.map(toEvent);
      });
    },
  });
}
