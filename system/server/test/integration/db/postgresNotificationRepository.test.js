// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed notification repository. Skips without TEST_DATABASE_URL.
// Proves parity with the file-backed accountNotificationStore.js contract
// (queue/list/deliveryContent/mark* state transitions, AES-256-GCM recovery
// encryption) and real tenant isolation on the new
// automation.account_notifications table through a non-superuser role.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresNotificationRepository } from "../../../src/db/repositories/postgresNotificationRepository.js";
import { assertNotificationRepository } from "../../../src/persistence/notificationRepository.js";
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

test("PostgreSQL notification repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const encryptionKey = "test-recovery-encryption-key";
  const repository = await createPostgresNotificationRepository(pool, {
    companyEmail: "hello@example.com",
    encryptionKey,
  });
  assertNotificationRepository(repository);

  const unique = crypto.randomBytes(3).toString("hex");

  await t.test("queue() an acceptance notification is queued immediately and lists in descending order", async () => {
    const queued = await repository.queue({ to: `va-${unique}@example.com`, fullName: "VA One", username: `va1-${unique}`, status: "approved" });
    assert.equal(queued.deliveryState, "queued");
    assert.equal(queued.kind, "account_approved");
    assert.equal(queued.from, "hello@example.com");
    assert.match(queued.body, /VA One/);

    const listed = await repository.list();
    assert.ok(listed.some((item) => item.id === queued.id));
    assert.ok(new Date(listed[0].createdAt).getTime() >= new Date(listed.at(-1).createdAt).getTime(), "list() is descending by createdAt");
  });

  await t.test("queue() a rejection with holdForCommit stays pending until markCommitted/markAborted", async () => {
    const queued = await repository.queue({
      to: `va-${unique}-2@example.com`, fullName: "VA Two", username: `va2-${unique}`, status: "rejected", holdForCommit: true,
    });
    assert.equal(queued.kind, "account_rejected");
    assert.equal(queued.deliveryState, "pending_account_commit");

    const committed = await repository.markCommitted(queued.id);
    assert.equal(committed.deliveryState, "queued");
    // Committing twice is a no-op that returns the current (already-advanced) state, not an error.
    const committedAgain = await repository.markCommitted(queued.id);
    assert.equal(committedAgain.deliveryState, "queued");

    const held = await repository.queue({
      to: `va-${unique}-3@example.com`, fullName: "VA Three", username: `va3-${unique}`, status: "rejected", holdForCommit: true,
    });
    const aborted = await repository.markAborted(held.id);
    assert.equal(aborted.deliveryState, "aborted_account_change");
  });

  await t.test("markSent()/markFailed() only advance a currently-queued item, matching the file store's guard", async () => {
    const queued = await repository.queue({ to: `va-${unique}-4@example.com`, fullName: "VA Four", username: `va4-${unique}`, status: "approved" });
    const sent = await repository.markSent(queued.id);
    assert.equal(sent.deliveryState, "sent");
    // Already sent — markFailed must leave it alone rather than clobbering a later, more-accurate state.
    const stillSent = await repository.markFailed(queued.id);
    assert.equal(stillSent.deliveryState, "sent");
  });

  await t.test("mark*() on an unknown id returns null, matching the file store", async () => {
    assert.equal(await repository.markSent("00000000-0000-0000-0000-000000000000"), null);
    assert.equal(await repository.markCommitted("00000000-0000-0000-0000-000000000000"), null);
  });

  await t.test("recovery notifications are stored encrypted at rest and only decrypted through deliveryContent()", async () => {
    const queued = await repository.queue({
      to: `va-${unique}-5@example.com`, fullName: "VA Five", username: `va5-${unique}`, status: "recovery", recoveryToken: "one-time-token-123",
    });
    assert.equal(queued.kind, "account_recovery");
    assert.equal(queued.body, undefined, "the safe/list-facing shape must never carry a plaintext recovery body");

    const row = await pool.query("SELECT body, secure_payload FROM automation.account_notifications WHERE id = $1", [queued.id]);
    assert.equal(row.rows[0].body, null, "recovery bodies are never stored in plaintext");
    assert.equal(row.rows[0].secure_payload.algorithm, "aes-256-gcm");

    const content = await repository.deliveryContent(queued.id);
    assert.match(content.body, /one-time-token-123/, "deliveryContent() is the only path that decrypts the recovery body");
  });

  await t.test("canSecureRecovery() reflects whether an encryption key is configured, with no database access", async () => {
    assert.equal(repository.canSecureRecovery(), true);
    const withoutKey = await createPostgresNotificationRepository(pool, { companyEmail: "hello@example.com" });
    assert.equal(withoutKey.canSecureRecovery(), false);
    await assert.rejects(
      () => withoutKey.queue({ to: "x@example.com", fullName: "X", username: "x", status: "recovery", recoveryToken: "t" }),
      /secure recovery notification storage is not configured/,
    );
  });

  await t.test("every notification belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const queued = await repository.queue({ to: `va-${unique}-6@example.com`, fullName: "VA Six", username: `va6-${unique}`, status: "approved" });
    const row = await pool.query("SELECT organization_id FROM automation.account_notifications WHERE id = $1", [queued.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });

  await t.test("RLS: a different organization cannot see the default organization's notifications through a real non-superuser role", async () => {
    const queued = await repository.queue({ to: `va-${unique}-7@example.com`, fullName: "VA Seven", username: `va7-${unique}`, status: "approved" });

    const testRole = `pf_test_notifications_${crypto.randomBytes(4).toString("hex")}`;
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
      [`other-org-notifications-${unique}`, "Other Org"],
    );

    const url = new URL(TEST_DATABASE_URL);
    url.username = testRole;
    url.password = testPassword;
    const roleClient = new pg.Client({ connectionString: url.toString() });
    await roleClient.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [otherOrg.rows[0].id]);
      const rows = await roleClient.query("SELECT * FROM automation.account_notifications WHERE id = $1", [queued.id]);
      assert.equal(rows.rowCount, 0, "the default organization's notification must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
