import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  test("the running server can make PostgreSQL authoritative for sites", {
    skip: "TEST_DATABASE_URL is not set — this test requires a disposable PostgreSQL database",
  }, () => {});
} else {
  const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const systemRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const migrationsDir = path.join(serverRoot, "migrations");
  const migrateBin = path.join(systemRoot, "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js");
  await execFileAsync(process.execPath, [migrateBin, "up", "--migrations-dir", migrationsDir], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-postgres-site-mount-"));
  const fileSitePath = path.join(root, "sites.json");
  Object.assign(process.env, {
    OPERATORS_CONFIG_PATH: path.join(root, "operators.json"),
    FILE_STORE_DIR: path.join(root, "files"),
    SESSION_STORE_DIR: path.join(root, "sessions"),
    AUDIT_LOG_PATH: path.join(root, "audit.log"),
    QUEUE_STORE_PATH: path.join(root, "queue.json"),
    MODEL_SELECTION_STORE_PATH: path.join(root, "models.json"),
    ASSIGNMENT_STORE_PATH: path.join(root, "assignments.json"),
    RESEARCH_STORE_DIR: path.join(root, "research"),
    RESEARCH_EVIDENCE_DIR: path.join(root, "evidence"),
    ACCOUNT_NOTIFICATION_STORE_PATH: path.join(root, "notifications.json"),
    SITE_STORE_PATH: fileSitePath,
    SESSION_SECRET: "postgres-site-mount-test-session-secret",
    TWO_FACTOR_MASTER_KEY: "postgres-site-mount-test-two-factor-key-123456",
    AUTO_DISCOVER_IOS_DEVICES: "false",
    SITE_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: TEST_DATABASE_URL,
  });

  const { server, siteStore, durableRepositories } = await import("../../../src/index.js");
  const { operators, hashPassword } = await import("../../../src/authStore.js");
  const { createPool } = await import("../../../src/db/pool.js");
  const { withTransaction } = await import("../../../src/db/transaction.js");
  const { ensureDefaultOrganization } = await import("../../../src/db/defaultOrganization.js");

  const password = "postgres-site-test-password";
  const username = `site-admin-${crypto.randomBytes(3).toString("hex")}`;
  const siteName = `Mounted Site ${crypto.randomBytes(3).toString("hex")}`;
  const siteId = siteName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  operators.set(username, { username, passwordHash: hashPassword(password), allowedDevices: null, role: "admin" });

  await new Promise(resolve => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  test("the running server can make PostgreSQL authoritative for sites", async (t) => {
    const inspectionPool = createPool({ connectionString: TEST_DATABASE_URL });
    const organization = await ensureDefaultOrganization(inspectionPool);
    t.after(async () => {
      await withTransaction(inspectionPool, client => client.query(
        "DELETE FROM fleet.sites WHERE id = $1 AND organization_id = $2",
        [siteId, organization.id],
      ), { organizationId: organization.id });
      operators.delete(username);
      await new Promise(resolve => server.close(resolve));
      await inspectionPool.end();
      fs.rmSync(root, { recursive: true, force: true });
    });

    assert.equal(durableRepositories.sites, "postgres");

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const created = await fetch(`${baseUrl}/api/admin/sites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: siteName, timeZone: "Europe/Rome" }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.site.id, siteId);
    assert.match(body.token, /^pfs_/);

    const row = await withTransaction(inspectionPool, client => client.query(
      "SELECT name, time_zone FROM fleet.sites WHERE id = $1 AND organization_id = $2",
      [siteId, organization.id],
    ), { organizationId: organization.id });
    assert.equal(row.rowCount, 1);
    assert.deepEqual(row.rows[0], { name: siteName, time_zone: "Europe/Rome" });
    assert.equal(fs.existsSync(fileSitePath), false, "the file fallback must stay untouched while PostgreSQL is authoritative");

    const verified = await siteStore.verifyToken(siteId, body.token);
    assert.equal(verified?.id, siteId, "the live agent-token authority must be the mounted PostgreSQL repository");

    const listed = await fetch(`${baseUrl}/api/admin/sites`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    assert.ok((await listed.json()).sites.some(site => site.id === siteId));
  });
}

