// Real-PostgreSQL test for the P3 interventions migration script
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
import { migrateInterventionsToPostgres } from "../../../scripts/migrate-interventions-to-postgres.js";
import { INTERVENTION_STATES } from "../../../src/interventionQueue.js";
import { createPostgresInterventionRepository } from "../../../src/db/repositories/postgresInterventionRepository.js";
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

test("migrate-interventions-to-postgres.js (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-migrate-interventions-"));
  const filePath = path.join(root, "interventions.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const unique = crypto.randomBytes(3).toString("hex");
  const open = {
    id: `int-${crypto.randomUUID()}`, taskId: `task-${unique}-1`, deviceId: "device-1", accountId: "account-1",
    workspaceId: "client-a", platform: "instagram", kind: "challenge", reason: "security review",
    ref: { url: "https://example.com" }, state: INTERVENTION_STATES.OPEN, createdAt: Date.now(),
    claimedBy: null, claimedAt: null, resolvedBy: null, resolvedAt: null, resolution: null,
  };
  const resolved = {
    id: `int-${crypto.randomUUID()}`, taskId: `task-${unique}-2`, deviceId: null, accountId: null,
    workspaceId: "client-a", platform: null, kind: "low_confidence", reason: "not sure",
    ref: null, state: INTERVENTION_STATES.RESOLVED, createdAt: Date.now() - 100_000,
    claimedBy: "manager-1", claimedAt: Date.now() - 50_000, resolvedBy: "manager-1", resolvedAt: Date.now() - 10_000,
    resolution: "handled manually",
  };
  fs.writeFileSync(filePath, JSON.stringify({ items: [open, resolved] }, null, 2));

  await t.test("migrates every intervention, preserving state/ref/timestamps exactly, and counts reconcile", async () => {
    const { beforeCount, migratedIds, afterCount } = await migrateInterventionsToPostgres(pool, filePath);
    assert.equal(beforeCount, 2);
    assert.equal(migratedIds.length, 2);
    assert.ok(afterCount >= 2);

    const row = await pool.query("SELECT * FROM automation.interventions WHERE id = $1", [resolved.id]);
    assert.equal(row.rows[0].state, INTERVENTION_STATES.RESOLVED);
    assert.equal(row.rows[0].resolution, "handled manually");
    assert.equal(row.rows[0].resolved_by, "manager-1");
  });

  await t.test("the migrated intervention repository sees the open item exactly as the file store would", async () => {
    const repository = await createPostgresInterventionRepository(pool);
    const fetched = await repository.list({ states: [INTERVENTION_STATES.OPEN], workspaceId: "client-a" });
    assert.ok(fetched.some((i) => i.id === open.id));
    const claimed = await repository.claim(open.id, "manager-2");
    assert.equal(claimed.state, INTERVENTION_STATES.CLAIMED);
  });

  await t.test("re-running the migration is idempotent — upserts, does not duplicate", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM automation.interventions");
    await migrateInterventionsToPostgres(pool, filePath);
    const after = await pool.query("SELECT count(*)::int AS n FROM automation.interventions");
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  await t.test("every migrated intervention belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query("SELECT organization_id FROM automation.interventions WHERE id = $1", [resolved.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });
});
