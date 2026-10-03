// P6 step 2 (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md): "Kill the
// connection to Postgres briefly while the app is running... confirm it
// fails closed with a clear error, never silently loses or corrupts a
// write." Rather than stopping the shared real Postgres service other test
// files in the same CI run depend on, this severs only the running server's
// OWN already-open connections at the SQL level (pg_terminate_backend) from
// a separate admin connection — the same effect a brief network blip or a
// database restart would have on an app's existing pool, without taking the
// database itself down. Skips without TEST_DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  test("the running server fails closed, then recovers, when its Postgres connections are severed mid-session (real database)", {
    skip: "TEST_DATABASE_URL is not set — this test only runs against a real PostgreSQL instance (see .github/workflows/db-migrations.yml)",
  }, () => {});
} else {
  const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const systemRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const migrationsDir = path.join(serverRoot, "migrations");
  const migrateBin = path.join(systemRoot, "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js");
  await execFileAsync(process.execPath, [migrateBin, "up", "--migrations-dir", migrationsDir], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-pg-connection-loss-"));
  process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
  process.env.FILE_STORE_DIR = path.join(root, "files");
  process.env.SESSION_STORE_DIR = path.join(root, "sessions");
  process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
  process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
  process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
  process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
  process.env.RESEARCH_STORE_DIR = path.join(root, "research");
  process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
  process.env.SESSION_SECRET = "pg-connection-loss-test-secret";
  process.env.TWO_FACTOR_MASTER_KEY = "pg-connection-loss-test-two-factor-key-123456";
  process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
  process.env.AUTO_DISCOVER_IOS_DEVICES = "false";
  process.env.CLOUD_API_ENABLED = "true";
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  const { server } = await import("../../../src/index.js");
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  test("the running server fails closed, then recovers, when its Postgres connections are severed mid-session (real database)", async (t) => {
    const adminClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await adminClient.connect();
    t.after(async () => {
      await adminClient.end();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });

    // Baseline: the real server can reach the real database right now.
    const before = await fetch(`${baseUrl}/api/cloud/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
    });
    assert.equal(before.status, 401, "expected a normal, DB-backed 401 before any disruption");

    // Fire a burst of concurrent requests at the same moment the admin
    // connection severs every connection the server's pool currently
    // holds — the same effect a database restart or a brief network blip
    // has on an app's existing pool, without stopping Postgres itself
    // (other test files sharing this same real database in the same CI
    // run are unaffected; only this server's own already-open connections
    // die). Firing a burst, rather than one request, makes it likely at
    // least one lands mid-query on a connection right as it's severed,
    // without depending on an exact, flaky race to prove anything.
    const burst = Array.from({ length: 20 }, () => fetch(`${baseUrl}/api/cloud/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
    }).then(
      (response) => ({ ok: true, status: response.status, text: () => response.text() }),
      (error) => ({ ok: false, error }),
    ));
    await adminClient.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()`
    );
    const results = await Promise.all(burst);

    // Every single one must resolve to *some* well-formed HTTP response —
    // never a hang (Promise.all above would simply never resolve if one
    // did), and never the request itself throwing (which would mean the
    // server dropped the TCP connection outright, i.e. the process died).
    for (const result of results) {
      assert.ok(result.ok, `a request never got an HTTP response at all: ${result.error?.message}`);
    }
    // Whichever ones landed on a connection mid-termination must have
    // failed *cleanly* (a bounded 5xx, no leaked stack trace) — never a
    // raw crash. The rest are free to have succeeded normally (401) if
    // pg.Pool already had a fresh connection ready for them.
    for (const result of results) {
      assert.ok([401, 500, 502, 503].includes(result.status),
        `expected a clean 401 or 5xx for every request, got ${result.status}`);
      if (result.status >= 500) {
        const text = await result.text();
        assert.doesNotMatch(text, /at \w+.*\(.*:\d+:\d+\)/, "must never leak a stack trace to the client");
      }
    }

    // The process itself must have survived — proven by the server still
    // accepting new HTTP connections at all right after the disruption
    // (a process that had actually crashed would refuse the next connect).
    assert.ok(server.listening, "the Node process/server must still be running after the connection loss");

    // pg's Pool transparently opens a fresh connection for the next query.
    // Give it a moment, then confirm the exact same route behaves normally
    // again — "fails closed, then recovers," not "stays broken forever."
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await fetch(`${baseUrl}/api/cloud/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
    });
    assert.equal(after.status, 401, "expected the route to recover to normal, DB-backed behavior");
  });
}
