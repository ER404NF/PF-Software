// M05: PostgreSQL-backed adapter satisfying the exact same proxy pool
// repository contract (persistence/proxyPoolRepository.js) as
// fileProxyPoolRepository.js — same 8 methods, same validation, same
// exclusive per-device lease semantics as proxyPool.js. Pure transforms
// that don't touch storage (validateFields(), publicProxy(),
// flagForCountry(), decryptProxyPassword()) are imported from proxyPool.js
// itself rather than duplicated, exactly as that module's own header
// comment prescribes for any future adapter. Every row is scoped to the
// install's single default organization (see db/defaultOrganization.js and
// the owner decision it documents).

import crypto from "node:crypto";
import { validateFields, publicProxy } from "../../proxyPool.js";
import { encryptTotpSecret } from "../../twoFactor.js";
import { assertProxyPoolRepository } from "../../persistence/proxyPoolRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

const ID_PREFIX = "px_";

function poolError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    username: row.username,
    passwordEncrypted: row.password_encrypted,
    country: row.country,
    label: row.label,
    leasedToDeviceId: row.leased_to_device_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    health: row.health ?? null,
  };
}

// Mirrors updateProxyHealth()'s own restricted field set, so a caller can
// never smuggle arbitrary keys into the stored health snapshot.
function safeHealth(health) {
  if (!health) return null;
  return {
    status: health.status,
    checkedAt: health.checkedAt,
    publicIpv4: health.publicIpv4 ?? null,
    country: health.country ?? null,
    latencyMs: Number.isFinite(health.latencyMs) ? health.latencyMs : null,
    provider: health.provider ?? null,
    errorCode: health.errorCode ?? null,
    errorName: health.errorName ?? null,
  };
}

export async function createPostgresProxyPoolRepository(pool, { now = () => new Date().toISOString() } = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  return assertProxyPoolRepository({
    async load() {
      return withOrg(async (client) => {
        const result = await client.query("SELECT * FROM automation.proxy_pool WHERE organization_id = $1", [organizationId]);
        const records = Object.create(null);
        for (const row of result.rows) records[row.id] = toRecord(row);
        return records;
      });
    },

    async get(proxyId) {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT * FROM automation.proxy_pool WHERE id = $1 AND organization_id = $2",
          [proxyId, organizationId],
        );
        return toRecord(result.rows[0]) ?? null;
      });
    },

    async create(fields, masterKey) {
      validateFields(fields);
      return withOrg(async (client) => {
        const at = now();
        const id = `${ID_PREFIX}${crypto.randomUUID()}`;
        const result = await client.query(
          `INSERT INTO automation.proxy_pool
             (id, organization_id, provider, protocol, host, port, username, password_encrypted, country, label,
              leased_to_device_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $11)
           RETURNING *`,
          [id, organizationId, fields.provider.trim(), fields.protocol, fields.host.trim(), fields.port,
            fields.username.trim(), encryptTotpSecret(fields.password, masterKey), fields.country.toUpperCase(),
            fields.label?.trim() || `${fields.provider.trim()} ${fields.country.toUpperCase()}`, at],
        );
        return toRecord(result.rows[0]);
      });
    },

    async remove(proxyId) {
      return withOrg(async (client) => {
        const existing = await client.query(
          "SELECT leased_to_device_id FROM automation.proxy_pool WHERE id = $1 AND organization_id = $2",
          [proxyId, organizationId],
        );
        if (existing.rowCount === 0) return false;
        if (existing.rows[0].leased_to_device_id) {
          throw poolError("release this proxy from its assigned device before deleting it", 409);
        }
        await client.query("DELETE FROM automation.proxy_pool WHERE id = $1 AND organization_id = $2", [proxyId, organizationId]);
        return true;
      });
    },

    async assignToDevice({ deviceId, proxyId }) {
      if (typeof deviceId !== "string" || !deviceId) throw poolError("deviceId is required", 400);
      return withOrg(async (client) => {
        const at = now();
        const currentResult = await client.query(
          "SELECT * FROM automation.proxy_pool WHERE organization_id = $1 AND leased_to_device_id = $2",
          [organizationId, deviceId],
        );
        const current = currentResult.rows[0] ?? null;

        if (proxyId === null) {
          if (!current) return null;
          await client.query(
            "UPDATE automation.proxy_pool SET leased_to_device_id = NULL, updated_at = $1 WHERE id = $2",
            [at, current.id],
          );
          return null;
        }

        const targetResult = await client.query(
          "SELECT * FROM automation.proxy_pool WHERE id = $1 AND organization_id = $2",
          [proxyId, organizationId],
        );
        const target = targetResult.rows[0];
        if (!target) throw poolError("unknown proxy", 404);
        if (target.leased_to_device_id && target.leased_to_device_id !== deviceId) {
          throw poolError("this proxy is already assigned to another device", 409);
        }
        if (current && current.id !== proxyId) {
          await client.query(
            "UPDATE automation.proxy_pool SET leased_to_device_id = NULL, updated_at = $1 WHERE id = $2",
            [at, current.id],
          );
        }
        const result = await client.query(
          "UPDATE automation.proxy_pool SET leased_to_device_id = $1, updated_at = $2 WHERE id = $3 RETURNING *",
          [deviceId, at, proxyId],
        );
        return toRecord(result.rows[0]);
      });
    },

    async forDevice(deviceId) {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT * FROM automation.proxy_pool WHERE organization_id = $1 AND leased_to_device_id = $2",
          [organizationId, deviceId],
        );
        return toRecord(result.rows[0]) ?? null;
      });
    },

    async updateHealth(proxyId, health) {
      return withOrg(async (client) => {
        const existing = await client.query("SELECT id FROM automation.proxy_pool WHERE id = $1 AND organization_id = $2", [proxyId, organizationId]);
        if (existing.rowCount === 0) throw poolError("unknown proxy", 404);
        const result = await client.query(
          "UPDATE automation.proxy_pool SET health = $1, updated_at = $2 WHERE id = $3 RETURNING *",
          [JSON.stringify(safeHealth(health)), now(), proxyId],
        );
        return toRecord(result.rows[0]);
      });
    },

    async publicList() {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT * FROM automation.proxy_pool WHERE organization_id = $1 ORDER BY label",
          [organizationId],
        );
        return result.rows.map((row) => publicProxy(toRecord(row)));
      });
    },
  });
}
