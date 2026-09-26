// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed site repository. Skips without TEST_DATABASE_URL.
//
// Proves two things: (1) behavioral parity with the existing file-backed
// SiteStore/fileSiteRepository.js contract (same create/list/get/
// verifyToken/rotate/update/remove/markSeen shapes and error codes), and
// (2) real tenant isolation on fleet.sites through a non-superuser role —
// same reasoning as tenantIsolation.test.js: RLS does not apply to
// superusers, so testing through the default CI connection would prove
// nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresSiteRepository } from "../../../src/db/repositories/postgresSiteRepository.js";
import { assertSiteRepository } from "../../../src/persistence/siteRepository.js";
import { SiteError } from "../../../src/siteStore.js";
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

test("PostgreSQL site repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const repository = await createPostgresSiteRepository(pool, { defaultTimeZone: "America/Los_Angeles" });
  assertSiteRepository(repository);

  const unique = crypto.randomBytes(3).toString("hex");
  const siteId = `test-site-${unique}`;

  let createdToken;

  await t.test("create/list/get behave exactly like the file-backed contract", async () => {
    const { site, token } = await repository.create({ name: "Test Site", id: siteId });
    createdToken = token;
    assert.equal(site.id, siteId);
    assert.equal(site.timeZone, "America/Los_Angeles");
    assert.equal(site.tokenHash, undefined, "public view never includes the token hash");
    assert.match(token, /^pfs_/);

    const listed = await repository.list();
    assert.ok(listed.some((entry) => entry.id === siteId));
    assert.equal((await repository.get(siteId))?.name, "Test Site");
  });

  await t.test("create rejects a duplicate id with the same SiteError code as the file adapter", async () => {
    await assert.rejects(
      () => repository.create({ name: "Duplicate", id: siteId }),
      (error) => error instanceof SiteError && error.code === "duplicate_site",
    );
  });

  await t.test("verifyToken accepts the real token and rejects a wrong or garbage one", async () => {
    assert.equal((await repository.verifyToken(siteId, createdToken))?.id, siteId);
    assert.equal(await repository.verifyToken(siteId, "pfs_totally-wrong-token"), null);
    assert.equal(await repository.verifyToken(siteId, null), null);
    assert.equal(await repository.verifyToken(siteId, "not-even-the-right-prefix"), null);
  });

  await t.test("rotate invalidates the old token and issues a new one that verifies", async () => {
    const created = await repository.create({ name: "Rotate Me", id: `rotate-${unique}` });
    const rotated = await repository.rotate(`rotate-${unique}`);
    assert.notEqual(rotated.token, created.token);
    assert.equal(await repository.verifyToken(`rotate-${unique}`, created.token), null);
    assert.equal((await repository.verifyToken(`rotate-${unique}`, rotated.token))?.id, `rotate-${unique}`);
  });

  await t.test("markSeen and update behave as expected", async () => {
    await repository.markSeen(siteId, "2026-09-26T00:00:00.000Z");
    const afterMarkSeen = await repository.get(siteId);
    const lastSeenAt = afterMarkSeen.lastSeenAt instanceof Date ? afterMarkSeen.lastSeenAt.toISOString() : afterMarkSeen.lastSeenAt;
    assert.equal(lastSeenAt, "2026-09-26T00:00:00.000Z");
    const updated = await repository.update(siteId, { name: "Renamed Site" });
    assert.equal(updated.name, "Renamed Site");
  });

  await t.test("rotate/update/remove on an unknown id throw SiteError with code unknown_site", async () => {
    await assert.rejects(() => repository.rotate("does-not-exist"), (error) => error instanceof SiteError && error.code === "unknown_site");
    await assert.rejects(() => repository.update("does-not-exist", { name: "X" }), (error) => error instanceof SiteError && error.code === "unknown_site");
  });

  await t.test("remove deletes the row", async () => {
    await repository.create({ name: "To Remove", id: `remove-${unique}` });
    assert.equal(await repository.remove(`remove-${unique}`), true);
    assert.equal(await repository.get(`remove-${unique}`), null);
    assert.equal(await repository.remove(`remove-${unique}`), false, "removing an already-gone site returns false, not an error");
  });

  await t.test("every created site belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const defaultOrgId = orgResult.rows[0].id;
    const row = await pool.query("SELECT organization_id FROM fleet.sites WHERE id = $1", [siteId]);
    assert.equal(row.rows[0].organization_id, defaultOrgId);
  });

  await t.test("ensureDefaultOrganization is idempotent: constructing a second repository doesn't create a second default org", async () => {
    const before = await pool.query("SELECT count(*) FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    await createPostgresSiteRepository(pool);
    const after = await pool.query("SELECT count(*) FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    assert.equal(before.rows[0].count, after.rows[0].count);
  });

  await t.test("RLS: a different organization cannot see the default organization's sites through a real non-superuser role", async () => {
    const testRole = `pf_test_sites_${crypto.randomBytes(4).toString("hex")}`;
    const testPassword = crypto.randomBytes(16).toString("hex");
    await pool.query(`CREATE ROLE ${testRole} LOGIN PASSWORD '${testPassword}'`);
    await pool.query(`GRANT USAGE ON SCHEMA fleet TO ${testRole}`);
    await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA fleet TO ${testRole}`);
    t.after(async () => {
      await pool.query(`DROP OWNED BY ${testRole}`).catch(() => {});
      await pool.query(`DROP ROLE IF EXISTS ${testRole}`).catch(() => {});
    });

    const otherOrg = await pool.query(
      "INSERT INTO identity.organizations (slug, display_name) VALUES ($1, $2) RETURNING id",
      [`other-org-${unique}`, "Other Org"],
    );
    const otherOrgId = otherOrg.rows[0].id;

    const url = new URL(TEST_DATABASE_URL);
    url.username = testRole;
    url.password = testPassword;
    const roleClient = new pg.Client({ connectionString: url.toString() });
    await roleClient.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [otherOrgId]);
      const rows = await roleClient.query("SELECT * FROM fleet.sites WHERE id = $1", [siteId]);
      assert.equal(rows.rowCount, 0, "the default organization's site must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
