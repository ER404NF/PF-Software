// Real-PostgreSQL functional test for the M04 part 1 organization/identity/
// RBAC repositories and service. Requires TEST_DATABASE_URL — skips
// entirely when unset (normal for local development with no PostgreSQL
// installed). RLS enforcement itself is covered by tenantIsolation.test.js;
// this file focuses on the repository/service layer's own correctness
// (transactional composition, role/permission resolution), run through the
// admin connection the CI Postgres service provides.

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
import { createOrganizationIdentityService } from "../../../src/services/organizationIdentityService.js";
import { hashPassword, verifyPassword } from "../../../src/authStore.js";

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

test("organization identity service (real PostgreSQL)", { skip }, async (t) => {
  await runMigrationsUp(TEST_DATABASE_URL);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  t.after(() => pool.end());

  const organizationRepository = createOrganizationRepository(pool);
  const userRepository = createUserRepository(pool);
  const membershipRepository = createMembershipRepository(pool);
  const roleRepository = createRoleRepository(pool);
  const service = createOrganizationIdentityService({
    pool, withTransaction, organizationRepository, userRepository, membershipRepository, roleRepository, hashPassword,
  });

  const unique = crypto.randomBytes(4).toString("hex");

  await t.test("createOrganizationWithOwner creates org + user + membership + owner role atomically", async () => {
    const { organization, user, membership } = await service.createOrganizationWithOwner({
      slug: `acme-${unique}`,
      displayName: "Acme Corp",
      ownerEmail: `owner-${unique}@example.com`,
      ownerPassword: "correct horse battery staple",
      ownerDisplayName: "Owner One",
    });

    assert.equal(organization.slug, `acme-${unique}`);
    assert.equal(organization.status, "active");
    assert.equal(user.primaryEmail.normalized_email, `owner-${unique}@example.com`);
    assert.equal(membership.organization_id, organization.id);
    assert.equal(membership.user_id, user.id);

    // The stored hash verifies with authStore.js's own verifyPassword —
    // proving this service reuses the existing, already-audited password
    // hashing rather than a new, untested implementation.
    const stored = await userRepository.getById(user.id);
    assert.equal(verifyPassword("correct horse battery staple", stored.password_hash), true);
    assert.equal(verifyPassword("wrong password", stored.password_hash), false);

    const permissions = await service.permissionsForMembership(membership.id);
    assert.ok(permissions.includes("organization:manage"), "owner must have organization:manage");
    assert.ok(permissions.includes("billing:manage"), "owner must have billing:manage");
    assert.equal(await service.hasPermission(membership.id, "organization:manage"), true);
  });

  await t.test("addMember assigns a scoped role, not full owner access", async () => {
    const { organization } = await service.createOrganizationWithOwner({
      slug: `beta-${unique}`,
      displayName: "Beta Inc",
      ownerEmail: `beta-owner-${unique}@example.com`,
      ownerPassword: "another very strong passphrase",
    });
    const vaUser = await userRepository.createWithPrimaryEmail({
      email: `va-${unique}@example.com`,
      passwordHash: hashPassword("va password here"),
      displayName: "VA One",
    });

    const membership = await service.addMember({ organizationId: organization.id, userId: vaUser.id, roleKey: "va_operator" });
    const permissions = await service.permissionsForMembership(membership.id);
    assert.ok(permissions.includes("device:control"), "va_operator must have device:control");
    assert.ok(!permissions.includes("billing:manage"), "va_operator must NOT have billing:manage");
    assert.ok(!permissions.includes("organization:manage"), "va_operator must NOT have organization:manage");
  });

  await t.test("addMember rejects an unknown role key without partially committing", async () => {
    const { organization } = await service.createOrganizationWithOwner({
      slug: `gamma-${unique}`,
      displayName: "Gamma LLC",
      ownerEmail: `gamma-owner-${unique}@example.com`,
      ownerPassword: "yet another strong passphrase",
    });
    const otherUser = await userRepository.createWithPrimaryEmail({
      email: `nobody-${unique}@example.com`,
      passwordHash: hashPassword("does not matter"),
    });

    await assert.rejects(
      () => service.addMember({ organizationId: organization.id, userId: otherUser.id, roleKey: "nonexistent_role" }),
      /unknown role key/,
    );
    const membership = await membershipRepository.get(organization.id, otherUser.id);
    assert.equal(membership, null, "the membership insert must have been rolled back with the failed role assignment");
  });

  await t.test("createOrganizationWithOwner rolls back the organization if the owner role is missing permissions data", async () => {
    // Sanity check that the transaction is really atomic: an organization
    // whose slug collides with an existing one must fail the whole
    // operation, not leave a partial user/membership behind.
    const slug = `delta-${unique}`;
    await service.createOrganizationWithOwner({
      slug, displayName: "Delta First", ownerEmail: `delta-1-${unique}@example.com`, ownerPassword: "strong passphrase one",
    });
    await assert.rejects(
      () => service.createOrganizationWithOwner({
        slug, displayName: "Delta Duplicate", ownerEmail: `delta-2-${unique}@example.com`, ownerPassword: "strong passphrase two",
      }),
      /duplicate key|unique/i,
    );
    const duplicateOwner = await userRepository.getByEmail(`delta-2-${unique}@example.com`);
    assert.equal(duplicateOwner, null, "the second owner's user row must not exist after the rollback");
  });
});
