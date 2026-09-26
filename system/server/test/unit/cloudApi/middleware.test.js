import test from "node:test";
import assert from "node:assert/strict";
import { createAuthenticate } from "../../../src/cloudApi/middleware/authenticate.js";
import { createRequireMembership } from "../../../src/cloudApi/middleware/requireMembership.js";
import { createRequirePermission } from "../../../src/cloudApi/middleware/requirePermission.js";

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test("authenticate rejects a request with no Authorization header", async () => {
  const middleware = createAuthenticate({
    identitySessionService: { verifySession: async () => null, touchSession: async () => {} },
    userRepository: { getById: async () => null },
  });
  const req = { headers: {} };
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("authenticate rejects an invalid/expired session token", async () => {
  const middleware = createAuthenticate({
    identitySessionService: { verifySession: async () => null, touchSession: async () => {} },
    userRepository: { getById: async () => null },
  });
  const req = { headers: { authorization: "Bearer pfu_something" } };
  const res = fakeRes();
  await middleware(req, res, () => { throw new Error("must not call next()"); });
  assert.equal(res.statusCode, 401);
});

test("authenticate rejects a valid session belonging to a non-active user", async () => {
  const middleware = createAuthenticate({
    identitySessionService: { verifySession: async () => ({ id: "session-1", user_id: "user-1" }), touchSession: async () => {} },
    userRepository: { getById: async () => ({ id: "user-1", status: "suspended" }) },
  });
  const req = { headers: { authorization: "Bearer pfu_valid" } };
  const res = fakeRes();
  await middleware(req, res, () => { throw new Error("must not call next()"); });
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /not active/);
});

test("authenticate attaches user/session and calls next() on success", async () => {
  const user = { id: "user-1", status: "active" };
  const session = { id: "session-1", user_id: "user-1" };
  const middleware = createAuthenticate({
    identitySessionService: { verifySession: async () => session, touchSession: async () => {} },
    userRepository: { getById: async () => user },
  });
  const req = { headers: { authorization: "Bearer pfu_valid" } };
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.userId, "user-1");
  assert.equal(req.user, user);
  // req.identitySession, not req.session: this API is mounted inside
  // index.js, which already uses req.session for its own express-session
  // Session instance — reusing that name here would silently clobber it
  // (see authenticate.js's own comment for the real bug this caused).
  assert.equal(req.identitySession, session);
});

test("requireMembership 404s an unknown or inactive organization", async () => {
  const factory = createRequireMembership({
    pool: {}, withTransaction: async () => null,
    organizationRepository: { getById: async () => null },
    membershipRepository: { get: async () => null },
  });
  const middleware = factory();
  const req = { userId: "user-1", params: { organizationId: "org-1" } };
  const res = fakeRes();
  await middleware(req, res, () => { throw new Error("must not call next()"); });
  assert.equal(res.statusCode, 404);
});

test("requireMembership 403s when the caller has no active membership in that organization", async () => {
  const factory = createRequireMembership({
    pool: {}, withTransaction: async (_pool, fn) => fn({}),
    organizationRepository: { getById: async () => ({ id: "org-1", status: "active" }) },
    membershipRepository: { get: async () => null },
  });
  const middleware = factory();
  const req = { userId: "user-1", params: { organizationId: "org-1" } };
  const res = fakeRes();
  await middleware(req, res, () => { throw new Error("must not call next()"); });
  assert.equal(res.statusCode, 403);
});

test("requireMembership attaches organization/membership and calls next() on success", async () => {
  const organization = { id: "org-1", status: "active" };
  const membership = { id: "membership-1", status: "active" };
  const factory = createRequireMembership({
    pool: {}, withTransaction: async (_pool, fn) => fn({}),
    organizationRepository: { getById: async () => organization },
    membershipRepository: { get: async () => membership },
  });
  const middleware = factory();
  const req = { userId: "user-1", params: { organizationId: "org-1" } };
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.organization, organization);
  assert.equal(req.membership, membership);
});

test("requirePermission 403s when the membership lacks the permission", async () => {
  const factory = createRequirePermission({ roleRepository: { hasPermission: async () => false } });
  const middleware = factory("billing:manage");
  const req = { membership: { id: "membership-1" } };
  const res = fakeRes();
  await middleware(req, res, () => { throw new Error("must not call next()"); });
  assert.equal(res.statusCode, 403);
});

test("requirePermission calls next() when the membership has the permission", async () => {
  const factory = createRequirePermission({ roleRepository: { hasPermission: async () => true } });
  const middleware = factory("billing:manage");
  const req = { membership: { id: "membership-1" } };
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
