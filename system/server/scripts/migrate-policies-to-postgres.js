// One-time data migration (Phase 1 rollout, PHASE1_TEAM_ROLLOUT_HANDOUT.md
// task P3, platform accounts/policies domain): reads the existing
// file-backed action-policy-overrides.json and writes each override into
// automation.account_policies, preserving value/changedBy/changedAt exactly.
//
// Safe to re-run: each (account, action) pair is upserted (ON CONFLICT DO
// UPDATE), never duplicated. Does not touch or delete the source file.
//
// Usage:
//   DATABASE_URL=postgres://... node server/scripts/migrate-policies-to-postgres.js [path/to/action-policy-overrides.json]
// Defaults to ACTION_POLICY_OVERRIDES_PATH / storage/action-policy-overrides.json, matching index.js's own default.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyStore } from "../src/policyStore.js";
import { ACTIONS, POLICY_VALUES } from "../src/actionPolicy.js";
import { createPool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/transaction.js";
import { ensureDefaultOrganization } from "../src/db/defaultOrganization.js";
import { isDirectExecution } from "../src/directExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION_SET = new Set(ACTIONS);
const VALUE_SET = new Set(Object.values(POLICY_VALUES));

export async function migratePoliciesToPostgres(pool, filePath) {
  // PolicyStore's own constructor does NOT validate what it loads (unlike
  // assignmentStore.js/siteStore.js's loaders) — it blindly JSON.parses the
  // file. automation.account_policies.value has a real CHECK constraint, so
  // an invalid or hand-edited entry here must be skipped and reported, not
  // silently crash the whole migration.
  const store = new PolicyStore({ filePath });

  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  let beforeCount = 0;
  const results = [];
  const skipped = [];
  await withTransaction(pool, async (client) => {
    for (const [accountId, actions] of Object.entries(store.overrides)) {
      for (const [action, entry] of Object.entries(actions)) {
        beforeCount += 1;
        if (!ACTION_SET.has(action) || !VALUE_SET.has(entry?.value)) {
          skipped.push(`${accountId}:${action}`);
          continue;
        }
        const changedAt = entry.at ?? new Date().toISOString();
        await client.query(
          `INSERT INTO automation.account_policies (organization_id, account_id, action, value, changed_by, changed_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (organization_id, account_id, action)
           DO UPDATE SET value = $4, changed_by = $5, changed_at = $6`,
          [organizationId, accountId, action, entry.value, entry.by ?? null, changedAt],
        );
        results.push(`${accountId}:${action}`);
      }
    }
  }, { organizationId });

  const afterResult = await withTransaction(
    pool,
    (client) => client.query("SELECT count(*)::int AS n FROM automation.account_policies WHERE organization_id = $1", [organizationId]),
    { organizationId },
  );

  return { beforeCount, migratedKeys: results, skippedKeys: skipped, afterCount: afterResult.rows[0].n, organizationId };
}

async function main() {
  const filePath = process.argv[2] || process.env.ACTION_POLICY_OVERRIDES_PATH
    || path.join(__dirname, "../../storage/action-policy-overrides.json");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (this migration writes to the real database, not a mock).");
    process.exit(1);
  }
  console.log(`Reading policy overrides from ${filePath}...`);
  const pool = createPool();
  try {
    const { beforeCount, migratedKeys, skippedKeys, afterCount, organizationId } = await migratePoliciesToPostgres(pool, filePath);
    console.log(`Policy overrides in file: ${beforeCount}`);
    console.log(`Policy overrides upserted into Postgres (organization ${organizationId}): ${migratedKeys.length}`);
    console.log(`Policy overrides now in Postgres for this organization: ${afterCount}`);
    if (skippedKeys.length > 0) {
      console.error(`WARNING: skipped ${skippedKeys.length} invalid override(s), not migrated: ${skippedKeys.join(", ")}`);
    }
    if (afterCount < beforeCount - skippedKeys.length) {
      console.error(`WARNING: fewer rows in Postgres (${afterCount}) than expected (${beforeCount - skippedKeys.length}) — investigate before cutting over.`);
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
