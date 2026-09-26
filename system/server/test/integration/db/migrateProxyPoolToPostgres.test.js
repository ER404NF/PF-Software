// Real-PostgreSQL test for the P3 proxy-pool migration script
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
import { migrateProxyPoolToPostgres } from "../../../scripts/migrate-proxy-pool-to-postgres.js";
import { createProxy, decryptProxyPassword } from "../../../src/proxyPool.js";
import { createPostgresProxyPoolRepository } from "../../../src/db/repositories/postgresProxyPoolRepository.js";
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

const MASTER_KEY = "test-master-key-at-least-32-characters-long";

test("migrate-proxy-pool-to-postgres.js (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-migrate-proxypool-"));
  const filePath = path.join(root, "proxy-pool.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Uses the real proxyPool.js writer (createProxy), not a hand-built
  // fixture, so the encrypted password is genuine ciphertext exactly as it
  // would exist in a real proxy-pool.json.
  const record = createProxy(filePath, {
    provider: "Bright Data", protocol: "socks5", host: "proxy.example.com", port: 1080,
    username: "user1", password: "s3cret", country: "us", label: "Italy proxy",
  }, MASTER_KEY);

  await t.test("migrates the proxy, preserving the encrypted password verbatim, and counts reconcile", async () => {
    const { beforeCount, migratedIds, afterCount } = await migrateProxyPoolToPostgres(pool, filePath);
    assert.equal(beforeCount, 1);
    assert.equal(migratedIds.length, 1);
    assert.ok(afterCount >= 1);

    const row = await pool.query("SELECT * FROM automation.proxy_pool WHERE id = $1", [record.id]);
    assert.equal(row.rows[0].password_encrypted, record.passwordEncrypted, "the ciphertext must be preserved exactly, not re-encrypted");
    assert.equal(row.rows[0].label, "Italy proxy");
  });

  await t.test("the real (pre-migration) password still decrypts correctly through the migrated row", async () => {
    const repository = await createPostgresProxyPoolRepository(pool);
    const migrated = await repository.get(record.id);
    assert.equal(decryptProxyPassword(migrated, MASTER_KEY), "s3cret");
  });

  await t.test("re-running the migration is idempotent — upserts, does not duplicate", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM automation.proxy_pool");
    await migrateProxyPoolToPostgres(pool, filePath);
    const after = await pool.query("SELECT count(*)::int AS n FROM automation.proxy_pool");
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  await t.test("every migrated proxy belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query("SELECT organization_id FROM automation.proxy_pool WHERE id = $1", [record.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });
});
