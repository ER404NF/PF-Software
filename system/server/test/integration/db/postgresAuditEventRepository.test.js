// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed audit event repository. Skips without
// TEST_DATABASE_URL. Proves parity with the file-backed auditLog.js
// contract (logEvent/listEvents shape, operator/deviceId filtering, newest-
// first ordering, limit) and real tenant isolation on the new
// automation.audit_events table through a non-superuser role.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresAuditEventRepository } from "../../../src/db/repositories/postgresAuditEventRepository.js";
import { assertAuditEventRepository } from "../../../src/persistence/auditEventRepository.js";
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

test("PostgreSQL audit event repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const repository = await createPostgresAuditEventRepository(pool);
  assertAuditEventRepository(repository);

  const unique = crypto.randomBytes(3).toString("hex");
  const operatorA = `va-${unique}-a`;
  const operatorB = `va-${unique}-b`;
  const deviceA = `device-${unique}-a`;
  const deviceB = `device-${unique}-b`;

  await t.test("logEvent() returns the full entry shape and round-trips detail exactly", async () => {
    const event = await repository.logEvent({ operator: operatorA, type: "action_type_text", deviceId: deviceA, detail: { length: 42 } });
    assert.equal(typeof event.id, "string");
    assert.equal(typeof event.at, "string");
    assert.equal(event.operator, operatorA);
    assert.equal(event.type, "action_type_text");
    assert.equal(event.deviceId, deviceA);
    assert.deepEqual(event.detail, { length: 42 });
  });

  await t.test("listEvents() returns newest first", async () => {
    await repository.logEvent({ operator: operatorA, type: "device_selected", deviceId: deviceA });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await repository.logEvent({ operator: operatorA, type: "device_released", deviceId: deviceA });
    const events = await repository.listEvents({ operator: operatorA, deviceId: deviceA });
    assert.equal(events[0].id, second.id, "the most recently logged event must come first");
  });

  await t.test("listEvents() filters by operator and deviceId independently and together", async () => {
    await repository.logEvent({ operator: operatorB, type: "device_selected", deviceId: deviceB });
    await repository.logEvent({ operator: operatorA, type: "device_selected", deviceId: deviceB });

    const byOperator = await repository.listEvents({ operator: operatorA });
    assert.ok(byOperator.every((e) => e.operator === operatorA));
    assert.ok(byOperator.length >= 4);

    const byDevice = await repository.listEvents({ deviceId: deviceB });
    assert.ok(byDevice.every((e) => e.deviceId === deviceB));
    assert.equal(byDevice.length, 2);

    const byBoth = await repository.listEvents({ operator: operatorA, deviceId: deviceB });
    assert.equal(byBoth.length, 1);
    assert.equal(byBoth[0].operator, operatorA);
    assert.equal(byBoth[0].deviceId, deviceB);
  });

  await t.test("listEvents() respects limit and defaults to 200", async () => {
    const burstOperator = `va-${unique}-burst`;
    for (let i = 0; i < 10; i += 1) {
      await repository.logEvent({ operator: burstOperator, type: "action_tap" });
    }
    const limited = await repository.listEvents({ operator: burstOperator, limit: 3 });
    assert.equal(limited.length, 3);
  });

  await t.test("listEvents() on an organization with nothing logged yet returns an empty list", async () => {
    const events = await repository.listEvents({ operator: `va-${unique}-never-logged` });
    assert.deepEqual(events, []);
  });

  await t.test("every event belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const event = await repository.logEvent({ operator: operatorA, type: "device_selected" });
    const row = await pool.query("SELECT organization_id FROM automation.audit_events WHERE id = $1", [event.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });

  await t.test("RLS: a different organization cannot see the default organization's audit events through a real non-superuser role", async () => {
    const event = await repository.logEvent({ operator: operatorA, type: "device_selected" });

    const testRole = `pf_test_audit_${crypto.randomBytes(4).toString("hex")}`;
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
      [`other-org-audit-${unique}`, "Other Org"],
    );

    const url = new URL(TEST_DATABASE_URL);
    url.username = testRole;
    url.password = testPassword;
    const roleClient = new pg.Client({ connectionString: url.toString() });
    await roleClient.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [otherOrg.rows[0].id]);
      const rows = await roleClient.query("SELECT * FROM automation.audit_events WHERE id = $1", [event.id]);
      assert.equal(rows.rowCount, 0, "the default organization's audit event must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
