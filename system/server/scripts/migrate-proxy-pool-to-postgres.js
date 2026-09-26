// One-time data migration (Phase 1 rollout, PHASE1_TEAM_ROLLOUT_HANDOUT.md
// task P3, proxy pool domain): reads the existing file-backed
// proxy-pool.json and writes each proxy into automation.proxy_pool,
// preserving every field exactly — including the encrypted password
// ciphertext verbatim (never decrypted or re-encrypted here; both stores
// use the same AES-256-GCM master-key convention, so the existing
// PROXY_CREDENTIAL_ENCRYPTION_KEY continues to decrypt it after migration).
//
// Safe to re-run: each proxy is upserted by id (ON CONFLICT DO UPDATE).
//
// Usage:
//   DATABASE_URL=postgres://... node server/scripts/migrate-proxy-pool-to-postgres.js [path/to/proxy-pool.json]
// Defaults to PROXY_POOL_STORE_PATH / storage/proxy-pool.json, matching index.js's own default.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProxyRecords } from "../src/proxyPool.js";
import { createPool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/transaction.js";
import { ensureDefaultOrganization } from "../src/db/defaultOrganization.js";
import { isDirectExecution } from "../src/directExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrateProxyPoolToPostgres(pool, filePath) {
  const records = Object.values(loadProxyRecords(filePath)); // reuses the file store's own loading

  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  const results = [];
  await withTransaction(pool, async (client) => {
    for (const p of records) {
      const result = await client.query(
        `INSERT INTO automation.proxy_pool
           (id, organization_id, provider, protocol, host, port, username, password_encrypted, country, label,
            leased_to_device_id, health, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           provider = $3, protocol = $4, host = $5, port = $6, username = $7, password_encrypted = $8,
           country = $9, label = $10, leased_to_device_id = $11, health = $12, created_at = $13, updated_at = $14
         RETURNING id`,
        [p.id, organizationId, p.provider, p.protocol, p.host, p.port, p.username, p.passwordEncrypted,
          p.country, p.label, p.leasedToDeviceId ?? null, p.health ? JSON.stringify(p.health) : null,
          p.createdAt, p.updatedAt],
      );
      results.push(result.rows[0].id);
    }
  }, { organizationId });

  const afterResult = await withTransaction(
    pool,
    (client) => client.query("SELECT count(*)::int AS n FROM automation.proxy_pool WHERE organization_id = $1", [organizationId]),
    { organizationId },
  );

  return { beforeCount: records.length, migratedIds: results, afterCount: afterResult.rows[0].n, organizationId };
}

async function main() {
  const filePath = process.argv[2] || process.env.PROXY_POOL_STORE_PATH
    || path.join(__dirname, "../../storage/proxy-pool.json");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (this migration writes to the real database, not a mock).");
    process.exit(1);
  }
  console.log(`Reading proxy pool records from ${filePath}...`);
  const pool = createPool();
  try {
    const { beforeCount, migratedIds, afterCount, organizationId } = await migrateProxyPoolToPostgres(pool, filePath);
    console.log(`Proxies in file: ${beforeCount}`);
    console.log(`Proxies upserted into Postgres (organization ${organizationId}): ${migratedIds.length}`);
    console.log(`Proxies now in Postgres for this organization: ${afterCount}`);
    if (afterCount < beforeCount) {
      console.error(`WARNING: fewer rows in Postgres (${afterCount}) than in the file (${beforeCount}) — investigate before cutting over.`);
      process.exitCode = 1;
    } else {
      console.log("Row counts reconcile. Safe to proceed with the cutover step once you have watched this run correctly.");
    }
  } finally {
    await pool.end();
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
}
