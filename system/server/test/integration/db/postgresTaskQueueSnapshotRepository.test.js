// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed task queue snapshot repository. Skips without
// TEST_DATABASE_URL. Proves parity with the file-backed
// fileTaskQueueSnapshotRepository.js contract — including legacy-format
// migration and crash-recovery on load, since both adapters share the same
// normalizeQueueSnapshot() logic — and real tenant isolation on the new
// automation.task_queue_snapshots table through a non-superuser role.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresTaskQueueSnapshotRepository } from "../../../src/db/repositories/postgresTaskQueueSnapshotRepository.js";
import { assertTaskQueueSnapshotRepository } from "../../../src/persistence/taskQueueSnapshotRepository.js";
import { TASK_STATES, createTaskSpec } from "../../../src/taskSpec.js";
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

function task(overrides = {}) {
  return { ...createTaskSpec({ goal: "check device health" }), ...overrides };
}

test("PostgreSQL task queue snapshot repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const repository = await createPostgresTaskQueueSnapshotRepository(pool);
  assertTaskQueueSnapshotRepository(repository);

  await t.test("load() reports an empty snapshot when none has been saved yet", async () => {
    const empty = await repository.load();
    assert.deepEqual(empty, { tasks: [], paused: false, humanHolds: new Set() });
  });

  await t.test("save() then load() round-trips tasks, paused, and humanHolds exactly", async () => {
    const fixture = task();
    await repository.save([fixture], true, new Set(["device-1"]));
    const reloaded = await repository.load();
    assert.deepEqual(reloaded.tasks, [fixture]);
    assert.equal(reloaded.paused, true);
    assert.deepEqual([...reloaded.humanHolds], ["device-1"]);
  });

  await t.test("save() upserts — saving again replaces the prior snapshot for this organization, not adds a second row", async () => {
    await repository.save([task()], false, new Set());
    const row = await pool.query(
      `SELECT count(*)::int AS n FROM automation.task_queue_snapshots WHERE organization_id = (
         SELECT id FROM identity.organizations WHERE slug = $1
       )`,
      [DEFAULT_ORGANIZATION_SLUG],
    );
    assert.equal(row.rows[0].n, 1);
  });

  await t.test("load() recovers a task that was RUNNING when the process died, per its retry policy, and persists the recovery", async () => {
    const running = task({ state: TASK_STATES.RUNNING, retryPolicy: { maxRetries: 1, backoffMs: 0 }, deviceSelector: { deviceId: "device-1" } });
    await repository.save([running], false, new Set());

    const recovered = await repository.load();
    assert.equal(recovered.tasks[0].state, TASK_STATES.QUEUED, "requeued because retryCount (1) is within maxRetries");
    assert.equal(recovered.tasks[0].retryCount, 1);
    assert.equal(recovered.tasks[0].result.outcome, "interrupted_by_restart");

    // The recovery write is persisted, not just returned in memory.
    const reloadedAgain = await repository.load();
    assert.equal(reloadedAgain.tasks[0].state, TASK_STATES.QUEUED);
    assert.equal(reloadedAgain.tasks[0].retryCount, 1, "a second load() must not re-apply recovery to an already-recovered task");
  });

  await t.test("load() migrates a legacy bare-array snapshot stored directly in the payload column", async () => {
    const legacyTask = task();
    delete legacyTask.kind;
    delete legacyTask.maxDurationSec;
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    await pool.query(
      `INSERT INTO automation.task_queue_snapshots (organization_id, payload, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (organization_id) DO UPDATE SET payload = $2, updated_at = now()`,
      [orgResult.rows[0].id, JSON.stringify([legacyTask])],
    );

    const { tasks, paused, humanHolds } = await repository.load();
    assert.equal(tasks[0].kind, "generic", "legacy snapshots default to kind: generic");
    assert.equal(paused, false);
    assert.deepEqual([...humanHolds], []);

    const onDisk = await pool.query("SELECT payload FROM automation.task_queue_snapshots WHERE organization_id = $1", [orgResult.rows[0].id]);
    assert.equal(onDisk.rows[0].payload.version, 2, "the migrated shape is persisted, not just returned in memory");
  });

  await t.test("the snapshot belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query("SELECT organization_id FROM automation.task_queue_snapshots WHERE organization_id = $1", [orgResult.rows[0].id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });

  await t.test("RLS: a different organization cannot see the default organization's snapshot through a real non-superuser role", async () => {
    const unique = crypto.randomBytes(3).toString("hex");
    const testRole = `pf_test_taskqueue_${unique}`;
    const testPassword = crypto.randomBytes(16).toString("hex");
    await pool.query(`CREATE ROLE ${testRole} LOGIN PASSWORD '${testPassword}'`);
    await pool.query(`GRANT USAGE ON SCHEMA automation TO ${testRole}`);
    await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA automation TO ${testRole}`);
    t.after(async () => {
      await pool.query(`DROP OWNED BY ${testRole}`).catch(() => {});
      await pool.query(`DROP ROLE IF EXISTS ${testRole}`).catch(() => {});
    });

    const otherOrg = await pool.query(
      "INSERT INTO identity.organizations (slug, display_name) VALUES ($1, $2) RETURNING id",
      [`other-org-taskqueue-${unique}`, "Other Org"],
    );

    const url = new URL(TEST_DATABASE_URL);
    url.username = testRole;
    url.password = testPassword;
    const roleClient = new pg.Client({ connectionString: url.toString() });
    await roleClient.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [otherOrg.rows[0].id]);
      const rows = await roleClient.query("SELECT * FROM automation.task_queue_snapshots");
      assert.equal(rows.rowCount, 0, "the default organization's snapshot must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
