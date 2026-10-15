import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { createPostgresNotificationRepository } from "../../../src/db/repositories/postgresNotificationRepository.js";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : "TEST_DATABASE_URL is not set — migration preservation requires real PostgreSQL";
const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));
const systemRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const migrateBin = path.join(systemRoot, "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js");
const migrationsDir = path.join(serverRoot, "migrations");

function migrate(args) {
  return execFileAsync(process.execPath, [migrateBin, ...args, "--migrations-dir", migrationsDir], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

test("durable notification migration is idempotent on up and refuses data-destructive down", { skip }, async t => {
  await migrate(["up"]);
  await migrate(["up"]);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const repository = await createPostgresNotificationRepository(pool, { companyEmail: "sender@example.com", encryptionKey: "migration-test-key" });
  const row = await repository.queue({ to: "migration@example.com", status: "received", fullName: "Migration", username: "migration" });
  await assert.rejects(migrate(["down"]), /intentionally irreversible/);
  const retained = await pool.query("SELECT id FROM automation.account_notifications WHERE id = $1", [row.id]);
  assert.equal(retained.rowCount, 1, "failed rollback preserves lifecycle notification data");
  const columns = await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'automation' AND table_name = 'account_notifications'`);
  const names = new Set(columns.rows.map(item => item.column_name));
  for (const name of ["idempotency_key", "attempt_cycle_count", "manual_retry_count", "claim_token", "claim_expires_at"]) assert.ok(names.has(name));

  const constraints = await pool.query(`SELECT conname FROM pg_constraint
    WHERE conrelid = 'automation.account_notifications'::regclass`);
  const constraintNames = new Set(constraints.rows.map(item => item.conname));
  for (const name of [
    "account_notifications_kind_check",
    "account_notifications_delivery_state_check",
    "account_notifications_payload_check",
    "account_notifications_claim_check",
  ]) assert.ok(constraintNames.has(name), `missing ${name}`);

  const indexes = await pool.query(`SELECT indexname FROM pg_indexes
    WHERE schemaname = 'automation' AND tablename = 'account_notifications'`);
  const indexNames = new Set(indexes.rows.map(item => item.indexname));
  assert.ok(indexNames.has("account_notifications_idempotency_idx"));
  assert.ok(indexNames.has("account_notifications_delivery_idx"));
});
