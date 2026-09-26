// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed proxy pool repository. Skips without
// TEST_DATABASE_URL. Proves parity with the file-backed proxyPool.js
// contract (encrypted-at-rest credentials, exclusive per-device lease,
// health updates, public shape never leaking credentials) and real tenant
// isolation on the new automation.proxy_pool table through a non-superuser
// role.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresProxyPoolRepository } from "../../../src/db/repositories/postgresProxyPoolRepository.js";
import { assertProxyPoolRepository } from "../../../src/persistence/proxyPoolRepository.js";
import { decryptProxyPassword } from "../../../src/proxyPool.js";
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

function fields(overrides = {}) {
  return { provider: "Bright Data", protocol: "socks5", host: "proxy.example.com", port: 1080,
    username: "user1", password: "s3cret", country: "us", ...overrides };
}

test("PostgreSQL proxy pool repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const repository = await createPostgresProxyPoolRepository(pool);
  assertProxyPoolRepository(repository);

  await t.test("create() validates fields, encrypts the password at rest, and round-trips through get()/load()", async () => {
    await assert.rejects(() => repository.create(fields({ protocol: "bogus" }), MASTER_KEY), /protocol must be one of/);

    const record = await repository.create(fields(), MASTER_KEY);
    assert.equal(record.country, "US");
    assert.equal(decryptProxyPassword(record, MASTER_KEY), "s3cret");
    assert.notEqual(record.passwordEncrypted, "s3cret", "the password must never be stored in plaintext");

    const row = await pool.query("SELECT password_encrypted FROM automation.proxy_pool WHERE id = $1", [record.id]);
    assert.equal(row.rows[0].password_encrypted, record.passwordEncrypted);

    assert.equal((await repository.get(record.id))?.id, record.id);
    const loaded = await repository.load();
    assert.ok(loaded[record.id]);
  });

  await t.test("assignToDevice() enforces an exclusive per-device lease and releases cleanly", async () => {
    const proxyA = await repository.create(fields({ label: "A" }), MASTER_KEY);
    const proxyB = await repository.create(fields({ label: "B" }), MASTER_KEY);

    const assigned = await repository.assignToDevice({ deviceId: "device-1", proxyId: proxyA.id });
    assert.equal(assigned.leasedToDeviceId, "device-1");
    assert.equal((await repository.forDevice("device-1"))?.id, proxyA.id);

    await assert.rejects(
      () => repository.assignToDevice({ deviceId: "device-2", proxyId: proxyA.id }),
      /already assigned to another device/,
    );

    // Re-assigning device-1 to a different proxy must release proxyA first.
    const reassigned = await repository.assignToDevice({ deviceId: "device-1", proxyId: proxyB.id });
    assert.equal(reassigned.leasedToDeviceId, "device-1");
    assert.equal((await repository.get(proxyA.id))?.leasedToDeviceId, null, "the previously leased proxy must be released");

    await repository.assignToDevice({ deviceId: "device-1", proxyId: null });
    assert.equal(await repository.forDevice("device-1"), null);
  });

  await t.test("remove() refuses to delete a leased proxy, and succeeds once released", async () => {
    const record = await repository.create(fields({ label: "C" }), MASTER_KEY);
    await repository.assignToDevice({ deviceId: "device-3", proxyId: record.id });
    await assert.rejects(() => repository.remove(record.id), /release this proxy from its assigned device/);

    await repository.assignToDevice({ deviceId: "device-3", proxyId: null });
    assert.equal(await repository.remove(record.id), true);
    assert.equal(await repository.get(record.id), null);
    assert.equal(await repository.remove(record.id), false, "removing an already-removed proxy is a clean false, not an error");
  });

  await t.test("updateHealth() stores only the known-safe fields", async () => {
    const record = await repository.create(fields({ label: "D" }), MASTER_KEY);
    const healthy = await repository.updateHealth(record.id, {
      status: "ok", checkedAt: "2026-09-26T00:00:00.000Z", publicIpv4: "1.2.3.4", extraUnknownField: "should be dropped",
    });
    assert.equal(healthy.health.status, "ok");
    assert.equal(healthy.health.publicIpv4, "1.2.3.4");
    assert.equal(healthy.health.extraUnknownField, undefined);
    await assert.rejects(() => repository.updateHealth("px_does-not-exist", { status: "ok" }), /unknown proxy/);
  });

  await t.test("publicList() never exposes host/port/username/password", async () => {
    const record = await repository.create(fields({ label: "E" }), MASTER_KEY);
    const listed = await repository.publicList();
    const entry = listed.find((item) => item.id === record.id);
    assert.ok(entry);
    assert.equal(entry.host, undefined);
    assert.equal(entry.port, undefined);
    assert.equal(entry.username, undefined);
    assert.equal(entry.passwordEncrypted, undefined);
    assert.equal(entry.flag, "🇺🇸");
  });

  await t.test("every proxy belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const record = await repository.create(fields({ label: "F" }), MASTER_KEY);
    const row = await pool.query("SELECT organization_id FROM automation.proxy_pool WHERE id = $1", [record.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });

  await t.test("RLS: a different organization cannot see the default organization's proxies through a real non-superuser role", async () => {
    const record = await repository.create(fields({ label: "G" }), MASTER_KEY);

    const unique = crypto.randomBytes(3).toString("hex");
    const testRole = `pf_test_proxypool_${unique}`;
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
      [`other-org-proxypool-${unique}`, "Other Org"],
    );

    const url = new URL(TEST_DATABASE_URL);
    url.username = testRole;
    url.password = testPassword;
    const roleClient = new pg.Client({ connectionString: url.toString() });
    await roleClient.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [otherOrg.rows[0].id]);
      const rows = await roleClient.query("SELECT * FROM automation.proxy_pool WHERE id = $1", [record.id]);
      assert.equal(rows.rowCount, 0, "the default organization's proxy must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
