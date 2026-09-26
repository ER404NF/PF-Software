// One-time data migration (Phase 1 rollout, PHASE1_TEAM_ROLLOUT_HANDOUT.md
// task P3, approvals domain): reads the existing file-backed
// research-approvals.json and writes each approval into
// automation.approvals, preserving every field exactly — including its
// epoch-ms timestamps, which both stores already use identically (no unit
// conversion needed, unlike the site/assignment domains' ISO strings).
//
// Safe to re-run: each approval is upserted by id (ON CONFLICT DO UPDATE).
//
// Usage:
//   DATABASE_URL=postgres://... node server/scripts/migrate-approvals-to-postgres.js [path/to/research-approvals.json]
// Defaults to APPROVAL_STORE_PATH / storage/research-approvals.json, matching index.js's own default.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalStore } from "../src/approvalStore.js";
import { createPool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/transaction.js";
import { ensureDefaultOrganization } from "../src/db/defaultOrganization.js";
import { isDirectExecution } from "../src/directExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrateApprovalsToPostgres(pool, filePath) {
  const store = new ApprovalStore({ filePath }); // reuses the file store's own loading
  const beforeItems = store.items;

  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  const results = [];
  await withTransaction(pool, async (client) => {
    for (const a of beforeItems) {
      const result = await client.query(
        `INSERT INTO automation.approvals
           (id, organization_id, fingerprint, workspace_id, account_id, task_id, device_id, action, target,
            comment_text, requested_by, context, state, requested_at, expires_at, decided_at, decided_by, reason, consumed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (id) DO UPDATE SET
           fingerprint = $3, workspace_id = $4, account_id = $5, task_id = $6, device_id = $7, action = $8,
           target = $9, comment_text = $10, requested_by = $11, context = $12, state = $13, requested_at = $14,
           expires_at = $15, decided_at = $16, decided_by = $17, reason = $18, consumed_at = $19
         RETURNING id`,
        [a.id, organizationId, a.fingerprint, a.workspaceId, a.accountId, a.taskId ?? null, a.deviceId ?? null,
          a.action, a.target ?? null, a.commentText ?? null, a.requestedBy ?? null,
          a.context ? JSON.stringify(a.context) : null, a.state, a.requestedAt, a.expiresAt,
          a.decidedAt ?? null, a.decidedBy ?? null, a.reason ?? null, a.consumedAt ?? null],
      );
      results.push(result.rows[0].id);
    }
  }, { organizationId });

  const afterResult = await withTransaction(
    pool,
    (client) => client.query("SELECT count(*)::int AS n FROM automation.approvals WHERE organization_id = $1", [organizationId]),
    { organizationId },
  );

  return { beforeCount: beforeItems.length, migratedIds: results, afterCount: afterResult.rows[0].n, organizationId };
}

async function main() {
  const filePath = process.argv[2] || process.env.APPROVAL_STORE_PATH
    || path.join(__dirname, "../../storage/research-approvals.json");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (this migration writes to the real database, not a mock).");
    process.exit(1);
  }
  console.log(`Reading approvals from ${filePath}...`);
  const pool = createPool();
  try {
    const { beforeCount, migratedIds, afterCount, organizationId } = await migrateApprovalsToPostgres(pool, filePath);
    console.log(`Approvals in file: ${beforeCount}`);
    console.log(`Approvals upserted into Postgres (organization ${organizationId}): ${migratedIds.length}`);
    console.log(`Approvals now in Postgres for this organization: ${afterCount}`);
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
