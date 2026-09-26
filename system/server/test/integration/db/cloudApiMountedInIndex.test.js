// Real end-to-end proof for Phase 1 task P2
// (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md): booting the ACTUAL
// system/server/src/index.js with CLOUD_API_ENABLED=true and confirming the
// cloud identity API is really mounted at /api/cloud and reachable over real
// HTTP — not just that createCloudApi() works in isolation (cloudApi.test.js
// already proves that), and not a log line claiming it worked. Runs a real
// invite → accept → login → TOTP-enroll → TOTP-confirm sequence against the
// live, running server. Skips without TEST_DATABASE_URL.
//
// index.js is imported once via dynamic import at module scope (matching
// every other test in this directory that boots the real server), so every
// environment variable it reads at startup must be set BEFORE that import —
// including CLOUD_API_ENABLED and DATABASE_URL themselves.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  test("cloud API is really mounted in index.js when CLOUD_API_ENABLED=true (real database, real HTTP)", {
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-cloud-api-mount-"));
  process.env.OPERATORS_CONFIG_PATH = path.join(root, "operators.json");
  process.env.FILE_STORE_DIR = path.join(root, "files");
  process.env.SESSION_STORE_DIR = path.join(root, "sessions");
  process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
  process.env.QUEUE_STORE_PATH = path.join(root, "queue.json");
  process.env.MODEL_SELECTION_STORE_PATH = path.join(root, "models.json");
  process.env.ASSIGNMENT_STORE_PATH = path.join(root, "assignments.json");
  process.env.RESEARCH_STORE_DIR = path.join(root, "research");
  process.env.RESEARCH_EVIDENCE_DIR = path.join(root, "evidence");
  process.env.SESSION_SECRET = "cloud-api-mount-test-secret";
  process.env.TWO_FACTOR_MASTER_KEY = "cloud-api-mount-test-two-factor-key-123456";
  process.env.ACCOUNT_NOTIFICATION_STORE_PATH = path.join(root, "account-notifications.json");
  process.env.AUTO_DISCOVER_IOS_DEVICES = "false";
  process.env.CLOUD_API_ENABLED = "true";
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  const { server } = await import("../../../src/index.js");
  const { createPool } = await import("../../../src/db/pool.js");
  const { withTransaction } = await import("../../../src/db/transaction.js");
  const { ensureDefaultOrganization, DEFAULT_ORGANIZATION_SLUG } = await import("../../../src/db/defaultOrganization.js");
  const { createRoleRepository } = await import("../../../src/db/repositories/roleRepository.js");

  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  test("cloud API is really mounted in index.js when CLOUD_API_ENABLED=true (real database, real HTTP)", async (t) => {
    const pool = createPool();
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
      fs.rmSync(root, { recursive: true, force: true });
    });

    const organization = await ensureDefaultOrganization(pool);
    const unique = crypto.randomBytes(3).toString("hex");
    const ownerEmail = `owner-${unique}@example.com`;
    const roleRepository = createRoleRepository(pool);

    await t.test("the mounted API is reachable, and the file-backed operator login is completely unaffected", async () => {
      const anonymous = await fetch(`${baseUrl}/api/cloud/me`);
      assert.equal(anonymous.status, 401, "the mounted cloud API must respond, not 404 (proves real mounting, not just that some route exists)");

      const publicSignupBlocked = await fetch(`${baseUrl}/api/cloud/signup`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "should-not-exist", displayName: "x", ownerEmail: "x@example.com", ownerPassword: "irrelevant" }),
      });
      assert.equal(publicSignupBlocked.status, 404, "Phase 1 must not expose public organization signup, even when the API is mounted for real");

      // The pre-existing file-backed operator login route must be completely untouched.
      const legacyLoginRoute = await fetch(`${baseUrl}/api/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "definitely-not-a-real-operator", password: "wrong" }),
      });
      assert.notEqual(legacyLoginRoute.status, 404, "mounting the cloud API must not shadow or remove the existing /api/login route");
    });

    await t.test("real end-to-end: invite a VA by email, accept the invite, log in, and complete real TOTP two-factor setup", async () => {
      // Directly create an admin membership in the one default organization to send the invite from —
      // this mirrors what an already-onboarded admin would do; it is not the flow under test.
      const adminOrgIdentity = await import("../../../src/services/organizationIdentityService.js");
      const { createUserRepository } = await import("../../../src/db/repositories/userRepository.js");
      const { createMembershipRepository } = await import("../../../src/db/repositories/membershipRepository.js");
      const { createOrganizationRepository } = await import("../../../src/db/repositories/organizationRepository.js");
      const { hashPassword } = await import("../../../src/authStore.js");
      const { createIdentitySessionService } = await import("../../../src/services/identitySessionService.js");
      const { createIdentitySessionRepository } = await import("../../../src/db/repositories/identitySessionRepository.js");

      const userRepository = createUserRepository(pool);
      const membershipRepository = createMembershipRepository(pool);
      const organizationRepository = createOrganizationRepository(pool);
      const organizationIdentityService = adminOrgIdentity.createOrganizationIdentityService({
        pool, withTransaction, organizationRepository, userRepository, membershipRepository, roleRepository, hashPassword,
      });
      const sessionRepository = createIdentitySessionRepository(pool);
      const identitySessionService = createIdentitySessionService({ repository: sessionRepository });

      const adminUser = await userRepository.createWithPrimaryEmail({ email: ownerEmail, passwordHash: hashPassword("admin passphrase 123"), displayName: "Admin" });
      await organizationIdentityService.addMember({ organizationId: organization.id, userId: adminUser.id, roleKey: "owner" });
      const { token: adminToken } = await identitySessionService.issueSession({ userId: adminUser.id });

      // 1. Invite a VA by email — real HTTP call to the real mounted route.
      const vaEmail = `va-${unique}@example.com`;
      const inviteResponse = await fetch(`${baseUrl}/api/cloud/organizations/${organization.id}/invitations`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ email: vaEmail, roleKey: "va_operator" }),
      });
      assert.equal(inviteResponse.status, 201);
      const { invitationId } = await inviteResponse.json();
      assert.ok(invitationId);

      // Read the raw invitation token straight from the database (this test proves the HTTP surface,
      // not email delivery — P2b's own test proves mailSender is actually called).
      const rawTokenRow = await withTransaction(pool, (client) => client.query(
        "SELECT token_hash FROM identity.invitations WHERE id = $1", [invitationId],
      ), { organizationId: organization.id });
      assert.equal(rawTokenRow.rowCount, 1, "the invitation must actually exist in Postgres, not just in the HTTP response");

      // Since only the hash is stored, invite again through the service layer to get the raw token this
      // HTTP-level test can actually use — a second, real invitation for the same VA.
      const { createInvitationService } = await import("../../../src/services/invitationService.js");
      const { createInvitationRepository } = await import("../../../src/db/repositories/invitationRepository.js");
      const invitationService = createInvitationService({
        pool, withTransaction, invitationRepository: createInvitationRepository(pool), membershipRepository, roleRepository,
      });
      const { token: rawInviteToken } = await invitationService.invite({
        organizationId: organization.id, email: vaEmail, roleKey: "va_operator", invitedByUserId: adminUser.id,
      });

      // 2. Accept the invite for real over HTTP, creating a brand-new account.
      const acceptResponse = await fetch(`${baseUrl}/api/cloud/signup-from-invitation`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: rawInviteToken, password: "va real passphrase 123", displayName: "Real VA" }),
      });
      assert.equal(acceptResponse.status, 201);
      const acceptBody = await acceptResponse.json();
      assert.ok(acceptBody.token, "accepting the invite must log the VA in immediately with a usable session");

      // 3. Log in for real with the password just set (a fresh login, not reusing the signup session).
      const loginResponse = await fetch(`${baseUrl}/api/cloud/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: vaEmail, password: "va real passphrase 123" }),
      });
      assert.equal(loginResponse.status, 200);
      const { token: vaToken } = await loginResponse.json();
      assert.ok(vaToken);

      // 4. Complete real TOTP two-factor enrollment — actually compute a valid code from the returned
      // secret and confirm with it, proving the whole loop (not just that an enrollment record exists).
      const enrollResponse = await fetch(`${baseUrl}/api/cloud/me/mfa/enroll`, {
        method: "POST", headers: { authorization: `Bearer ${vaToken}` },
      });
      assert.equal(enrollResponse.status, 201);
      const enrollment = await enrollResponse.json();
      assert.ok(enrollment.methodId);
      assert.ok(enrollment.secret, "the raw TOTP secret must be returned once, at enrollment time, to seed an authenticator app");

      const { totpCode } = await import("../../../src/twoFactor.js");
      const code = totpCode(enrollment.secret);
      const confirmResponse = await fetch(`${baseUrl}/api/cloud/me/mfa/confirm`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${vaToken}` },
        body: JSON.stringify({ methodId: enrollment.methodId, code }),
      });
      assert.equal(confirmResponse.status, 200, "confirming with a real, freshly-computed TOTP code must succeed");

      // 5. Log out for real, and confirm the session is actually revoked afterward.
      const logoutResponse = await fetch(`${baseUrl}/api/cloud/logout`, {
        method: "POST", headers: { authorization: `Bearer ${vaToken}` },
      });
      assert.equal(logoutResponse.status, 204);
      const afterLogout = await fetch(`${baseUrl}/api/cloud/me`, { headers: { authorization: `Bearer ${vaToken}` } });
      assert.equal(afterLogout.status, 401, "the token must be genuinely unusable after logout, not just client-side forgotten");
    });
  });
}
