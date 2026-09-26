// One-time data migration (Phase 1 rollout, PHASE1_TEAM_ROLLOUT_HANDOUT.md
// task P3, approvals/interventions domain): reads the existing file-backed
// interventions.json and writes each item into automation.interventions,
// preserving every field exactly (epoch-ms timestamps, same convention both
// stores already share).
//
// Safe to re-run: each intervention is upserted by id (ON CONFLICT DO
// UPDATE). Deliberately does NOT replicate InterventionQueue's own
// `_trim()` (capping resolved items to bound file size) — a database table
// doesn't have the unbounded-file-growth problem that existed only because
// of the file format; every intervention in the file migrates, not just
// the ones a file-size cap left behind. See
// M05_DURABLE_DOMAIN_MIGRATION.md's own note on this same non-parity
// decision in the Postgres adapter itself.
//
// Usage:
//   DATABASE_URL=postgres://... node server/scripts/migrate-interventions-to-postgres.js [path/to/interventions.json]
// Defaults to INTERVENTION_STORE_PATH / storage/interventions.json, matching index.js's own default.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { InterventionQueue } from "../src/interventionQueue.js";
import { createPool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/transaction.js";
import { ensureDefaultOrganization } from "../src/db/defaultOrganization.js";
import { isDirectExecution } from "../src/directExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrateInterventionsToPostgres(pool, filePath) {
  const store = new InterventionQueue({ filePath }); // reuses the file store's own loading
  const beforeItems = store.items;

  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  const results = [];
  await withTransaction(pool, async (client) => {
    for (const item of beforeItems) {
      const result = await client.query(
        `INSERT INTO automation.interventions
           (id, organization_id, task_id, device_id, account_id, workspace_id, platform, kind, reason, ref,
            state, created_at, claimed_by, claimed_at, resolved_by, resolved_at, resolution)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           task_id = $3, device_id = $4, account_id = $5, workspace_id = $6, platform = $7, kind = $8,
           reason = $9, ref = $10, state = $11, created_at = $12, claimed_by = $13, claimed_at = $14,
           resolved_by = $15, resolved_at = $16, resolution = $17
         RETURNING id`,
        [item.id, organizationId, item.taskId ?? null, item.deviceId ?? null, item.accountId ?? null,
          item.workspaceId ?? null, item.platform ?? null, item.kind, item.reason ?? null,
          item.ref ? JSON.stringify(item.ref) : null, item.state, item.createdAt,
          item.claimedBy ?? null, item.claimedAt ?? null, item.resolvedBy ?? null, item.resolvedAt ?? null, item.resolution ?? null],
      );
      results.push(result.rows[0].id);
    }
  }, { organizationId });

  const afterResult = await withTransaction(
    pool,
    (client) => client.query("SELECT count(*)::int AS n FROM automation.interventions WHERE organization_id = $1", [organizationId]),
    { organizationId },
  );

  return { beforeCount: beforeItems.length, migratedIds: results, afterCount: afterResult.rows[0].n, organizationId };
}

async function main() {
  const filePath = process.argv[2] || process.env.INTERVENTION_STORE_PATH
    || path.join(__dirname, "../../storage/interventions.json");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (this migration writes to the real database, not a mock).");
    process.exit(1);
  }
  console.log(`Reading interventions from ${filePath}...`);
  const pool = createPool();
  try {
    const { beforeCount, migratedIds, afterCount, organizationId } = await migrateInterventionsToPostgres(pool, filePath);
    console.log(`Interventions in file: ${beforeCount}`);
    console.log(`Interventions upserted into Postgres (organization ${organizationId}): ${migratedIds.length}`);
    console.log(`Interventions now in Postgres for this organization: ${afterCount}`);
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
