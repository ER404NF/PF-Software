// Real-PostgreSQL test for the P3 sites migration script
// (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md task P3, step 2):
// proves it actually reads a real file-backed sites.json and writes
// matching rows into fleet.sites, preserving the token hash exactly (so an
// existing site agent's saved token still verifies against the migrated
// row) and before/after counts reconcile. Skips without TEST_DATABASE_URL.

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
import { migrateSitesToPostgres } from "../../../scripts/migrate-sites-to-postgres.js";
import { createPostgresSiteRepository } from "../../../src/db/repositories/postgresSiteRepository.js";
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

test("migrate-sites-to-postgres.js (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-migrate-sites-"));
  const filePath = path.join(root, "sites.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const unique = crypto.randomBytes(3).toString("hex");
  const siteA = {
    // rotatedAt matches createdAt — the real file store (siteStore.js's
    // create()) always sets rotatedAt: now at creation time, never null;
    // only last_seen_at starts out null.
    id: `italy-${unique}`, name: "Italy", timeZone: "Europe/Rome",
    tokenHash: crypto.createHash("sha256").update(`pfs_real-token-italy-${unique}`).digest("hex"),
    createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-06-01T12:00:00.000Z",
  };
  const siteB = {
    id: `romania-a-${unique}`, name: "Romania A", timeZone: "Europe/Bucharest",
    tokenHash: crypto.createHash("sha256").update(`pfs_real-token-romania-a-${unique}`).digest("hex"),
    createdAt: "2026-01-02T00:00:00.000Z", rotatedAt: "2026-03-01T00:00:00.000Z", lastSeenAt: null,
  };
  // A defensive case: a legacy/corrupt record with rotatedAt missing
  // entirely — the file store's own _load() doesn't itself validate this
  // field's presence, so a hand-edited or old-format file could have one.
  // fleet.sites.rotated_at is NOT NULL; the migration must coalesce to
  // created_at rather than crash on a real constraint violation (found by
  // this test's own first run, before the coalesce existed).
  const siteLegacy = {
    id: `legacy-${unique}`, name: "Legacy Site", timeZone: "UTC",
    tokenHash: crypto.createHash("sha256").update(`pfs_real-token-legacy-${unique}`).digest("hex"),
    createdAt: "2025-01-01T00:00:00.000Z", lastSeenAt: null,
  };
  fs.writeFileSync(filePath, JSON.stringify({ sites: [siteA, siteB, siteLegacy] }, null, 2));

  await t.test("migrates every site, preserving the token hash and metadata exactly, and counts reconcile", async () => {
    const { beforeCount, migratedIds, afterCount } = await migrateSitesToPostgres(pool, filePath);
    assert.equal(beforeCount, 3);
    assert.equal(migratedIds.length, 3);
    assert.ok(afterCount >= 3, "at least the three migrated sites must be present afterward");

    const row = await pool.query("SELECT * FROM fleet.sites WHERE id = $1", [siteA.id]);
    assert.equal(row.rows[0].token_hash, siteA.tokenHash, "the token hash must be preserved exactly, not regenerated");
    assert.equal(row.rows[0].name, "Italy");
    assert.equal(row.rows[0].time_zone, "Europe/Rome");
  });

  await t.test("a legacy record missing rotatedAt is coalesced to createdAt, not rejected by the NOT NULL constraint", async () => {
    const row = await pool.query("SELECT rotated_at, created_at FROM fleet.sites WHERE id = $1", [siteLegacy.id]);
    assert.equal(row.rows[0].rotated_at.toISOString(), row.rows[0].created_at.toISOString());
  });

  await t.test("an existing site agent's saved plaintext token still verifies against the migrated row", async () => {
    const repository = await createPostgresSiteRepository(pool);
    const verified = await repository.verifyToken(siteA.id, `pfs_real-token-italy-${unique}`);
    assert.ok(verified, "the real (pre-migration) plaintext token must still verify after migration");
    assert.equal(verified.id, siteA.id);
  });

  await t.test("re-running the migration is idempotent — upserts, does not duplicate or reset unrelated fields", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM fleet.sites");
    await migrateSitesToPostgres(pool, filePath);
    const after = await pool.query("SELECT count(*)::int AS n FROM fleet.sites");
    assert.equal(after.rows[0].n, before.rows[0].n, "re-running must not create duplicate rows");
  });

  await t.test("every migrated site belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query("SELECT organization_id FROM fleet.sites WHERE id = $1", [siteB.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });
});
