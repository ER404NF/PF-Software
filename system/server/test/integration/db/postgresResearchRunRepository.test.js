// Real-PostgreSQL functional and tenant-isolation test for the M05
// PostgreSQL-backed research run repository. Skips without
// TEST_DATABASE_URL. Proves parity with the file-backed researchStore.js
// contract (candidate creation/merge, cross-run dedup carrying review
// state forward, locateCandidate, idempotent platform-action recording,
// finalizeRun, setCandidateStatus) and real tenant isolation on the new
// automation.research_accounts table through a non-superuser role.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { createPostgresResearchRunRepository } from "../../../src/db/repositories/postgresResearchRunRepository.js";
import { assertResearchRunRepository } from "../../../src/persistence/researchRunRepository.js";
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

test("PostgreSQL research run repository (real database)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const repository = await createPostgresResearchRunRepository(pool);
  assertResearchRunRepository(repository);

  const workspaceId = "workspace-a";
  const unique = crypto.randomBytes(3).toString("hex");
  const account = `test-account-${unique}`;

  await t.test("listRuns()/getRun() return null for an invalid workspace or account instead of an empty list", async () => {
    assert.equal(await repository.listRuns("../etc", account), null);
    assert.equal(await repository.listRuns(workspaceId, "not valid"), null);
  });

  await t.test("createRun() stores candidates with a pending status and round-trips through getRun()/listRuns()", async () => {
    const run = await repository.createRun(workspaceId, account, {
      platform: "instagram", timeWindow: "09:00-10:00", overview: "Test run",
      candidates: [{ url: "https://example.com/p/1", sourceHandle: "@x", niche: "ai" }],
    });
    assert.ok(run.id.startsWith("run-"));
    assert.equal(run.candidates.length, 1);
    assert.equal(run.candidates[0].status, "pending");
    assert.equal(run.candidates[0].url, "https://example.com/p/1");

    assert.deepEqual(await repository.getRun(workspaceId, account, run.id), run);
    assert.deepEqual((await repository.listRuns(workspaceId, account)).map((r) => r.id), [run.id]);
  });

  await t.test("appendCandidate() adds and merges durable discoveries into an existing run", async () => {
    const run = await repository.createRun(workspaceId, account, { platform: "instagram", overview: "live", candidates: [] });
    const first = await repository.appendCandidate(workspaceId, account, run.id, {
      platform_content_id: "post-1", canonical_url: "https://example.com/post-1", evidence_refs: ["capture-1"], tags: ["hook"],
    });
    assert.equal(first.evidence_refs.length, 1);

    const merged = await repository.appendCandidate(workspaceId, account, run.id, {
      platform_content_id: "post-1", canonical_url: "https://example.com/post-1", evidence_refs: ["capture-2"], tags: ["cta"],
    });
    assert.equal(merged.id, first.id, "the same content id must merge into the same candidate, not create a second one");
    assert.deepEqual(new Set(merged.evidence_refs), new Set(["capture-1", "capture-2"]));
    assert.deepEqual(new Set(merged.tags), new Set(["hook", "cta"]));

    const reloaded = await repository.getRun(workspaceId, account, run.id);
    assert.equal(reloaded.candidates.length, 1, "the merge must not have produced a second candidate row");
  });

  await t.test("a later run re-observing the same post carries its prior review decision forward instead of resetting to pending", async () => {
    const firstRun = await repository.createRun(workspaceId, account, {
      platform: "instagram", overview: "run 1",
      candidates: [{ platform_content_id: "post-cross-run", canonical_url: "https://example.com/post-cross-run" }],
    });
    const candidateId = firstRun.candidates[0].id;
    await repository.setCandidateStatus(workspaceId, account, firstRun.id, candidateId, "confirmed");

    const secondRun = await repository.createRun(workspaceId, account, {
      platform: "instagram", overview: "run 2",
      candidates: [{ platform_content_id: "post-cross-run", canonical_url: "https://example.com/post-cross-run" }],
    });
    assert.equal(secondRun.candidates[0].status, "confirmed", "the earlier human review must carry forward, not reset to pending");
    assert.equal(secondRun.candidates[0].duplicate_of_run, firstRun.id);
  });

  await t.test("locateCandidate() finds recorded content by URL or platform id, and never invents one", async () => {
    const run = await repository.createRun(workspaceId, account, {
      platform: "instagram", overview: "locate",
      candidates: [{ platform_content_id: "post-locate", canonical_url: "https://example.com/post-locate" }],
    });
    const byUrl = await repository.locateCandidate(workspaceId, account, "https://example.com/post-locate");
    assert.equal(byUrl.runId, run.id);
    const byId = await repository.locateCandidate(workspaceId, account, "post-locate");
    assert.equal(byId.candidate.id, byUrl.candidate.id);
    assert.equal(await repository.locateCandidate(workspaceId, account, "https://example.com/never-seen"), null);
  });

  await t.test("recordPlatformAction() mirrors an action into its candidate, and a repeat adds nothing", async () => {
    const run = await repository.createRun(workspaceId, account, {
      platform: "instagram", overview: "actions",
      candidates: [{ platform_content_id: "post-action", canonical_url: "https://example.com/post-action" }],
    });
    const candidateId = run.candidates[0].id;
    const first = await repository.recordPlatformAction(workspaceId, account, run.id, candidateId, { action: "like", status: "VERIFIED" });
    assert.equal(first.added, true);
    const repeat = await repository.recordPlatformAction(workspaceId, account, run.id, candidateId, { action: "like", status: "VERIFIED" });
    assert.equal(repeat.added, false, "re-recording the identical action must be a no-op, not a duplicate entry");
    assert.equal(repeat.candidate.platform_actions.length, 1);
  });

  await t.test("finalizeRun() requires a non-empty overview and records outcome/completedAt", async () => {
    const run = await repository.createRun(workspaceId, account, { platform: "instagram", overview: "before", candidates: [] });
    assert.equal(await repository.finalizeRun(workspaceId, account, run.id, { overview: "" }), null);
    const finalized = await repository.finalizeRun(workspaceId, account, run.id, { overview: "  Final summary  ", outcome: "SUCCEEDED" });
    assert.equal(finalized.overview, "Final summary");
    assert.equal(finalized.outcome, "SUCCEEDED");
    assert.equal(typeof finalized.completedAt, "string");
  });

  await t.test("setCandidateStatus() only accepts confirmed/removed and rejects anything else", async () => {
    const run = await repository.createRun(workspaceId, account, {
      platform: "instagram", overview: "status", candidates: [{ platform_content_id: "post-status" }],
    });
    assert.equal(await repository.setCandidateStatus(workspaceId, account, run.id, run.candidates[0].id, "bogus"), null);
    const updated = await repository.setCandidateStatus(workspaceId, account, run.id, run.candidates[0].id, "removed");
    assert.equal(updated.status, "removed");
    assert.equal(updated.review_state, "removed");
  });

  await t.test("every research account belongs to the single default organization", async () => {
    const orgResult = await pool.query("SELECT id FROM identity.organizations WHERE slug = $1", [DEFAULT_ORGANIZATION_SLUG]);
    await repository.createRun(workspaceId, account, { platform: "instagram", overview: "org-check", candidates: [] });
    const row = await pool.query(
      "SELECT organization_id FROM automation.research_accounts WHERE workspace_id = $1 AND account = $2",
      [workspaceId, account],
    );
    assert.equal(row.rows[0].organization_id, orgResult.rows[0].id);
  });

  await t.test("RLS: a different organization cannot see the default organization's research account through a real non-superuser role", async () => {
    await repository.createRun(workspaceId, account, { platform: "instagram", overview: "rls-check", candidates: [] });

    const testRole = `pf_test_research_${unique}`;
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
      [`other-org-research-${unique}`, "Other Org"],
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
        "SELECT * FROM automation.research_accounts WHERE workspace_id = $1 AND account = $2",
        [workspaceId, account],
      );
      assert.equal(rows.rowCount, 0, "the default organization's research account must be invisible from a different organization's context");
      await roleClient.query("COMMIT");
    } finally {
      await roleClient.end();
    }
  });
});
