// Real-PostgreSQL test for the P3 approvals migration script
// (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md task P3, step 2).
// Skips without TEST_DATABASE_URL.

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
import { migrateApprovalsToPostgres } from "../../../scripts/migrate-approvals-to-postgres.js";
import { APPROVAL_STATES, approvalFingerprint } from "../../../src/approvalStore.js";
import { createPostgresApprovalRepository } from "../../../src/db/repositories/postgresApprovalRepository.js";
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

test("migrate-approvals-to-postgres.js (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-migrate-approvals-"));
  const filePath = path.join(root, "research-approvals.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const unique = crypto.randomBytes(3).toString("hex");
  const subject = { workspaceId: `client-${unique}`, accountId: "account-1", action: "comment", target: "post-1", commentText: "nice post" };
  // A far-future expiresAt: the migrated repository's own lazy expiration
  // compares against real Date.now() on every read, so a fixed past epoch
  // (this test was first written with one) gets auto-expired the moment the
  // test runs — correct adapter behavior, but the wrong fixture for a
  // still-PENDING approval.
  const farFutureExpiry = Date.now() + 24 * 3_600_000;
  const pending = {
    id: `apr-${crypto.randomUUID()}`, fingerprint: approvalFingerprint(subject), workspaceId: subject.workspaceId,
    accountId: subject.accountId, taskId: "task-1", deviceId: "device-1", action: subject.action, target: subject.target,
    commentText: subject.commentText, requestedBy: "va-1", context: { note: "context data" },
    state: APPROVAL_STATES.PENDING, requestedAt: Date.now(), expiresAt: farFutureExpiry,
    decidedAt: null, decidedBy: null, reason: null, consumedAt: null,
  };
  const decided = {
    // CONSUMED is a terminal state, never touched by lazy expiration
    // regardless of expiresAt, so a past timestamp here is fine and
    // realistic (this approval's window closed long ago; it was already
    // used before it did).
    id: `apr-${crypto.randomUUID()}`, fingerprint: approvalFingerprint({ ...subject, accountId: "account-2" }),
    workspaceId: subject.workspaceId, accountId: "account-2", taskId: null, deviceId: null, action: subject.action,
    target: subject.target, commentText: subject.commentText, requestedBy: "va-1", context: null,
    state: APPROVAL_STATES.CONSUMED, requestedAt: 1_700_000_000_000, expiresAt: 1_700_086_400_000,
    decidedAt: 1_700_000_100_000, decidedBy: "manager-1", reason: "looked good", consumedAt: 1_700_000_200_000,
  };
  fs.writeFileSync(filePath, JSON.stringify({ approvals: [pending, decided] }, null, 2));

  await t.test("migrates every approval, preserving state/timestamps/context exactly, and counts reconcile", async () => {
    const { beforeCount, migratedIds, afterCount } = await migrateApprovalsToPostgres(pool, filePath);
    assert.equal(beforeCount, 2);
    assert.equal(migratedIds.length, 2);
    assert.ok(afterCount >= 2);

    const row = await pool.query("SELECT * FROM automation.approvals WHERE id = $1", [decided.id]);
    assert.equal(row.rows[0].state, APPROVAL_STATES.CONSUMED);
    assert.equal(Number(row.rows[0].decided_at), decided.decidedAt);
    assert.equal(Number(row.rows[0].consumed_at), decided.consumedAt);
    assert.equal(row.rows[0].reason, "looked good");
  });

  await t.test("the migrated approval repository finds the pending approval exactly as the file store would", async () => {
    const repository = await createPostgresApprovalRepository(pool);
    const found = await repository.findApproved({}); // wrong state on purpose: only APPROVED matches findApproved
    assert.equal(found, null, "a PENDING approval must not be returned by findApproved()");
    const fetched = await repository.get(pending.id);
    assert.equal(fetched.state, APPROVAL_STATES.PENDING);
    assert.equal(fetched.context.note, "context data");
  });

  await t.test("re-running the migration is idempotent — upserts, does not duplicate", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM automation.approvals");
    await migrateApprovalsToPostgres(pool, filePath);
    const after = await pool.query("SELECT count(*)::int AS n FROM automation.approvals");
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  await t.test("every migrated approval belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const row = await pool.query("SELECT organization_id FROM automation.approvals WHERE id = $1", [pending.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });
});
