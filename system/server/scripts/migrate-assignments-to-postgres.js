// One-time data migration (Phase 1 rollout, PHASE1_TEAM_ROLLOUT_HANDOUT.md
// task P3, assignments domain): reads the existing file-backed
// assignments.json and writes each assignment into automation.assignments,
// preserving every field exactly, including history.
//
// Safe to re-run: each assignment is upserted by id (ON CONFLICT DO
// UPDATE), never duplicated. Does not touch or delete the source file.
//
// Usage:
//   DATABASE_URL=postgres://... node server/scripts/migrate-assignments-to-postgres.js [path/to/assignments.json]
// Defaults to ASSIGNMENT_STORE_PATH / storage/assignments/assignments.json, matching index.js's own default.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssignmentStore } from "../src/assignmentStore.js";
import { createPool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/transaction.js";
import { ensureDefaultOrganization } from "../src/db/defaultOrganization.js";
import { isDirectExecution } from "../src/directExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrateAssignmentsToPostgres(pool, filePath) {
  const store = createAssignmentStore({ storePath: filePath }); // reuses the file store's own loading/validation
  const beforeList = store.list();

  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  const results = [];
  await withTransaction(pool, async (client) => {
    for (const a of beforeList) {
      // The loader tolerates recurrence/occurrence being absent (a hand-
      // edited or pre-recurrence-feature legacy record); the real writer
      // (assignmentStore.js's own create()) always sets them, defaulting
      // recurrence to "once" — the same coalesce assignmentStore.js's own
      // setStatus()/expireDue() already use internally for the same reason.
      const recurrence = a.recurrence ?? "once";
      const occurrence = a.occurrence ?? 1;
      const timezone = recurrence === "once" ? null : (a.timezone ?? "UTC");
      const result = await client.query(
        `INSERT INTO automation.assignments
           (id, organization_id, instructions, assignee, created_by, device_id, account_id,
            start_at, end_at, exclusive, recurrence, timezone, occurrence, status,
            created_at, updated_at, last_completed_at, history)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (id) DO UPDATE SET
           instructions = $3, assignee = $4, created_by = $5, device_id = $6, account_id = $7,
           start_at = $8, end_at = $9, exclusive = $10, recurrence = $11, timezone = $12, occurrence = $13,
           status = $14, created_at = $15, updated_at = $16, last_completed_at = $17, history = $18
         RETURNING id`,
        [a.id, organizationId, a.instructions, a.assignee, a.createdBy, a.deviceId ?? null, a.accountId ?? null,
          a.startAt ?? null, a.endAt ?? null, a.exclusive ?? true, recurrence, timezone, occurrence, a.status,
          a.createdAt, a.updatedAt, a.lastCompletedAt ?? null, JSON.stringify(a.history ?? [])],
      );
      results.push(result.rows[0].id);
    }
  }, { organizationId });

  const afterResult = await withTransaction(
    pool,
    (client) => client.query("SELECT count(*)::int AS n FROM automation.assignments WHERE organization_id = $1", [organizationId]),
    { organizationId },
  );

  return { beforeCount: beforeList.length, migratedIds: results, afterCount: afterResult.rows[0].n, organizationId };
}

async function main() {
  const filePath = process.argv[2] || process.env.ASSIGNMENT_STORE_PATH
    || path.join(__dirname, "../../storage/assignments/assignments.json");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (this migration writes to the real database, not a mock).");
    process.exit(1);
  }
  console.log(`Reading assignments from ${filePath}...`);
  const pool = createPool();
  try {
    const { beforeCount, migratedIds, afterCount, organizationId } = await migrateAssignmentsToPostgres(pool, filePath);
    console.log(`Assignments in file: ${beforeCount}`);
    console.log(`Assignments upserted into Postgres (organization ${organizationId}): ${migratedIds.length}`);
    console.log(`Assignments now in Postgres for this organization: ${afterCount}`);
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
