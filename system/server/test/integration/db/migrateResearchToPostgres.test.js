// Real-PostgreSQL test for the P3 research migration script
// (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md task P3, step 2).
// Skips without TEST_DATABASE_URL.
//
// researchStore.js derives its file paths from RESEARCH_STORE_DIR at
// import time, so that env var must be set before this file's own dynamic
// import of it — matching the same pattern researchStore.test.js itself
// uses.

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
import { migrateResearchToPostgres } from "../../../scripts/migrate-research-to-postgres.js";
import { createPostgresResearchRunRepository } from "../../../src/db/repositories/postgresResearchRunRepository.js";
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

test("migrate-research-to-postgres.js (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const researchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-migrate-research-"));
  t.after(() => fs.rmSync(researchRoot, { recursive: true, force: true }));
  process.env.RESEARCH_STORE_DIR = researchRoot;
  const store = await import(`../../../src/researchStore.js?migrate-test=${crypto.randomBytes(4).toString("hex")}`);

  const workspaceId = "client-a";
  const account = "acct-1";
  const run = store.createRun(workspaceId, account, {
    platform: "instagram", overview: "Test run",
    candidates: [{ platform_content_id: "post-1", canonical_url: "https://example.com/post-1", tags: ["hook"] }],
  });
  store.setCandidateStatus(workspaceId, account, run.id, run.candidates[0].id, "confirmed");
  // A second workspace/account, proving the migration walks the whole tree, not just one file.
  store.createRun("client-b", "acct-2", { platform: "reddit", overview: "Other workspace", candidates: [] });

  await t.test("migrates every workspace/account file found under the research root, and counts reconcile", async () => {
    const { accountsFound, totalRuns, migratedAccounts, afterCount } = await migrateResearchToPostgres(pool, researchRoot);
    assert.equal(accountsFound, 2);
    assert.equal(totalRuns, 2);
    assert.deepEqual(new Set(migratedAccounts), new Set(["client-a/acct-1", "client-b/acct-2"]));
    assert.ok(afterCount >= 2);
  });

  await t.test("the migrated repository preserves the cross-run dedup review decision exactly (proves candidateIndex round-tripped, not just runs)", async () => {
    const repository = await createPostgresResearchRunRepository(pool);
    const secondObservation = await repository.createRun(workspaceId, account, {
      platform: "instagram", overview: "run 2",
      candidates: [{ platform_content_id: "post-1", canonical_url: "https://example.com/post-1" }],
    });
    assert.equal(secondObservation.candidates[0].status, "confirmed",
      "the earlier human review must survive migration and still be recognized on a later observation");
  });

  await t.test("re-running the migration is idempotent — upserts, does not duplicate", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM automation.research_accounts");
    await migrateResearchToPostgres(pool, researchRoot);
    const after = await pool.query("SELECT count(*)::int AS n FROM automation.research_accounts");
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  await t.test("every migrated account belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query(
      "SELECT organization_id FROM automation.research_accounts WHERE workspace_id = $1 AND account = $2",
      [workspaceId, account],
    );
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });
});
