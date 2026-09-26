// Real-PostgreSQL test for the P3 platform-policies migration script
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
import { migratePoliciesToPostgres } from "../../../scripts/migrate-policies-to-postgres.js";
import { POLICY_VALUES } from "../../../src/actionPolicy.js";
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

test("migrate-policies-to-postgres.js (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-migrate-policies-"));
  const filePath = path.join(root, "action-policy-overrides.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const unique = crypto.randomBytes(3).toString("hex");
  const accountA = `acct-a-${unique}`;
  const accountB = `acct-b-${unique}`;

  fs.writeFileSync(filePath, JSON.stringify({
    overrides: {
      [accountA]: {
        like: { value: POLICY_VALUES.ALLOW_AUTONOMOUS, by: "admin1", at: "2026-01-01T00:00:00.000Z" },
        comment_preset: { value: POLICY_VALUES.REQUIRE_APPROVAL, by: "admin2", at: "2026-01-02T00:00:00.000Z" },
      },
      [accountB]: {
        upvote: { value: POLICY_VALUES.DISABLED, by: "admin1", at: "2026-01-03T00:00:00.000Z" },
        // A hand-edited/corrupt entry — must be skipped, not crash the migration.
        not_a_real_action: { value: "BOGUS_VALUE", by: "admin1", at: "2026-01-03T00:00:00.000Z" },
      },
    },
  }, null, 2));

  await t.test("migrates every valid override exactly, skips the invalid one, and counts reconcile", async () => {
    const { beforeCount, migratedKeys, skippedKeys, afterCount } = await migratePoliciesToPostgres(pool, filePath);
    assert.equal(beforeCount, 4);
    assert.equal(migratedKeys.length, 3);
    assert.deepEqual(skippedKeys, [`${accountB}:not_a_real_action`]);
    assert.ok(afterCount >= 3);

    const row = await pool.query(
      "SELECT value, changed_by, changed_at FROM automation.account_policies WHERE account_id = $1 AND action = $2",
      [accountA, "comment_preset"],
    );
    assert.equal(row.rows[0].value, POLICY_VALUES.REQUIRE_APPROVAL);
    assert.equal(row.rows[0].changed_by, "admin2");
  });

  await t.test("the invalid entry never lands in Postgres at all", async () => {
    const row = await pool.query(
      "SELECT * FROM automation.account_policies WHERE account_id = $1 AND action = $2",
      [accountB, "not_a_real_action"],
    );
    assert.equal(row.rowCount, 0);
  });

  await t.test("re-running the migration is idempotent — upserts, does not duplicate", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM automation.account_policies");
    await migratePoliciesToPostgres(pool, filePath);
    const after = await pool.query("SELECT count(*)::int AS n FROM automation.account_policies");
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  await t.test("every migrated override belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query(
      "SELECT organization_id FROM automation.account_policies WHERE account_id = $1 AND action = $2",
      [accountA, "like"],
    );
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });
});
