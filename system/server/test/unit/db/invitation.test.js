import test from "node:test";
import assert from "node:assert/strict";
import { createInvitationRepository } from "../../../src/db/repositories/invitationRepository.js";
import { createInvitationService } from "../../../src/services/invitationService.js";

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

test("invitationRepository requires a queryable pool", () => {
  assert.throws(() => createInvitationRepository(null), TypeError);
});

test("invitationRepository.create inserts every column including role_key", async () => {
  const pool = fakePool([[{ id: "invite-1" }]]);
  const repository = createInvitationRepository(pool);
  await repository.create({
    organizationId: "org-1", emailNormalized: "va@example.com", tokenHash: "hash",
    invitedByUserId: "user-1", expiresAt: new Date("2026-01-01"), roleKey: "va_operator",
  });
  assert.deepEqual(pool.calls[0].params, ["org-1", "va@example.com", "hash", "user-1", new Date("2026-01-01"), "va_operator"]);
});

test("invitation service requires its named dependencies", () => {
  const stub = () => {};
  assert.throws(() => createInvitationService({}), /pool/);
  assert.throws(
    () => createInvitationService({ pool: {}, withTransaction: stub, invitationRepository: stub, membershipRepository: stub }),
    /roleRepository/,
  );
});

function fakeRoleRepository(knownRoles = new Map([["va_operator", { id: "role-va" }], ["owner", { id: "role-owner" }]])) {
  return { async getByKey({ key }) { return knownRoles.get(key) ?? null; }, async assignToMembership() {} };
}

function fakeInvitationRepository() {
  const invitations = new Map();
  let nextId = 1;
  return {
    invitations,
    async create({ organizationId, emailNormalized, tokenHash, invitedByUserId, expiresAt, roleKey }) {
      const id = `invite-${nextId++}`;
      const row = { id, organization_id: organizationId, email_normalized: emailNormalized, token_hash: tokenHash,
        invited_by_user_id: invitedByUserId, expires_at: expiresAt, role_key: roleKey, accepted_at: null, revoked_at: null };
      invitations.set(id, row);
      return row;
    },
    async getByTokenHash(tokenHash) {
      return [...invitations.values()].find((row) => row.token_hash === tokenHash) ?? null;
    },
    async markAccepted(id) {
      const row = invitations.get(id);
      if (!row || row.accepted_at || row.revoked_at) return null;
      row.accepted_at = new Date();
      return row;
    },
    async markRevoked(id) {
      const row = invitations.get(id);
      if (!row || row.accepted_at) return null;
      row.revoked_at = new Date();
      return row;
    },
    async listForOrganization(organizationId) {
      return [...invitations.values()].filter((row) => row.organization_id === organizationId);
    },
  };
}

function fakeMembershipRepository() {
  const memberships = [];
  return {
    memberships,
    async add({ organizationId, userId, status }) {
      const membership = { id: `membership-${memberships.length + 1}`, organization_id: organizationId, user_id: userId, status };
      memberships.push(membership);
      return membership;
    },
  };
}

function serviceWith({ roleRepository = fakeRoleRepository(), invitationRepository = fakeInvitationRepository(),
  membershipRepository = fakeMembershipRepository() } = {}) {
  const pool = fakePool();
  const withTransaction = async (_pool, fn) => fn(pool);
  return { service: createInvitationService({ pool, withTransaction, invitationRepository, membershipRepository, roleRepository }),
    invitationRepository, membershipRepository, roleRepository };
}

test("invite() rejects an unknown role key without creating an invitation", async () => {
  const { service, invitationRepository } = serviceWith();
  await assert.rejects(
    () => service.invite({ organizationId: "org-1", email: "va@example.com", roleKey: "nonexistent" }),
    /unknown role key/,
  );
  assert.equal(invitationRepository.invitations.size, 0);
});

test("invite() normalizes the email and returns the raw token exactly once", async () => {
  const { service } = serviceWith();
  const { token, invitation } = await service.invite({ organizationId: "org-1", email: "VA@Example.com", roleKey: "va_operator" });
  assert.match(token, /^pfi_/);
  assert.equal(invitation.email_normalized, "va@example.com");
  assert.notEqual(invitation.token_hash, token);
});

test("acceptInvitation() creates a membership with the invitation's role and marks it accepted", async () => {
  const { service, membershipRepository } = serviceWith();
  const { token } = await service.invite({ organizationId: "org-1", email: "va@example.com", roleKey: "va_operator" });
  const membership = await service.acceptInvitation({ token, userId: "user-1" });
  assert.equal(membership.organization_id, "org-1");
  assert.equal(membership.user_id, "user-1");
  assert.equal(membershipRepository.memberships.length, 1);
});

test("acceptInvitation() rejects a second acceptance of the same invitation", async () => {
  const { service } = serviceWith();
  const { token } = await service.invite({ organizationId: "org-1", email: "va@example.com", roleKey: "va_operator" });
  await service.acceptInvitation({ token, userId: "user-1" });
  await assert.rejects(() => service.acceptInvitation({ token, userId: "user-2" }), /already accepted/);
});

test("acceptInvitation() rejects an unknown or already-used token", async () => {
  const { service } = serviceWith();
  await assert.rejects(() => service.acceptInvitation({ token: "pfi_does-not-exist", userId: "user-1" }), /invalid or expired/);
});

test("a revoked invitation cannot be accepted", async () => {
  const { service, invitationRepository } = serviceWith();
  const { token, invitation } = await service.invite({ organizationId: "org-1", email: "va@example.com", roleKey: "va_operator" });
  await invitationRepository.markRevoked(invitation.id);
  await assert.rejects(() => service.acceptInvitation({ token, userId: "user-1" }), /revoked/);
});

test("an expired invitation cannot be accepted even though it was never revoked", async () => {
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const { invitationRepository } = serviceWith();
  const pool = fakePool();
  const withTransaction = async (_pool, fn) => fn(pool);
  const service = createInvitationService({
    pool, withTransaction, invitationRepository, membershipRepository: fakeMembershipRepository(),
    roleRepository: fakeRoleRepository(), now: () => clock,
  });
  const { token } = await service.invite({ organizationId: "org-1", email: "va@example.com", roleKey: "va_operator", ttlMs: 1000 });
  clock = new Date(clock.getTime() + 2000);
  await assert.rejects(() => service.acceptInvitation({ token, userId: "user-1" }), /invalid or expired/);
});
