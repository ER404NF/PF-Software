// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed intervention repository. Skips without TEST_DATABASE_URL.
// Proves parity with the file-backed InterventionQueue contract and real
// tenant isolation on the new automation.interventions table through a
// non-superuser role.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresInterventionRepository } from "../../../src/db/repositories/postgresInterventionRepository.js";
import { assertInterventionRepository } from "../../../src/persistence/interventionRepository.js";
import { INTERVENTION_STATES } from "../../../src/interventionQueue.js";
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

test("PostgreSQL intervention repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const repository = await createPostgresInterventionRepository(pool);
  assertInterventionRepository(repository);

  const unique = crypto.randomBytes(3).toString("hex");

  await t.test("open() deduplicates on task+kind — a worker handing off the same problem doesn't bury the queue", async () => {
    const first = await repository.open({ taskId: `task-${unique}-1`, workspaceId: "client-a", reason: "security or account challenge" });
    assert.equal(first.state, INTERVENTION_STATES.OPEN);
    assert.equal(first.kind, "challenge", "kind is auto-classified from reason when not given explicitly");
    const second = await repository.open({ taskId: `task-${unique}-1`, workspaceId: "client-a", reason: "security or account challenge" });
    assert.equal(second.id, first.id);
  });

  await t.test("claim() then resolve() transitions correctly, and a second claim by someone else is rejected", async () => {
    const item = await repository.open({ taskId: `task-${unique}-2`, workspaceId: "client-a", kind: "low_confidence", reason: "not sure" });
    const claimed = await repository.claim(item.id, "manager-1");
    assert.equal(claimed.state, INTERVENTION_STATES.CLAIMED);
    await assert.rejects(() => repository.claim(item.id, "manager-2"), /Already claimed by manager-1/);

    const resolved = await repository.resolve(item.id, { by: "manager-1", resolution: "handled manually" });
    assert.equal(resolved.state, INTERVENTION_STATES.RESOLVED);
    // Resolving an already-resolved item is a no-op, not an error.
    const resolvedAgain = await repository.resolve(item.id, { by: "manager-2", resolution: "should not apply" });
    assert.equal(resolvedAgain.resolvedBy, "manager-1", "an already-resolved item must not be overwritten");
  });

  await t.test("claim()/resolve() on an unknown id throw the same plain-Error message as the file store", async () => {
    await assert.rejects(() => repository.claim("int-does-not-exist", "manager-1"), /Unknown intervention\./);
    await assert.rejects(() => repository.resolve("int-does-not-exist"), /Unknown intervention\./);
  });

  await t.test("resolveForTask() closes every open item for that task at once", async () => {
    const taskId = `task-${unique}-3`;
    await repository.open({ taskId, workspaceId: "client-a", kind: "low_confidence", reason: "a" });
    await repository.open({ taskId, workspaceId: "client-a", kind: "challenge", reason: "b" });
    const count = await repository.resolveForTask(taskId, { by: "system", resolution: "task moved on" });
    assert.equal(count, 2);
    const counts = await repository.counts();
    assert.ok(counts.RESOLVED >= 2);
  });

  await t.test("list() filters by state and workspaceId", async () => {
    const listed = await repository.list({ states: [INTERVENTION_STATES.OPEN], workspaceId: "client-a" });
    assert.ok(listed.every((item) => item.state === INTERVENTION_STATES.OPEN && item.workspaceId === "client-a"));
  });

  await t.test("every intervention belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const item = await repository.open({ taskId: `task-${unique}-4`, workspaceId: "client-a", reason: "x" });
    const row = await pool.query("SELECT organization_id FROM automation.interventions WHERE id = $1", [item.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });

  await t.test("RLS: a different organization cannot see the default organization's interventions through a real non-superuser role", async () => {
    const item = await repository.open({ taskId: `task-${unique}-5`, workspaceId: "client-a", reason: "x" });

    const testRole = `pf_test_interventions_${crypto.randomBytes(4).toString("hex")}`;
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
      [`other-org-interventions-${unique}`, "Other Org"],
    );

    const url = new URL(TEST_DATABASE_URL);
    url.username = testRole;
    url.password = testPassword;
    const roleClient = new pg.Client({ connectionString: url.toString() });
    await roleClient.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [otherOrg.rows[0].id]);
      const rows = await roleClient.query("SELECT * FROM automation.interventions WHERE id = $1", [item.id]);
      assert.equal(rows.rowCount, 0, "the default organization's intervention must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
