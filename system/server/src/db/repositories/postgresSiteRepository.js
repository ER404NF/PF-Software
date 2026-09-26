// M05: PostgreSQL-backed adapter satisfying the exact same site repository
// contract (persistence/siteRepository.js) as fileSiteRepository.js — same
// methods, same return shapes, same SiteError class/codes — so callers
// don't need to special-case which adapter is active. Every site row is
// scoped to the install's single default organization (see
// db/defaultOrganization.js and the owner decision it documents); this
// adapter does not yet support more than one organization owning sites —
// that is real multi-tenant fleet management, separate follow-on work once
// there is an actual second tenant to build it for.

import crypto from "node:crypto";
import { SiteError } from "../../siteStore.js";
import { assertSiteRepository } from "../../persistence/siteRepository.js";
import { withTransaction } from "../transaction.js";
import { ensureDefaultOrganization } from "../defaultOrganization.js";

const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const TOKEN_PREFIX = "pfs_";

function slugify(name) {
  return String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;

function publicView(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    timeZone: row.time_zone,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    lastSeenAt: row.last_seen_at,
  };
}

export async function createPostgresSiteRepository(pool, { defaultTimeZone = "America/Los_Angeles" } = {}) {
  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  function withOrg(fn) {
    return withTransaction(pool, fn, { organizationId });
  }

  return assertSiteRepository({
    async list() {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT * FROM fleet.sites WHERE organization_id = $1 ORDER BY name",
          [organizationId],
        );
        return result.rows.map(publicView);
      });
    },

    async get(id) {
      return withOrg(async (client) => {
        const result = await client.query(
          "SELECT * FROM fleet.sites WHERE id = $1 AND organization_id = $2",
          [id, organizationId],
        );
        return publicView(result.rows[0]) ?? null;
      });
    },

    async create({ name, id = null, timeZone = null }) {
      const displayName = typeof name === "string" ? name.trim() : "";
      if (displayName.length < 2 || displayName.length > 60) throw new SiteError("A site name must be 2 to 60 characters.");
      const siteId = id ?? slugify(displayName);
      if (!SITE_ID_PATTERN.test(siteId)) throw new SiteError("A site id may use lowercase letters, digits and hyphens (2 to 30 characters).");
      const zone = timeZone ?? defaultTimeZone;
      if (!validTimeZone(zone)) throw new SiteError("That time zone is not recognised.");

      return withOrg(async (client) => {
        const existing = await client.query("SELECT 1 FROM fleet.sites WHERE id = $1", [siteId]);
        if (existing.rowCount > 0) throw new SiteError(`A site with the id "${siteId}" already exists.`, "duplicate_site");
        const token = newToken();
        const result = await client.query(
          `INSERT INTO fleet.sites (id, organization_id, name, time_zone, token_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [siteId, organizationId, displayName, zone, hashToken(token)],
        );
        return { site: publicView(result.rows[0]), token };
      });
    },

    async rotate(id) {
      return withOrg(async (client) => {
        const existing = await client.query("SELECT 1 FROM fleet.sites WHERE id = $1 AND organization_id = $2", [id, organizationId]);
        if (existing.rowCount === 0) throw new SiteError("Unknown site.", "unknown_site");
        const token = newToken();
        const result = await client.query(
          `UPDATE fleet.sites SET token_hash = $2, rotated_at = now() WHERE id = $1 RETURNING *`,
          [id, hashToken(token)],
        );
        return { site: publicView(result.rows[0]), token };
      });
    },

    async update(id, { name, timeZone }) {
      return withOrg(async (client) => {
        const existing = await client.query("SELECT * FROM fleet.sites WHERE id = $1 AND organization_id = $2", [id, organizationId]);
        if (existing.rowCount === 0) throw new SiteError("Unknown site.", "unknown_site");
        let nextName = existing.rows[0].name;
        let nextZone = existing.rows[0].time_zone;
        if (name !== undefined) {
          const displayName = String(name).trim();
          if (displayName.length < 2 || displayName.length > 60) throw new SiteError("A site name must be 2 to 60 characters.");
          nextName = displayName;
        }
        if (timeZone !== undefined) {
          if (!validTimeZone(timeZone)) throw new SiteError("That time zone is not recognised.");
          nextZone = timeZone;
        }
        const result = await client.query(
          "UPDATE fleet.sites SET name = $2, time_zone = $3 WHERE id = $1 RETURNING *",
          [id, nextName, nextZone],
        );
        return publicView(result.rows[0]);
      });
    },

    async remove(id) {
      return withOrg(async (client) => {
        const result = await client.query("DELETE FROM fleet.sites WHERE id = $1 AND organization_id = $2", [id, organizationId]);
        return result.rowCount > 0;
      });
    },

    // Constant-time comparison of the presented token against the stored
    // hash — same approach as the file-backed SiteStore.
    async verifyToken(id, token) {
      if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
      return withOrg(async (client) => {
        const result = await client.query("SELECT * FROM fleet.sites WHERE id = $1 AND organization_id = $2", [id, organizationId]);
        const row = result.rows[0];
        if (!row) return null;
        const presented = Buffer.from(hashToken(token), "hex");
        const stored = Buffer.from(row.token_hash, "hex");
        return presented.length === stored.length && crypto.timingSafeEqual(presented, stored) ? publicView(row) : null;
      });
    },

    async markSeen(id, at = new Date().toISOString()) {
      return withOrg(async (client) => {
        await client.query("UPDATE fleet.sites SET last_seen_at = $2 WHERE id = $1 AND organization_id = $3", [id, at, organizationId]);
      });
    },
  });
}
