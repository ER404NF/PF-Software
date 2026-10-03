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

  // P6 step 3 (docs/productionization/PHASE1_TEAM_ROLLOUT_HANDOUT.md): "two
  // acceptances of the same invitation... confirm exactly one wins." Unlike
  // the sequential test above (accept, await, then accept again), this fires
  // both acceptInvitation() calls with no ordering guarantee at all — the
  // real proof that invitationRepository.markAccepted()'s conditional
  // `UPDATE ... WHERE accepted_at IS NULL` is actually race-safe under the
  // database's own row locking, not just safe when called one at a time.
  await t.test("two concurrent acceptances of the same invitation — exactly one wins, one membership, no crash", async () => {
    const racerA = await userRepository.createWithPrimaryEmail({
      email: `racer-a-${unique}@example.com`, passwordHash: hashPassword("racer a passphrase"),
    });
    const racerB = await userRepository.createWithPrimaryEmail({
      email: `racer-b-${unique}@example.com`, passwordHash: hashPassword("racer b passphrase"),
    });
    const { token } = await invitationService.invite({
      organizationId: organization.id, email: `racer-shared-${unique}@example.com`, roleKey: "reviewer",
    });

    const results = await Promise.allSettled([
      invitationService.acceptInvitation({ token, userId: racerA.id }),
      invitationService.acceptInvitation({ token, userId: racerB.id }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent acceptance must win");
    assert.equal(rejected.length, 1, "exactly one concurrent acceptance must be cleanly rejected");
    assert.match(rejected[0].reason.message, /already accepted|accepted or revoked by someone else/);

    const winnerId = fulfilled[0].value.user_id;
    const [membershipA, membershipB] = await Promise.all([
      membershipRepository.get(organization.id, racerA.id),
      membershipRepository.get(organization.id, racerB.id),
    ]);
    // Exactly one of the two ends up with a membership — the winner — never
    // both (double-grant) and never neither (lost the write entirely).
    assert.equal([membershipA, membershipB].filter(Boolean).length, 1,
      "exactly one racer must end up with a membership, never zero or both");
    const winnerMembership = winnerId === racerA.id ? membershipA : membershipB;
    assert.notEqual(winnerMembership, null, "the racer acceptInvitation() reported as winning must actually have the membership");
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
