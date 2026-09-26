// Real-PostgreSQL tenant-isolation test for the identity schema (M03).
// Requires TEST_DATABASE_URL — a throwaway database this test may freely
// create roles/schema objects in and never cleans up beyond its own rows.
// Skips entirely when unset, which is the normal case for local development
// on a machine with no PostgreSQL installed. This is the test
// .github/workflows/db-migrations.yml runs for real against an ephemeral
// PostgreSQL service container — do not consider the migration's RLS
// policies verified until that workflow is green.
//
// This directly implements DATABASE_GAP_ANALYSIS.md's required acceptance
// gate ("Org A cannot SELECT/INSERT/UPDATE/DELETE Org B") for the identity
// schema's tenant-scoped tables, using a real non-superuser role — RLS does
// not apply to superusers or BYPASSRLS roles, so testing through the
// default superuser connection a CI Postgres service provides would prove
// nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — this test only runs against a real PostgreSQL instance (see .github/workflows/db-migrations.yml)";

const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));
const systemRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const migrationsDir = path.join(serverRoot, "migrations");
const migrateBin = path.join(systemRoot, "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js");

async function runMigrations(databaseUrl, direction) {
  // node-pg-migrate's "down" defaults to reverting only the single most
  // recently applied migration (count=1). This project has more than one
  // migration now, so "down" must pass an explicit "0" (revert everything)
  // to actually empty the schema — see docs/productionization/M03_POSTGRES_FOUNDATION.md.
  const args = direction === "down"
    ? [migrateBin, "down", "0", "--migrations-dir", migrationsDir]
    : [migrateBin, direction, "--migrations-dir", migrationsDir];
  await execFileAsync(process.execPath, args, { env: { ...process.env, DATABASE_URL: databaseUrl } });
}

function asRole(databaseUrl, username, password) {
  const url = new URL(databaseUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

test("PostgreSQL identity schema: tenant isolation via RLS", { skip }, async (t) => {
  const adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  const testRole = `pf_test_app_${crypto.randomBytes(4).toString("hex")}`;
  const testPassword = crypto.randomBytes(16).toString("hex");
  let appPool;

  t.after(async () => {
    await appPool?.end().catch(() => {});
    await adminPool.query(`DROP OWNED BY ${testRole}`).catch(() => {});
    await adminPool.query(`DROP ROLE IF EXISTS ${testRole}`).catch(() => {});
    await adminPool.end().catch(() => {});
  });

  await runMigrations(TEST_DATABASE_URL, "up");

  await adminPool.query(`CREATE ROLE ${testRole} LOGIN PASSWORD '${testPassword}'`);
  await adminPool.query(`GRANT USAGE ON SCHEMA identity TO ${testRole}`);
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO ${testRole}`);

  const orgA = await adminPool.query(
    "INSERT INTO identity.organizations (slug, display_name) VALUES ($1, $2) RETURNING id",
    [`org-a-${crypto.randomUUID()}`, "Org A"],
  );
  const orgB = await adminPool.query(
    "INSERT INTO identity.organizations (slug, display_name) VALUES ($1, $2) RETURNING id",
    [`org-b-${crypto.randomUUID()}`, "Org B"],
  );
  const orgAId = orgA.rows[0].id;
  const orgBId = orgB.rows[0].id;

  appPool = new pg.Pool({ connectionString: asRole(TEST_DATABASE_URL, testRole, testPassword) });

  await t.test("a role with no tenant context set sees nothing (fail closed, not fail open)", async () => {
    const client = await appPool.connect();
    try {
      const rows = await client.query("SELECT * FROM identity.workspaces");
      assert.equal(rows.rowCount, 0);
    } finally {
      client.release();
    }
  });

  await t.test("Org A can create and read its own workspace", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [orgAId]);
      await client.query(
        "INSERT INTO identity.workspaces (organization_id, name, slug) VALUES ($1, $2, $3)",
        [orgAId, "Org A workspace", "org-a-workspace"],
      );
      const rows = await client.query("SELECT * FROM identity.workspaces WHERE organization_id = $1", [orgAId]);
      assert.equal(rows.rowCount, 1);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  await t.test("Org B cannot SELECT Org A's workspace", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [orgBId]);
      const rows = await client.query("SELECT * FROM identity.workspaces WHERE organization_id = $1", [orgAId]);
      assert.equal(rows.rowCount, 0, "RLS must hide Org A's row from an Org B context");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  await t.test("Org B cannot INSERT a row claiming to belong to Org A", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [orgBId]);
      await assert.rejects(
        () => client.query(
          "INSERT INTO identity.workspaces (organization_id, name, slug) VALUES ($1, $2, $3)",
          [orgAId, "Forged workspace", "forged-workspace"],
        ),
        /row-level security|violates row-level security policy/i,
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  await t.test("Org B cannot UPDATE or DELETE Org A's workspace even by primary key", async () => {
    const admin = await adminPool.query("SELECT id FROM identity.workspaces WHERE organization_id = $1", [orgAId]);
    const workspaceId = admin.rows[0].id;
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [orgBId]);
      const updated = await client.query("UPDATE identity.workspaces SET name = 'hijacked' WHERE id = $1", [workspaceId]);
      assert.equal(updated.rowCount, 0, "UPDATE must affect zero rows, not throw and not succeed");
      const deleted = await client.query("DELETE FROM identity.workspaces WHERE id = $1", [workspaceId]);
      assert.equal(deleted.rowCount, 0, "DELETE must affect zero rows");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  await t.test("memberships_self_read: a user can read their own memberships across BOTH organizations, but not another user's", async () => {
    const userA = await adminPool.query(
      "INSERT INTO identity.users (display_name, status) VALUES ('User A', 'active') RETURNING id",
    );
    const userB = await adminPool.query(
      "INSERT INTO identity.users (display_name, status) VALUES ('User B', 'active') RETURNING id",
    );
    const userAId = userA.rows[0].id;
    const userBId = userB.rows[0].id;
    // User A belongs to both Org A and Org B; User B belongs only to Org A.
    await adminPool.query("INSERT INTO identity.memberships (organization_id, user_id) VALUES ($1, $2)", [orgAId, userAId]);
    await adminPool.query("INSERT INTO identity.memberships (organization_id, user_id) VALUES ($1, $2)", [orgBId, userAId]);
    await adminPool.query("INSERT INTO identity.memberships (organization_id, user_id) VALUES ($1, $2)", [orgAId, userBId]);

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userAId]);
      // No organization context at all — only the self-read policy applies.
      const ownRows = await client.query("SELECT organization_id FROM identity.memberships WHERE user_id = $1", [userAId]);
      assert.equal(ownRows.rowCount, 2, "User A must see both of their own memberships, across two organizations");

      const otherRows = await client.query("SELECT organization_id FROM identity.memberships WHERE user_id = $1", [userBId]);
      assert.equal(otherRows.rowCount, 0, "User A's self-read context must not expose User B's memberships");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

test("PostgreSQL migration round-trip: up then down leaves no identity schema behind", { skip }, async () => {
  await runMigrations(TEST_DATABASE_URL, "up");
  await runMigrations(TEST_DATABASE_URL, "down");
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    const result = await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'identity'");
    assert.equal(result.rowCount, 0, "down migration must remove the identity schema");
  } finally {
    await pool.end();
  }
});
