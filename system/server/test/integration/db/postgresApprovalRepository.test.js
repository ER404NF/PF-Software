// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed approval repository. Skips without TEST_DATABASE_URL.
// Proves parity with the file-backed ApprovalStore contract (including its
// lazy-expire-on-every-operation semantics) and real tenant isolation on the
// new automation.approvals table through a non-superuser role.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresApprovalRepository } from "../../../src/db/repositories/postgresApprovalRepository.js";
import { assertApprovalRepository } from "../../../src/persistence/approvalRepository.js";
import { ApprovalError, APPROVAL_STATES } from "../../../src/approvalStore.js";
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

test("PostgreSQL approval repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const repository = await createPostgresApprovalRepository(pool, { now: () => clock, ttlMs: 60_000 });
  assertApprovalRepository(repository);

  const unique = crypto.randomBytes(3).toString("hex");
  const subject = { workspaceId: `client-${unique}`, accountId: "account-1", action: "comment", target: "post-1", commentText: "nice post" };

  await t.test("request() deduplicates on fingerprint — asking twice returns the same open approval", async () => {
    const first = await repository.request({ ...subject, requestedBy: "va-1" });
    assert.equal(first.state, APPROVAL_STATES.PENDING);
    const second = await repository.request({ ...subject, requestedBy: "va-1" });
    assert.equal(second.id, first.id, "a second identical request must not create a new row");
  });

  await t.test("decide() approve grants a fresh expiry window; consume() works exactly once", async () => {
    const approval = await repository.request({ ...subject, accountId: "account-2", requestedBy: "va-1" });
    clock += 1_000; // advance the shared fake clock so the decided window is measurably later than the requested one
    const decided = await repository.decide(approval.id, { decision: "approve", decidedBy: "manager-1" });
    assert.equal(decided.state, APPROVAL_STATES.APPROVED);
    assert.ok(decided.expiresAt > approval.expiresAt, "approval must grant a fresh window to actually use it");

    const found = await repository.findApproved({ ...subject, accountId: "account-2" });
    assert.equal(found.id, approval.id);

    const consumed = await repository.consume(approval.id);
    assert.equal(consumed.state, APPROVAL_STATES.CONSUMED);
    assert.equal(await repository.consume(approval.id), null, "consuming twice must return null, not consume again");
  });

  await t.test("decide() rejects an already-decided approval, an unknown id, and a bad decision value", async () => {
    const approval = await repository.request({ ...subject, accountId: "account-3", requestedBy: "va-1" });
    await repository.decide(approval.id, { decision: "reject", decidedBy: "manager-1" });
    await assert.rejects(
      () => repository.decide(approval.id, { decision: "approve", decidedBy: "manager-1" }),
      (error) => error instanceof ApprovalError && error.code === "not_pending",
    );
    await assert.rejects(
      () => repository.decide("apr-does-not-exist", { decision: "approve", decidedBy: "manager-1" }),
      (error) => error instanceof ApprovalError && error.code === "unknown_approval",
    );
    const another = await repository.request({ ...subject, accountId: "account-4", requestedBy: "va-1" });
    await assert.rejects(
      () => repository.decide(another.id, { decision: "maybe", decidedBy: "manager-1" }),
      (error) => error instanceof ApprovalError && error.code === "bad_decision",
    );
  });

  await t.test("a pending approval past its expiry is lazily marked EXPIRED, not silently dropped", async () => {
    const approval = await repository.request({ ...subject, accountId: "account-5", requestedBy: "va-1" });
    clock += 61_000; // past the 60s ttlMs
    const fetched = await repository.get(approval.id);
    assert.equal(fetched.state, APPROVAL_STATES.EXPIRED);
    await assert.rejects(
      () => repository.decide(approval.id, { decision: "approve", decidedBy: "manager-1" }),
      (error) => error instanceof ApprovalError && error.code === "not_pending",
    );
  });

  await t.test("list() filters by workspaceId and state", async () => {
    // A fresh approval, requested at the current (already-advanced) clock
    // value — every approval requested earlier in this suite may have since
    // aged past its own expiry window once the shared fake clock moved
    // forward in the "past its expiry" test above, so this is the only
    // approval this assertion can rely on still being PENDING.
    const fresh = await repository.request({ ...subject, accountId: "account-7", requestedBy: "va-1" });
    const listed = await repository.list({ workspaceId: subject.workspaceId, states: [APPROVAL_STATES.PENDING] });
    assert.ok(listed.length > 0);
    assert.ok(listed.every((a) => a.workspaceId === subject.workspaceId && a.state === APPROVAL_STATES.PENDING));
    assert.ok(listed.some((a) => a.id === fresh.id));
  });

  await t.test("every approval belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const approval = await repository.request({ ...subject, accountId: "account-6", requestedBy: "va-1" });
    const row = await pool.query("SELECT organization_id FROM automation.approvals WHERE id = $1", [approval.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });

  await t.test("RLS: a different organization cannot see the default organization's approvals through a real non-superuser role", async () => {
    const approval = await repository.request({ ...subject, accountId: "account-7", requestedBy: "va-1" });

    const testRole = `pf_test_approvals_${crypto.randomBytes(4).toString("hex")}`;
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
      [`other-org-approvals-${unique}`, "Other Org"],
    );

    const url = new URL(TEST_DATABASE_URL);
    url.username = testRole;
    url.password = testPassword;
    const roleClient = new pg.Client({ connectionString: url.toString() });
    await roleClient.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [otherOrg.rows[0].id]);
      const rows = await roleClient.query("SELECT * FROM automation.approvals WHERE id = $1", [approval.id]);
      assert.equal(rows.rowCount, 0, "the default organization's approval must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
