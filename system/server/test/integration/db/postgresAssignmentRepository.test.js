// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed assignment repository. Skips without TEST_DATABASE_URL.
// Proves parity with the file-backed assignmentStore.js contract (state
// transitions, overlap-conflict detection, recurrence advancement, history)
// and real tenant isolation through a non-superuser role.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresAssignmentRepository } from "../../../src/db/repositories/postgresAssignmentRepository.js";
import { assertAssignmentRepository } from "../../../src/persistence/assignmentRepository.js";
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

test("PostgreSQL assignment repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const repository = await createPostgresAssignmentRepository(pool, { now: () => new Date(clock) });
  assertAssignmentRepository(repository);

  const unique = crypto.randomBytes(3).toString("hex");

  await t.test("create/list/get behave as expected, with an initial history entry", async () => {
    const created = await repository.create({ instructions: "Check device health", assignee: `va-${unique}`, createdBy: `manager-${unique}` });
    assert.equal(created.status, "assigned");
    assert.equal(created.history.length, 1);
    assert.equal(created.history[0].action, "created");
    assert.equal((await repository.get(created.id)).instructions, "Check device health");
    assert.ok((await repository.list()).some((a) => a.id === created.id));
  });

  await t.test("create rejects an overlapping exclusive assignment on the same device", async () => {
    const deviceId = `device-${unique}-1`;
    await repository.create({
      instructions: "First shift", assignee: `va-a-${unique}`, createdBy: `manager-${unique}`, deviceId,
      startAt: "2026-02-01T00:00:00.000Z", endAt: "2026-02-01T08:00:00.000Z",
    });
    await assert.rejects(
      () => repository.create({
        instructions: "Overlapping shift", assignee: `va-b-${unique}`, createdBy: `manager-${unique}`, deviceId,
        startAt: "2026-02-01T04:00:00.000Z", endAt: "2026-02-01T12:00:00.000Z",
      }),
      /overlaps active assignment/,
    );
    // A non-overlapping window on the same device succeeds.
    const second = await repository.create({
      instructions: "Second shift", assignee: `va-b-${unique}`, createdBy: `manager-${unique}`, deviceId,
      startAt: "2026-02-01T08:00:00.000Z", endAt: "2026-02-01T16:00:00.000Z",
    });
    assert.equal(second.status, "assigned");
  });

  await t.test("setStatus enforces the state machine and appends history", async () => {
    const assignment = await repository.create({ instructions: "State machine test", assignee: `va-${unique}`, createdBy: `manager-${unique}` });
    await assert.rejects(() => repository.setStatus(assignment.id, "completed", `manager-${unique}`), /cannot move assignment from assigned to completed/);
    const inProgress = await repository.setStatus(assignment.id, "in_progress", `va-${unique}`);
    assert.equal(inProgress.status, "in_progress");
    assert.equal(inProgress.history.length, 2);
    const completed = await repository.setStatus(assignment.id, "completed", `va-${unique}`);
    assert.equal(completed.status, "completed");
    // Setting to the same status again is a no-op that does not append history.
    await assert.rejects(() => repository.setStatus(assignment.id, "in_progress", `va-${unique}`), /cannot move assignment from completed to in_progress/);
  });

  await t.test("setStatus('completed') on a recurring assignment advances the window instead of terminating it", async () => {
    const assignment = await repository.create({
      instructions: "Daily check-in", assignee: `va-daily-${unique}`, createdBy: `manager-${unique}`,
      startAt: "2026-03-01T09:00:00.000Z", endAt: "2026-03-01T10:00:00.000Z", recurrence: "daily", timezone: "UTC",
    });
    clock = Date.parse("2026-03-01T09:15:00.000Z"); // after startAt, so the in_progress transition below is legitimate
    await repository.setStatus(assignment.id, "in_progress", `va-daily-${unique}`);
    clock = Date.parse("2026-03-01T09:30:00.000Z");
    const completed = await repository.setStatus(assignment.id, "completed", `va-daily-${unique}`);
    assert.equal(completed.status, "assigned", "a recurring assignment reopens for the next occurrence instead of terminating");
    assert.equal(completed.occurrence, 2);
    assert.equal(completed.startAt, "2026-03-02T09:00:00.000Z");
    assert.ok(completed.history.some((h) => h.action === "recurrence_completed"));
  });

  await t.test("reassign changes the assignee, resets to 'assigned', and rejects for terminal assignments", async () => {
    const assignment = await repository.create({ instructions: "Reassign test", assignee: `va-old-${unique}`, createdBy: `manager-${unique}` });
    const reassigned = await repository.reassign(assignment.id, `va-new-${unique}`, `manager-${unique}`);
    assert.equal(reassigned.assignee, `va-new-${unique}`);
    assert.ok(reassigned.history.some((h) => h.action === "reassigned"));

    const terminal = await repository.create({ instructions: "Will be cancelled", assignee: `va-${unique}`, createdBy: `manager-${unique}` });
    await repository.setStatus(terminal.id, "cancelled", `manager-${unique}`);
    await assert.rejects(() => repository.reassign(terminal.id, `va-other-${unique}`, `manager-${unique}`), /terminal assignments cannot be reassigned/);
  });

  await t.test("renamePrincipal renames both assignee and createdBy matches and returns only the changed rows", async () => {
    const oldName = `old-name-${unique}`;
    const asAssignee = await repository.create({ instructions: "A", assignee: oldName, createdBy: `manager-${unique}` });
    const asCreator = await repository.create({ instructions: "B", assignee: `va-${unique}`, createdBy: oldName });
    const untouched = await repository.create({ instructions: "C", assignee: `someone-else-${unique}`, createdBy: `manager-${unique}` });

    const renamed = await repository.renamePrincipal(oldName, `new-name-${unique}`, "system");
    assert.equal(renamed.length, 2);
    assert.equal((await repository.get(asAssignee.id)).assignee, `new-name-${unique}`);
    assert.equal((await repository.get(asCreator.id)).createdBy, `new-name-${unique}`);
    assert.equal((await repository.get(untouched.id)).assignee, `someone-else-${unique}`, "an unrelated assignment must be untouched");
  });

  await t.test("reschedule updates the window and rejects for terminal assignments", async () => {
    const assignment = await repository.create({ instructions: "Reschedule test", assignee: `va-${unique}`, createdBy: `manager-${unique}` });
    const rescheduled = await repository.reschedule(assignment.id, {
      startAt: "2026-04-01T00:00:00.000Z", endAt: "2026-04-01T01:00:00.000Z", exclusive: true,
    }, `manager-${unique}`);
    assert.equal(rescheduled.startAt, "2026-04-01T00:00:00.000Z");
    assert.ok(rescheduled.history.some((h) => h.action === "rescheduled"));

    clock = Date.parse("2026-04-01T00:30:00.000Z"); // after the rescheduled startAt, so in_progress is legitimate
    await repository.setStatus(assignment.id, "in_progress", `va-${unique}`);
    await repository.setStatus(assignment.id, "completed", `va-${unique}`);
    await assert.rejects(
      () => repository.reschedule(assignment.id, { startAt: null, endAt: null, exclusive: true }, `manager-${unique}`),
      /terminal assignments cannot be rescheduled/,
    );
  });

  await t.test("expireDue expires a non-recurring assignment past its window", async () => {
    const assignment = await repository.create({
      instructions: "One-off", assignee: `va-expire-${unique}`, createdBy: `manager-${unique}`,
      startAt: "2026-05-01T00:00:00.000Z", endAt: "2026-05-01T01:00:00.000Z",
    });
    const expired = await repository.expireDue(new Date("2026-05-01T02:00:00.000Z"));
    assert.ok(expired.some((a) => a.id === assignment.id && a.status === "expired"));
  });

  await t.test("expireDue advances a recurring assignment and isolates an overlap conflict to just that item", async () => {
    const conflictingDevice = `device-conflict-${unique}`;
    // This exclusive assignment will collide with the *advanced* window of
    // the recurring one below, but not with its current (already-past) one —
    // proving the conflict check uses the frozen pre-tick snapshot, not a
    // window that includes this tick's other in-progress changes.
    await repository.create({
      instructions: "Blocks the advanced window", assignee: `blocker-${unique}`, createdBy: `manager-${unique}`, deviceId: conflictingDevice,
      startAt: "2026-06-02T09:00:00.000Z", endAt: "2026-06-02T10:00:00.000Z",
    });
    const recurring = await repository.create({
      instructions: "Daily, will conflict on advance", assignee: `va-recurring-${unique}`, createdBy: `manager-${unique}`, deviceId: conflictingDevice,
      startAt: "2026-06-01T09:00:00.000Z", endAt: "2026-06-01T10:00:00.000Z", recurrence: "daily", timezone: "UTC",
    });

    const expired = await repository.expireDue(new Date("2026-06-01T11:00:00.000Z"));
    const advanced = expired.find((a) => a.id === recurring.id);
    assert.ok(advanced.history.some((h) => h.action === "recurrence_conflict"), "the conflicting advance must be recorded, not silently dropped");
    assert.equal(advanced.status, "assigned", "status/schedule are left untouched (not advanced) pending manual resolution of the conflict");
    assert.equal(advanced.startAt, "2026-06-01T09:00:00.000Z", "the window itself must not have been advanced when the advance would conflict");
  });

  await t.test("every assignment belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    const assignment = await repository.create({ instructions: "Org check", assignee: `va-${unique}`, createdBy: `manager-${unique}` });
    const row = await pool.query("SELECT organization_id FROM automation.assignments WHERE id = $1", [assignment.id]);
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });

  await t.test("RLS: a different organization cannot see the default organization's assignments through a real non-superuser role", async () => {
    const assignment = await repository.create({ instructions: "Tenant isolation check", assignee: `va-${unique}`, createdBy: `manager-${unique}` });

    const testRole = `pf_test_assignments_${crypto.randomBytes(4).toString("hex")}`;
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
      [`other-org-assignments-${unique}`, "Other Org"],
    );

    const url = new URL(TEST_DATABASE_URL);
    url.username = testRole;
    url.password = testPassword;
    const roleClient = new pg.Client({ connectionString: url.toString() });
    await roleClient.connect();
    try {
      await roleClient.query("BEGIN");
      await roleClient.query("SELECT set_config('app.current_organization_id', $1, true)", [otherOrg.rows[0].id]);
      const rows = await roleClient.query("SELECT * FROM automation.assignments WHERE id = $1", [assignment.id]);
      assert.equal(rows.rowCount, 0, "the default organization's assignment must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
