// Real-PostgreSQL test for the P3 task-queue migration script
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
import { migrateTaskQueueToPostgres } from "../../../scripts/migrate-task-queue-to-postgres.js";
import { createFileTaskQueueSnapshotRepository } from "../../../src/persistence/fileTaskQueueSnapshotRepository.js";
import { createPostgresTaskQueueSnapshotRepository } from "../../../src/db/repositories/postgresTaskQueueSnapshotRepository.js";
import { createTaskSpec } from "../../../src/taskSpec.js";
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

test("migrate-task-queue-to-postgres.js (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  // automation.task_queue_snapshots has exactly one row per organization
  // (unlike every other domain's tables, there is no per-test-random id to
  // isolate on) — every test in this suite shares the single default
  // organization, so this test must clean up its own row afterward or it
  // silently breaks postgresTaskQueueSnapshotRepository.test.js's own
  // "reports an empty snapshot when none has been saved yet" assumption
  // for whichever test happens to run later in the same `npm test`
  // invocation. Combined into one hook (not two separate t.after() calls)
  // to avoid any ambiguity about hook ordering versus pool.end().
  t.after(async () => {
    const org = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    if (org.rowCount > 0) {
      await pool.query("DELETE FROM automation.task_queue_snapshots WHERE organization_id = $1", [org.rows[0].id]);
    }
    await pool.end();
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-migrate-taskqueue-"));
  const filePath = path.join(root, "tasks.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileRepository = createFileTaskQueueSnapshotRepository(filePath);
  const taskA = createTaskSpec({ goal: "check device health" });
  const taskB = createTaskSpec({ goal: "post a research summary" });
  fileRepository.save([taskA, taskB], true, new Set(["device-1", "device-2"]));

  await t.test("migrates the whole snapshot (tasks, paused, human holds) exactly, and counts reconcile", async () => {
    const { beforeCount, afterCount, paused, humanHoldCount } = await migrateTaskQueueToPostgres(pool, filePath);
    assert.equal(beforeCount, 2);
    assert.equal(afterCount, 2);
    assert.equal(paused, true);
    assert.equal(humanHoldCount, 2);

    const postgresRepository = await createPostgresTaskQueueSnapshotRepository(pool);
    const loaded = await postgresRepository.load();
    assert.deepEqual(loaded.tasks.map((t) => t.id).sort(), [taskA.id, taskB.id].sort());
    assert.equal(loaded.paused, true);
    assert.deepEqual([...loaded.humanHolds].sort(), ["device-1", "device-2"]);
  });

  await t.test("re-running the migration is idempotent — one row, not a growing history", async () => {
    await migrateTaskQueueToPostgres(pool, filePath);
    const row = await pool.query("SELECT count(*)::int AS n FROM automation.task_queue_snapshots");
    assert.equal(row.rows[0].n, 1);
  });
});
