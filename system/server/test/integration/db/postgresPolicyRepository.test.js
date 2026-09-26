// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed policy repository. Skips without TEST_DATABASE_URL.
// Proves parity with the file-backed PolicyStore contract (set/clear/
// effective/describe, validation errors, ALLOW_AUTONOMOUS/REQUIRE_APPROVAL/
// DISABLED precedence), that every method stays synchronous despite being
// Postgres-backed (the whole point of the sync-cache design), that a write
// is visible to a fresh read in the SAME process immediately, that a
// SEPARATE repository instance (simulating another process) only sees it
// after an explicit refresh() — the documented poll-based-eventual-
// consistency limitation, not a silent gap — and real tenant isolation on
// the new automation.account_policies table through a non-superuser role.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresPolicyRepository } from "../../../src/db/repositories/postgresPolicyRepository.js";
import { assertPolicyRepository } from "../../../src/persistence/policyRepository.js";
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

test("PostgreSQL policy repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const unique = crypto.randomBytes(3).toString("hex");
  const account = `acct-${unique}`;

  const repository = await createPostgresPolicyRepository(pool, { now: () => "2026-09-26T00:00:00.000Z" });
  assertPolicyRepository(repository);

  await t.test("set() validates action/value identically to the file store and stays synchronous", () => {
    assert.throws(() => repository.set(account, "not-a-real-action", POLICY_VALUES.ALLOW_AUTONOMOUS), /unknown action/);
    assert.throws(() => repository.set(account, "like", "BOGUS"), /policy must be one of/);

    const returned = repository.set(account, "like", POLICY_VALUES.ALLOW_AUTONOMOUS, "admin1");
    assert.equal(typeof returned.then, "undefined", "set() must return a plain object, not a Promise");
    assert.equal(returned.value, POLICY_VALUES.ALLOW_AUTONOMOUS);
    assert.equal(returned.by, "admin1");
  });

  await t.test("a write is visible to effective()/describe() on the very next line, in the same process", () => {
    repository.set(account, "comment_preset", POLICY_VALUES.REQUIRE_APPROVAL, "admin2");
    const effective = repository.effective(new Map());
    assert.equal(effective.get(account).comment_preset, POLICY_VALUES.REQUIRE_APPROVAL);

    const described = repository.describe(account, new Map());
    const entry = described.find((item) => item.action === "comment_preset");
    assert.equal(entry.policy, POLICY_VALUES.REQUIRE_APPROVAL);
    assert.equal(entry.source, "runtime");
    assert.equal(entry.changedBy, "admin2");
  });

  await t.test("describe() falls back to the configured base policy, then DISABLED, when there is no override", () => {
    const configured = new Map([[account, { upvote: POLICY_VALUES.ALLOW_AUTONOMOUS }]]);
    const described = repository.describe(account, configured);
    assert.equal(described.find((item) => item.action === "upvote").source, "config");
    assert.equal(described.find((item) => item.action === "downvote").source, "default");
    assert.equal(described.find((item) => item.action === "downvote").policy, POLICY_VALUES.DISABLED);
  });

  await t.test("clear() removes the override synchronously and describe() falls back again", () => {
    repository.clear(account, "comment_preset");
    const entry = repository.describe(account, new Map()).find((item) => item.action === "comment_preset");
    assert.equal(entry.source, "default");
    assert.equal(entry.policy, POLICY_VALUES.DISABLED);
  });

  await t.test("the write actually lands in Postgres, not only in the in-memory cache", async () => {
    const row = await pool.query(
      "SELECT value, changed_by FROM automation.account_policies WHERE account_id = $1 AND action = $2",
      [account, "like"],
    );
    assert.equal(row.rows[0].value, POLICY_VALUES.ALLOW_AUTONOMOUS);
    assert.equal(row.rows[0].changed_by, "admin1");
  });

  await t.test("a SEPARATE repository instance only sees the write after an explicit refresh() — documented eventual consistency, not a silent gap", async () => {
    const secondInstance = await createPostgresPolicyRepository(pool, { now: () => "2026-09-26T00:00:00.000Z" });
    // Written AFTER the second instance's construction (its initial load
    // already reflects everything written before it started), so this
    // write is the one whose staleness we're actually proving. set()'s
    // durable write is fire-and-forget by design (see postgresPolicyRepository.js),
    // so wait for the row to actually land in Postgres before asserting on
    // the second instance's staleness — otherwise this test would be racing
    // its own write instead of proving cache staleness.
    repository.set(account, "downvote", POLICY_VALUES.ALLOW_AUTONOMOUS, "admin3");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const row = await pool.query(
        "SELECT 1 FROM automation.account_policies WHERE account_id = $1 AND action = $2",
        [account, "downvote"],
      );
      if (row.rowCount > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(secondInstance.describe(account, new Map()).find((item) => item.action === "downvote").source, "default",
      "a second process's cache must not see another instance's write until it refreshes");
    await secondInstance.refresh();
    assert.equal(secondInstance.describe(account, new Map()).find((item) => item.action === "downvote").source, "runtime",
      "after refresh() the second instance must see the write");
  });

  await t.test("every policy override belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query("SELECT organization_id FROM automation.account_policies WHERE account_id = $1 AND action = $2", [account, "like"]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });

  await t.test("RLS: a different organization cannot see the default organization's policy overrides through a real non-superuser role", async () => {
    const testRole = `pf_test_policy_${unique}`;
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
      [`other-org-policy-${unique}`, "Other Org"],
    );

    const url = new URL(TEST_DATABASE_URL);
    url.username = testRole;
    url.password = testPassword;
    const roleClient = new pg.Client({ connectionString: url.toString() });
    await roleClient.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [otherOrg.rows[0].id]);
      const rows = await roleClient.query(
        "SELECT * FROM automation.account_policies WHERE account_id = $1 AND action = $2",
        [account, "like"],
      );
      assert.equal(rows.rowCount, 0, "the default organization's policy override must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
