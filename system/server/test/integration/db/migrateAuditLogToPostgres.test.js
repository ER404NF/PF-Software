// Real-PostgreSQL test for the P3 audit-log migration script
// (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md task P3, step 2).
// Skips without TEST_DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrateAuditLogToPostgres } from "../../../scripts/migrate-audit-log-to-postgres.js";
import { createAuditLog } from "../../../src/auditLog.js";
import { DEFAULT_ORGANIZATION_SLUG } from "../../../src/db/defaultOrganization.js";

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — this test only runs against a real PostgreSQL instance (see .github/workflows/db-migrations.yml)";

const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));
const systemRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const migrationsDir = path.join(serverRoot, "migrations");
const migrateBin = path.join(systemRoot, "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js");

async function runMigrationsUp(databaseUrl) {
  await execFileAsync(process.execPath, [migrateBin, "up", "--migrations-dir", migrationsDir], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

test("migrate-audit-log-to-postgres.js (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-migrate-audit-"));
  const filePath = path.join(root, "events.log");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const log = createAuditLog(filePath);
  // More than listEvents()'s own default 200-event cap, proving the
  // migration doesn't inherit that read-side limit.
  for (let i = 0; i < 210; i += 1) {
    log.logEvent({ operator: "va1", type: "action_tap", deviceId: "mock-1", detail: { i } });
  }
  const marker = log.logEvent({ operator: "va1", type: "action_type_text", detail: { length: 42 } });

  await t.test("migrates every event, including past the 200-event read cap, and counts reconcile", async () => {
    const { beforeCount, migratedIds, afterCount } = await migrateAuditLogToPostgres(pool, filePath);
    assert.equal(beforeCount, 211);
    assert.equal(migratedIds.length, 211);
    assert.ok(afterCount >= 211);

    const row = await pool.query("SELECT * FROM automation.audit_events WHERE id = $1", [marker.id]);
    assert.equal(row.rows[0].type, "action_type_text");
    assert.deepEqual(row.rows[0].detail, { length: 42 });
  });

  await t.test("re-running the migration inserts nothing new — audit events are immutable, ON CONFLICT DO NOTHING", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM automation.audit_events");
    const { migratedIds } = await migrateAuditLogToPostgres(pool, filePath);
    assert.equal(migratedIds.length, 0, "every event already exists, so nothing should be (re-)inserted");
    const after = await pool.query("SELECT count(*)::int AS n FROM automation.audit_events");
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  await t.test("every migrated event belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query("SELECT organization_id FROM automation.audit_events WHERE id = $1", [marker.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });
});
