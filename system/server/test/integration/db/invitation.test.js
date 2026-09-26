// Real-PostgreSQL functional test for the M04 part 3 invitation layer.
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
import { createInvitationRepository } from "../../../src/db/repositories/invitationRepository.js";
import { createOrganizationIdentityService } from "../../../src/services/organizationIdentityService.js";
import { createInvitationService } from "../../../src/services/invitationService.js";
import { hashPassword } from "../../../src/authStore.js";

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

test("invitation service (real PostgreSQL)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const organizationRepository = createOrganizationRepository(pool);
  const userRepository = createUserRepository(pool);
  const membershipRepository = createMembershipRepository(pool);
  const roleRepository = createRoleRepository(pool);
  const invitationRepository = createInvitationRepository(pool);
  const organizationService = createOrganizationIdentityService({
    pool, withTransaction, organizationRepository, userRepository, membershipRepository, roleRepository, hashPassword,
  });
  const invitationService = createInvitationService({
    pool, withTransaction, invitationRepository, membershipRepository, roleRepository,
  });

  const unique = crypto.randomBytes(4).toString("hex");
  const { organization } = await organizationService.createOrganizationWithOwner({
    slug: `invite-org-${unique}`,
    displayName: "Invite Org",
    ownerEmail: `invite-owner-${unique}@example.com`,
    ownerPassword: "a reasonably strong owner passphrase",
  });
  const invitee = await userRepository.createWithPrimaryEmail({
    email: `invitee-${unique}@example.com`,
    passwordHash: hashPassword("invitee passphrase"),
  });

  await t.test("accepting a real invitation creates a membership with the invited role", async () => {
    const { token } = await invitationService.invite({
      organizationId: organization.id, email: `invitee-${unique}@example.com`, roleKey: "researcher",
    });
    const membership = await invitationService.acceptInvitation({ token, userId: invitee.id });
    assert.equal(membership.organization_id, organization.id);
    const permissions = await roleRepository.permissionsForMembership(membership.id);
    assert.ok(permissions.includes("research:run"));
    assert.ok(!permissions.includes("billing:manage"));
  });

  await t.test("the same invitation cannot be accepted twice, and no duplicate membership is left behind", async () => {
    const second = await userRepository.createWithPrimaryEmail({
      email: `invitee2-${unique}@example.com`, passwordHash: hashPassword("another passphrase"),
    });
    const { token } = await invitationService.invite({
      organizationId: organization.id, email: `invitee2-${unique}@example.com`, roleKey: "reviewer",
    });
    await invitationService.acceptInvitation({ token, userId: second.id });
    await assert.rejects(() => invitationService.acceptInvitation({ token, userId: second.id }), /already accepted/);
    const membership = await membershipRepository.get(organization.id, second.id);
    assert.notEqual(membership, null, "the first, successful acceptance's membership must still exist");
  });

  await t.test("a revoked invitation cannot be accepted against the real database", async () => {
    const third = await userRepository.createWithPrimaryEmail({
      email: `invitee3-${unique}@example.com`, passwordHash: hashPassword("yet another passphrase"),
    });
    const { token, invitation } = await invitationService.invite({
      organizationId: organization.id, email: `invitee3-${unique}@example.com`, roleKey: "va_operator",
    });
    await invitationService.revoke(invitation.id);
    await assert.rejects(() => invitationService.acceptInvitation({ token, userId: third.id }), /revoked/);
  });
});
