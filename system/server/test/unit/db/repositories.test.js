import test from "node:test";
import assert from "node:assert/strict";
import { createOrganizationRepository } from "../../../src/db/repositories/organizationRepository.js";
import { createUserRepository } from "../../../src/db/repositories/userRepository.js";
import { createMembershipRepository } from "../../../src/db/repositories/membershipRepository.js";
import { createRoleRepository } from "../../../src/db/repositories/roleRepository.js";
import { createOrganizationIdentityService } from "../../../src/services/organizationIdentityService.js";

function fakePool(rowsByCall = []) {
  const calls = [];
  let index = 0;
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      const rows = rowsByCall[index] ?? [];
      index += 1;
      return { rows, rowCount: rows.length };
    },
  };
}

for (const [name, factory] of [
  ["organization repository", createOrganizationRepository],
  ["user repository", createUserRepository],
  ["membership repository", createMembershipRepository],
  ["role repository", createRoleRepository],
]) {
  test(`${name} requires a queryable pool`, () => {
    assert.throws(() => factory(null), TypeError);
    assert.throws(() => factory({}), TypeError);
  });
}

test("organizationRepository.create inserts with the expected columns and returns the row", async () => {
  const pool = fakePool([[{ id: "org-1", slug: "acme", display_name: "Acme" }]]);
  const repository = createOrganizationRepository(pool);
  const org = await repository.create({ slug: "acme", displayName: "Acme" });
  assert.equal(org.id, "org-1");
  assert.match(pool.calls[0].text, /INSERT INTO identity\.organizations/);
  assert.deepEqual(pool.calls[0].params, ["acme", "Acme", null, "UTC"]);
});

test("userRepository.createWithPrimaryEmail normalizes the email and links it to the new user", async () => {
  const pool = fakePool([
    [{ id: "user-1" }],
    [{ id: "email-1", user_id: "user-1", normalized_email: "va@example.com" }],
  ]);
  const repository = createUserRepository(pool);
  const user = await repository.createWithPrimaryEmail({ email: "VA@Example.com", passwordHash: "hash" });
  assert.equal(user.id, "user-1");
  assert.equal(user.primaryEmail.normalized_email, "va@example.com");
  assert.deepEqual(pool.calls[1].params, ["user-1", "VA@Example.com", "va@example.com"]);
});

test("userRepository.getByEmail normalizes case before querying", async () => {
  const pool = fakePool([[{ id: "user-1" }]]);
  const repository = createUserRepository(pool);
  await repository.getByEmail("Owner@Example.COM");
  assert.deepEqual(pool.calls[0].params, ["owner@example.com"]);
});

test("membershipRepository.add inserts organization_id/user_id/status", async () => {
  const pool = fakePool([[{ id: "membership-1", organization_id: "org-1", user_id: "user-1", status: "active" }]]);
  const repository = createMembershipRepository(pool);
  const membership = await repository.add({ organizationId: "org-1", userId: "user-1" });
  assert.equal(membership.id, "membership-1");
  assert.deepEqual(pool.calls[0].params, ["org-1", "user-1", "active"]);
});

test("roleRepository.getByKey prefers an organization-specific role over the system template", async () => {
  const pool = fakePool([[{ id: "role-org-1", organization_id: "org-1", key: "owner" }]]);
  const repository = createRoleRepository(pool);
  const role = await repository.getByKey({ organizationId: "org-1", key: "owner" });
  assert.equal(role.id, "role-org-1");
  assert.match(pool.calls[0].text, /ORDER BY organization_id IS NOT NULL DESC/);
});

test("roleRepository.hasPermission returns a boolean, not a row count", async () => {
  const pool = fakePool([[{ "?column?": 1 }]]);
  const repository = createRoleRepository(pool);
  assert.equal(await repository.hasPermission("membership-1", "billing:manage"), true);
});

test("organizationIdentityService requires every named dependency", () => {
  const pool = fakePool();
  const stub = () => {};
  const base = {
    pool, withTransaction: stub, organizationRepository: stub, userRepository: stub,
    membershipRepository: stub, roleRepository: stub, hashPassword: stub,
  };
  assert.throws(() => createOrganizationIdentityService({ ...base, hashPassword: undefined }), /hashPassword/);
  assert.throws(() => createOrganizationIdentityService({ ...base, pool: undefined }), /pool/);
  assert.doesNotThrow(() => createOrganizationIdentityService(base));
});
