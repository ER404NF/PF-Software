// Real-PostgreSQL, real-HTTP authorization test matrix for the M04 part 6
// cloud API — the master prompt's own required matrix for every sensitive
// endpoint: anonymous / wrong organization / wrong role / correct role /
// disabled user / expired session / revoked session, run here against
// POST /organizations/:organizationId/invitations (requires member:invite).
// Skips without TEST_DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { withTransaction } from "../../../src/db/transaction.js";
import { createOrganizationRepository } from "../../../src/db/repositories/organizationRepository.js";
import { createUserRepository } from "../../../src/db/repositories/userRepository.js";
import { createMembershipRepository } from "../../../src/db/repositories/membershipRepository.js";
import { createRoleRepository } from "../../../src/db/repositories/roleRepository.js";
import { createIdentitySessionRepository } from "../../../src/db/repositories/identitySessionRepository.js";
import { createInvitationRepository } from "../../../src/db/repositories/invitationRepository.js";
import { createIdentityMfaRepository } from "../../../src/db/repositories/identityMfaRepository.js";
import { createEmailActionTokenRepository } from "../../../src/db/repositories/emailActionTokenRepository.js";
import { createOrganizationIdentityService } from "../../../src/services/organizationIdentityService.js";
import { createIdentitySessionService } from "../../../src/services/identitySessionService.js";
import { createInvitationService } from "../../../src/services/invitationService.js";
import { createIdentityMfaService } from "../../../src/services/identityMfaService.js";
import { createEmailActionService } from "../../../src/services/emailActionService.js";
import { createCloudApi } from "../../../src/cloudApi/createCloudApi.js";
import { hashPassword, verifyPassword, validatePassword } from "../../../src/authStore.js";
import {
  generateTotpSecret, verifyTotp, encryptTotpSecret, decryptTotpSecret,
  generateRecoveryCodes, recoveryCodeDigest, verifyRecoveryCode, otpauthUri,
} from "../../../src/twoFactor.js";

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

