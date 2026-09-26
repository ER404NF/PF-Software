// One-time data migration (Phase 1 rollout, PHASE1_TEAM_ROLLOUT_HANDOUT.md
// task P3, audit domain): reads the existing file-backed append-only
// events.log (one JSON object per line) and writes each event into
// automation.audit_events, preserving every field exactly.
//
// Safe to re-run: each event is upserted by id (ON CONFLICT DO NOTHING —
// audit events are immutable once written, so there is nothing to update,
// only "already migrated, skip").
//
// Usage:
//   DATABASE_URL=postgres://... node server/scripts/migrate-audit-log-to-postgres.js [path/to/events.log]
// Defaults to AUDIT_LOG_PATH / storage/audit/events.log, matching index.js's own default.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditLog } from "../src/auditLog.js";
import { createPool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/transaction.js";
import { ensureDefaultOrganization } from "../src/db/defaultOrganization.js";
import { isDirectExecution } from "../src/directExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrateAuditLogToPostgres(pool, filePath) {
  const log = createAuditLog(filePath); // reuses the file store's own loading, including its torn-last-line tolerance
  const events = log.listEvents({ limit: Number.POSITIVE_INFINITY }); // the default 200-event cap must not silently truncate a migration

  const organization = await ensureDefaultOrganization(pool);
  const organizationId = organization.id;

  const results = [];
  await withTransaction(pool, async (client) => {
    for (const e of events) {
      const result = await client.query(
        `INSERT INTO automation.audit_events (id, organization_id, at, operator, type, device_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [e.id, organizationId, e.at, e.operator ?? null, e.type, e.deviceId ?? null, JSON.stringify(e.detail ?? {})],
      );
      if (result.rowCount > 0) results.push(result.rows[0].id);
    }
  }, { organizationId });

  const afterResult = await withTransaction(
    pool,
    (client) => client.query("SELECT count(*)::int AS n FROM automation.audit_events WHERE organization_id = $1", [organizationId]),
    { organizationId },
  );

  return { beforeCount: events.length, migratedIds: results, afterCount: afterResult.rows[0].n, organizationId };
}

async function main() {
  const filePath = process.argv[2] || process.env.AUDIT_LOG_PATH
    || path.join(__dirname, "../../storage/audit/events.log");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (this migration writes to the real database, not a mock).");
    process.exit(1);
  }
  console.log(`Reading audit events from ${filePath}...`);
  const pool = createPool();
  try {
    const { beforeCount, migratedIds, afterCount, organizationId } = await migrateAuditLogToPostgres(pool, filePath);
    console.log(`Audit events in file: ${beforeCount}`);
    console.log(`Audit events newly inserted into Postgres (organization ${organizationId}): ${migratedIds.length}`);
    console.log(`Audit events now in Postgres for this organization: ${afterCount}`);
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
