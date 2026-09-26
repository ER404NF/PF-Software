// Real-PostgreSQL test for the P3 assignments migration script
// (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md task P3, step 2).
// Skips without TEST_DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrateAssignmentsToPostgres } from "../../../scripts/migrate-assignments-to-postgres.js";
import { createPostgresAssignmentRepository } from "../../../src/db/repositories/postgresAssignmentRepository.js";
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

test("migrate-assignments-to-postgres.js (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-migrate-assignments-"));
  const filePath = path.join(root, "assignments.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const unique = crypto.randomBytes(3).toString("hex");
  const assignmentOnce = {
    id: crypto.randomUUID(), instructions: "Check device health", assignee: `va-${unique}`, createdBy: `manager-${unique}`,
    deviceId: "device-1", accountId: null, startAt: null, endAt: null, exclusive: true,
    recurrence: "once", timezone: null, occurrence: 1, status: "assigned",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastCompletedAt: null,
    history: [{ at: "2026-01-01T00:00:00.000Z", actor: `manager-${unique}`, action: "created", toStatus: "assigned", assignee: `va-${unique}` }],
  };
  const assignmentRecurring = {
    id: crypto.randomUUID(), instructions: "Daily check-in", assignee: `va-daily-${unique}`, createdBy: `manager-${unique}`,
    deviceId: null, accountId: "account-1", startAt: "2026-02-01T09:00:00.000Z", endAt: "2026-02-01T10:00:00.000Z", exclusive: true,
    recurrence: "daily", timezone: "Europe/Rome", occurrence: 3, status: "assigned",
    createdAt: "2026-01-15T00:00:00.000Z", updatedAt: "2026-02-03T09:00:00.000Z", lastCompletedAt: "2026-02-03T09:00:00.000Z",
    history: [{ at: "2026-01-15T00:00:00.000Z", actor: `manager-${unique}`, action: "created", toStatus: "assigned", assignee: `va-daily-${unique}` }],
  };
  // A legacy-shaped record missing recurrence/occurrence entirely —
  // assignmentStore.js's own loader (validateLoadedAssignment) tolerates
  // this, and the store's own internal code (setStatus/expireDue) already
  // coalesces recurrence ?? "once" for exactly this reason.
  const assignmentLegacy = {
    id: crypto.randomUUID(), instructions: "Pre-recurrence-feature assignment", assignee: `va-legacy-${unique}`, createdBy: `manager-${unique}`,
    deviceId: null, accountId: null, startAt: null, endAt: null, exclusive: true, status: "assigned",
    createdAt: "2025-06-01T00:00:00.000Z", updatedAt: "2025-06-01T00:00:00.000Z",
    history: [],
  };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, assignments: [assignmentOnce, assignmentRecurring, assignmentLegacy] }, null, 2));

  await t.test("migrates every assignment, preserving fields and history exactly, and counts reconcile", async () => {
    const { beforeCount, migratedIds, afterCount } = await migrateAssignmentsToPostgres(pool, filePath);
    assert.equal(beforeCount, 3);
    assert.equal(migratedIds.length, 3);
    assert.ok(afterCount >= 3);

    const row = await pool.query("SELECT * FROM automation.assignments WHERE id = $1", [assignmentRecurring.id]);
    assert.equal(row.rows[0].assignee, `va-daily-${unique}`);
    assert.equal(row.rows[0].recurrence, "daily");
    assert.equal(row.rows[0].timezone, "Europe/Rome");
    assert.equal(row.rows[0].occurrence, 3);
    assert.deepEqual(row.rows[0].history, assignmentRecurring.history);
  });

  await t.test("a legacy record missing recurrence/occurrence is coalesced to once/1, not rejected", async () => {
    const row = await pool.query("SELECT recurrence, occurrence, timezone FROM automation.assignments WHERE id = $1", [assignmentLegacy.id]);
    assert.equal(row.rows[0].recurrence, "once");
    assert.equal(row.rows[0].occurrence, 1);
    assert.equal(row.rows[0].timezone, null);
  });

  await t.test("the migrated assignment repository behaves identically to the file store afterward", async () => {
    const repository = await createPostgresAssignmentRepository(pool);
    const fetched = await repository.get(assignmentOnce.id);
    assert.equal(fetched.assignee, `va-${unique}`);
    assert.equal(fetched.deviceId, "device-1");
  });

  await t.test("re-running the migration is idempotent — upserts, does not duplicate", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM automation.assignments");
    await migrateAssignmentsToPostgres(pool, filePath);
    const after = await pool.query("SELECT count(*)::int AS n FROM automation.assignments");
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  await t.test("every migrated assignment belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query("SELECT organization_id FROM automation.assignments WHERE id = $1", [assignmentOnce.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });
});