test("cloud API authorization matrix (real PostgreSQL, real HTTP)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  const organizationRepository = createOrganizationRepository(pool);
  const userRepository = createUserRepository(pool);
  const membershipRepository = createMembershipRepository(pool);
  const roleRepository = createRoleRepository(pool);
  const sessionRepository = createIdentitySessionRepository(pool);
  const invitationRepository = createInvitationRepository(pool);
  const mfaRepository = createIdentityMfaRepository(pool);
  const emailActionTokenRepository = createEmailActionTokenRepository(pool);

  const organizationIdentityService = createOrganizationIdentityService({
    pool, withTransaction, organizationRepository, userRepository, membershipRepository, roleRepository, hashPassword,
  });
  const identitySessionService = createIdentitySessionService({ repository: sessionRepository });
  const invitationService = createInvitationService({ pool, withTransaction, invitationRepository, membershipRepository, roleRepository });
  const identityMfaService = createIdentityMfaService({
    repository: mfaRepository, masterKey: "test-master-key-at-least-32-characters-long", generateTotpSecret, verifyTotp,
    encryptTotpSecret, decryptTotpSecret, generateRecoveryCodes, recoveryCodeDigest, verifyRecoveryCode, otpauthUri,
  });
  const emailActionService = createEmailActionService({
    pool, withTransaction, emailActionTokenRepository, userRepository, sessionRepository, hashPassword,
  });

  const sentMail = [];
  const fakeMailSender = {
    isConfigured: () => true,
    send: async ({ to, from, subject, body }) => { sentMail.push({ to, from, subject, body }); },
  };

  const app = createCloudApi({
    pool, withTransaction, organizationRepository, userRepository, membershipRepository, roleRepository,
    organizationIdentityService, identitySessionService, invitationService, identityMfaService, emailActionService,
    verifyPassword, hashPassword, validatePassword,
    mailSender: fakeMailSender, companyEmail: "no-reply@example.com",
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });

  const unique = crypto.randomBytes(4).toString("hex");

  const { organization: orgA } = await organizationIdentityService.createOrganizationWithOwner({
    slug: `cloud-api-a-${unique}`, displayName: "Cloud API Org A",
    ownerEmail: `owner-a-${unique}@example.com`, ownerPassword: "owner A passphrase here",
  });
  const { organization: orgB, user: ownerB } = await organizationIdentityService.createOrganizationWithOwner({
    slug: `cloud-api-b-${unique}`, displayName: "Cloud API Org B",
    ownerEmail: `owner-b-${unique}@example.com`, ownerPassword: "owner B passphrase here",
  });

  const managerUser = await userRepository.createWithPrimaryEmail({
    email: `manager-${unique}@example.com`, passwordHash: hashPassword("manager passphrase"),
  });
  await organizationIdentityService.addMember({ organizationId: orgA.id, userId: managerUser.id, roleKey: "manager" });

  const vaUser = await userRepository.createWithPrimaryEmail({
    email: `va-${unique}@example.com`, passwordHash: hashPassword("va passphrase"),
  });
  await organizationIdentityService.addMember({ organizationId: orgA.id, userId: vaUser.id, roleKey: "va_operator" });

  const disabledUser = await userRepository.createWithPrimaryEmail({
    email: `disabled-${unique}@example.com`, passwordHash: hashPassword("disabled passphrase"),
  });
  await organizationIdentityService.addMember({ organizationId: orgA.id, userId: disabledUser.id, roleKey: "manager" });
  await pool.query("UPDATE identity.users SET status = 'suspended' WHERE id = $1", [disabledUser.id]);

  async function postInvitation(token) {
    return fetch(`${baseUrl}/organizations/${orgA.id}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ email: `invitee-${crypto.randomBytes(3).toString("hex")}@example.com`, roleKey: "va_operator" }),
    });
  }

  await t.test("anonymous (no token) is rejected", async () => {
    const response = await postInvitation(null);
    assert.equal(response.status, 401);
  });

  await t.test("a member of the WRONG organization is rejected", async () => {
    const { token } = await identitySessionService.issueSession({ userId: ownerB.id });
    const response = await postInvitation(token);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /not an active member/);
  });

  await t.test("a member with the WRONG role is rejected", async () => {
    const { token } = await identitySessionService.issueSession({ userId: vaUser.id });
    const response = await postInvitation(token);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /missing required permission/);
  });

  await t.test("a member with the CORRECT role succeeds", async () => {
    const { token } = await identitySessionService.issueSession({ userId: managerUser.id });
    const response = await postInvitation(token);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.ok(body.invitationId);
  });

  await t.test("a disabled (suspended) user is rejected even with the right role and a valid session", async () => {
    const { token } = await identitySessionService.issueSession({ userId: disabledUser.id });
    const response = await postInvitation(token);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.match(body.error, /not active/);
  });

  await t.test("an expired session is rejected", async () => {
    const { token } = await identitySessionService.issueSession({ userId: managerUser.id, ttlMs: -1000 });
    const response = await postInvitation(token);
    assert.equal(response.status, 401);
  });

  await t.test("a revoked session is rejected", async () => {
    const { token, session } = await identitySessionService.issueSession({ userId: managerUser.id });
    await identitySessionService.revokeSession(session.id);
    const response = await postInvitation(token);
    assert.equal(response.status, 401);
  });

  await t.test("the owner role also has member:invite (full-access role, not just manager)", async () => {
    const owner = await userRepository.getByEmail(`owner-a-${unique}@example.com`);
    const { token } = await identitySessionService.issueSession({ userId: owner.id });
    const response = await postInvitation(token);
    assert.equal(response.status, 201);
  });

  await t.test("GET /me returns memberships across every organization the caller belongs to, self-read RLS included", async () => {
    const multiOrgUser = await userRepository.createWithPrimaryEmail({
      email: `multi-${unique}@example.com`, passwordHash: hashPassword("multi org passphrase"),
    });
    await organizationIdentityService.addMember({ organizationId: orgA.id, userId: multiOrgUser.id, roleKey: "researcher" });
    await organizationIdentityService.addMember({ organizationId: orgB.id, userId: multiOrgUser.id, roleKey: "reviewer" });
    const { token } = await identitySessionService.issueSession({ userId: multiOrgUser.id });

    const response = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.memberships.length, 2);
    assert.deepEqual(
      body.memberships.map((m) => m.organization_id).sort(),
      [orgA.id, orgB.id].sort(),
    );
  });

  await t.test("GET /organizations/:id/members returns the roster for any active member, regardless of role", async () => {
    const { token } = await identitySessionService.issueSession({ userId: vaUser.id });
    const response = await fetch(`${baseUrl}/organizations/${orgA.id}/members`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.members.some((m) => m.user_id === vaUser.id));
  });

  await t.test("GET /organizations/:id/members: a member of the WRONG organization is rejected (this route has no specific permission, only requireMembership())", async () => {
    const { token } = await identitySessionService.issueSession({ userId: ownerB.id });
    const response = await fetch(`${baseUrl}/organizations/${orgA.id}/members`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /not an active member/);
  });

  await t.test("PATCH member status: wrong role (va_operator lacks member:manage) is rejected", async () => {
    const { token } = await identitySessionService.issueSession({ userId: vaUser.id });
    const target = await withTransaction(pool, (client) => membershipRepository.get(orgA.id, managerUser.id, client), { organizationId: orgA.id });
    const response = await fetch(`${baseUrl}/organizations/${orgA.id}/members/${target.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(response.status, 403);
  });

  await t.test("PATCH member status: a manager can suspend another member, and it takes effect immediately without revoking their session", async () => {
    const targetUser = await userRepository.createWithPrimaryEmail({
      email: `suspend-target-${unique}@example.com`, passwordHash: hashPassword("suspend target passphrase"),
    });
    const targetMembership = await organizationIdentityService.addMember({ organizationId: orgA.id, userId: targetUser.id, roleKey: "researcher" });
    const { token: targetToken } = await identitySessionService.issueSession({ userId: targetUser.id });

    // Prove the membership works before suspension.
    const before = await fetch(`${baseUrl}/organizations/${orgA.id}/members`, { headers: { authorization: `Bearer ${targetToken}` } });
    assert.equal(before.status, 200);

    const { token: managerToken3 } = await identitySessionService.issueSession({ userId: managerUser.id });
    const patchResponse = await fetch(`${baseUrl}/organizations/${orgA.id}/members/${targetMembership.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${managerToken3}` },
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(patchResponse.status, 200);

    // Same still-valid, unrevoked session — but the membership itself is
    // now suspended, so requireMembership() must reject it.
    const after = await fetch(`${baseUrl}/organizations/${orgA.id}/members`, { headers: { authorization: `Bearer ${targetToken}` } });
    assert.equal(after.status, 403);
  });

  await t.test("PATCH member status: rejects an invalid status value", async () => {
    const { token } = await identitySessionService.issueSession({ userId: managerUser.id });
    const response = await fetch(`${baseUrl}/organizations/${orgA.id}/members/00000000-0000-0000-0000-000000000000`, {
      method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "not-a-real-status" }),
    });
    assert.equal(response.status, 400);
  });

  await t.test("PATCH member status: rejects changing your own membership through this route", async () => {
    const { token } = await identitySessionService.issueSession({ userId: managerUser.id });
    const own = await withTransaction(pool, (client) => membershipRepository.get(orgA.id, managerUser.id, client), { organizationId: orgA.id });
    const response = await fetch(`${baseUrl}/organizations/${orgA.id}/members/${own.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(response.status, 400);
  });

  await t.test("PATCH member status: 404s a membership id that belongs to a different organization", async () => {
    const ownerBMembership = await withTransaction(pool, (client) => membershipRepository.get(orgB.id, ownerB.id, client), { organizationId: orgB.id });
    const { token } = await identitySessionService.issueSession({ userId: managerUser.id });
    const response = await fetch(`${baseUrl}/organizations/${orgA.id}/members/${ownerBMembership.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(response.status, 404);
  });

  await t.test("an unknown organization id 404s rather than 403ing (does not confirm or deny real org ids)", async () => {
    const { token } = await identitySessionService.issueSession({ userId: managerUser.id });
    const response = await fetch(`${baseUrl}/organizations/00000000-0000-0000-0000-000000000000/invitations`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: `nobody-${unique}@example.com`, roleKey: "va_operator" }),
    });
    assert.equal(response.status, 404);
  });

  await t.test("authenticate() behaves identically on a route with no membership/permission layer (/me/mfa/enroll)", async () => {
    const anonymous = await fetch(`${baseUrl}/me/mfa/enroll`, { method: "POST" });
    assert.equal(anonymous.status, 401);

    const { token: expiredToken } = await identitySessionService.issueSession({ userId: managerUser.id, ttlMs: -1000 });
    const expired = await fetch(`${baseUrl}/me/mfa/enroll`, { method: "POST", headers: { authorization: `Bearer ${expiredToken}` } });
    assert.equal(expired.status, 401);

    const { token: revokedToken, session } = await identitySessionService.issueSession({ userId: managerUser.id });
    await identitySessionService.revokeSession(session.id);
    const revoked = await fetch(`${baseUrl}/me/mfa/enroll`, { method: "POST", headers: { authorization: `Bearer ${revokedToken}` } });
    assert.equal(revoked.status, 401);

    const { token: validToken } = await identitySessionService.issueSession({ userId: managerUser.id });
    const valid = await fetch(`${baseUrl}/me/mfa/enroll`, { method: "POST", headers: { authorization: `Bearer ${validToken}` } });
    assert.equal(valid.status, 201);
  });

  async function flushFireAndForgetMail() {
    // sendMail() inside createCloudApi.js is deliberately fire-and-forget
    // (email delivery must never add latency to the HTTP response) — give
    // its promise a turn to settle before asserting on sentMail.
    await new Promise((resolve) => setImmediate(resolve));
  }

  await t.test("a configured mailSender actually gets called for signup, invitations, and password reset", async () => {
    sentMail.length = 0;

    const signupResponse = await fetch(`${baseUrl}/signup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: `mail-test-${unique}`, displayName: "Mail Test Org", ownerEmail: `mail-owner-${unique}@example.com`, ownerPassword: "mail owner passphrase" }),
    });
    assert.equal(signupResponse.status, 201);
    await flushFireAndForgetMail();
    assert.ok(sentMail.some((m) => m.to === `mail-owner-${unique}@example.com` && /verify/i.test(m.subject)));

    const { token: managerToken2 } = await identitySessionService.issueSession({ userId: managerUser.id });
    const inviteResponse = await fetch(`${baseUrl}/organizations/${orgA.id}/invitations`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${managerToken2}` },
      body: JSON.stringify({ email: `mail-invitee-${unique}@example.com`, roleKey: "va_operator" }),
    });
    assert.equal(inviteResponse.status, 201);
    await flushFireAndForgetMail();
    const inviteMail = sentMail.find((m) => m.to === `mail-invitee-${unique}@example.com`);
    assert.ok(inviteMail, "expected an invitation email to have been sent");
    assert.match(inviteMail.body, /[a-zA-Z0-9_-]{20,}/, "the email body must contain the invitation code");

    const resetResponse = await fetch(`${baseUrl}/password-reset/request`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `mail-owner-${unique}@example.com` }),
    });
    assert.equal(resetResponse.status, 202);
    await flushFireAndForgetMail();
    assert.ok(sentMail.some((m) => m.to === `mail-owner-${unique}@example.com` && /reset/i.test(m.subject)));
  });

  await t.test("password-reset/request sends no email for an unknown address, without revealing that in the response", async () => {
    sentMail.length = 0;
    const response = await fetch(`${baseUrl}/password-reset/request`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `definitely-not-registered-${unique}@example.com` }),
    });
    assert.equal(response.status, 202);
    await flushFireAndForgetMail();
    assert.equal(sentMail.length, 0);
  });

  await t.test("POST /signup rejects a password shorter than the policy minimum, before creating anything", async () => {
    const response = await fetch(`${baseUrl}/signup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: `too-short-${unique}`, displayName: "Too Short", ownerEmail: `short-${unique}@example.com`, ownerPassword: "short" }),
    });
    assert.equal(response.status, 400);
    assert.equal(await organizationRepository.getBySlug(`too-short-${unique}`), null);
  });

  await t.test("POST /signup-from-invitation creates a real account for someone with no prior user row and logs them in", async () => {
    const managerToken = (await identitySessionService.issueSession({ userId: managerUser.id })).token;
    const inviteResponse = await fetch(`${baseUrl}/organizations/${orgA.id}/invitations`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${managerToken}` },
      body: JSON.stringify({ email: `brand-new-${unique}@example.com`, roleKey: "researcher" }),
    });
    assert.equal(inviteResponse.status, 201);

    const { token: rawToken } = await invitationService.invite({
      organizationId: orgA.id, email: `brand-new-2-${unique}@example.com`, roleKey: "researcher", invitedByUserId: managerUser.id,
    });

    const signupResponse = await fetch(`${baseUrl}/signup-from-invitation`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: rawToken, password: "brand new account passphrase", displayName: "Brand New Person" }),
    });
    assert.equal(signupResponse.status, 201);
    const body = await signupResponse.json();
    assert.ok(body.token, "must return a usable session token, logging the new user in immediately");
    assert.equal(body.user.displayName, "Brand New Person");

    const createdUser = await userRepository.getByEmail(`brand-new-2-${unique}@example.com`);
    assert.notEqual(createdUser, null);
    // Not asserting membershipRepository.get()'s RLS-fails-closed behavior
    // here: this file's `pool` connects as the Postgres superuser (same as
    // every CI service container), and superusers bypass row-level security
    // unconditionally in PostgreSQL — FORCE ROW LEVEL SECURITY only extends
    // enforcement to the table OWNER, never to a superuser — so a call
    // through this pool can never observe RLS denying access regardless of
    // GUC/transaction context. That fail-closed property is already proven
    // for real, through a genuine non-superuser role, in every M05 domain's
    // own "RLS: a different organization cannot see..." test and in
    // tenantIsolation.test.js; asserting it again here via a superuser
    // connection was asserting something that can never be false, not a
    // real check — caught only once this test actually ran against a real
    // database instead of always skipping.
    const membership = await withTransaction(pool, (client) => membershipRepository.get(orgA.id, createdUser.id, client), { organizationId: orgA.id });
    assert.notEqual(membership, null, "the membership must exist when read with the correct tenant context");
    const verified = await identitySessionService.verifySession(body.token);
    assert.equal(verified.user_id, createdUser.id);
  });

  await t.test("POST /signup-from-invitation rejects a reused invitation token", async () => {
    const { token: rawToken } = await invitationService.invite({
      organizationId: orgA.id, email: `reused-${unique}@example.com`, roleKey: "researcher",
    });
    const first = await fetch(`${baseUrl}/signup-from-invitation`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: rawToken, password: "first attempt passphrase" }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${baseUrl}/signup-from-invitation`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: rawToken, password: "second attempt passphrase" }),
    });
    assert.equal(second.status, 400);
    const secondBody = await second.json();
    assert.match(secondBody.error, /already accepted/);
  });

  // Phase 1 (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md): the
  // internal rollout has exactly one organization and no public
  // "create an account" route. index.js mounts the cloud API with
  // allowOrganizationSignup: false; signup-from-invitation stays open since
  // that's the invite-only flow Phase 1 explicitly wants.
  await t.test("allowOrganizationSignup: false 404s POST /signup without touching any other route", async () => {
    const restrictedApp = createCloudApi({
      pool, withTransaction, organizationRepository, userRepository, membershipRepository, roleRepository,
      organizationIdentityService, identitySessionService, invitationService, identityMfaService, emailActionService,
      verifyPassword, hashPassword, validatePassword,
      mailSender: fakeMailSender, companyEmail: "no-reply@example.com",
      allowOrganizationSignup: false,
    });
    const restrictedServer = restrictedApp.listen(0);
    const restrictedBaseUrl = `http://127.0.0.1:${restrictedServer.address().port}`;
    try {
      const signupResponse = await fetch(`${restrictedBaseUrl}/signup`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: `blocked-${unique}`, displayName: "Blocked", ownerEmail: `blocked-${unique}@example.com`, ownerPassword: "irrelevant passphrase" }),
      });
      assert.equal(signupResponse.status, 404, "no public organization-signup route should exist for Phase 1");

      // The invite-only flow must still work on the same, restricted app.
      const { token: rawToken } = await invitationService.invite({
        organizationId: orgA.id, email: `still-works-${unique}@example.com`, roleKey: "researcher",
      });
      const acceptResponse = await fetch(`${restrictedBaseUrl}/signup-from-invitation`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: rawToken, password: "still works passphrase" }),
      });
      assert.equal(acceptResponse.status, 201, "signup-from-invitation must remain available when organization signup is disabled");
    } finally {
      await new Promise((resolve) => restrictedServer.close(resolve));
    }
  });
});
