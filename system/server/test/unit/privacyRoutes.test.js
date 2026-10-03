import test from "node:test";
import assert from "node:assert/strict";
import { registerPrivacyRoutes } from "../../src/routes/privacyRoutes.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function register(overrides = {}) {
  const routes = new Map();
  const app = {
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
  };
  const request = { id: "request-1", status: "awaiting_account_lock" };
  const failures = [];
  const dependencies = {
    app,
    requireAuth: (_req, _res, next) => next(),
    accountService: {
      listAccounts: async () => [],
      validateDeletion: async (_username, _password, { authorize }) => { await authorize(); },
      requestDeletion: async (_username, _password, { authorize }) => { await authorize(); return { active: false }; },
    },
    requestStore: {
      createPublic: () => request,
      createVerified: () => request,
      markAccountLocked: () => ({ ...request, status: "account_locked" }),
      markFailed: () => ({ ...request, status: "failed" }),
    },
    hmacKey: "privacy-route-test-secret",
    resolveCurrentSession: async () => ({ username: "va-one" }),
    revokeAccountAccess() {},
    destroyCurrentSession: async () => {},
    recordAudit() {},
    logFailure: (label, error) => failures.push([label, error]),
    allowPublicRequest: () => true,
    buildDataExport: async username => ({ schemaVersion: 1, account: { username } }),
    normalizeEmail: value => value.replace(".", "").replace("+request", ""),
    ...overrides,
  };
  registerPrivacyRoutes(dependencies);
  return { routes, request, failures };
}

test("self-service deletion rechecks the authoritative stored session at the repository commit point", async () => {
  const reachedCommit = deferred();
  const continueCommit = deferred();
  let current = { username: "va-one" };
  let committed = false;
  const { routes } = register({
    resolveCurrentSession: async request => {
      assert.equal(request.sessionID, "session-1");
      return current;
    },
    accountService: {
      listAccounts: async () => [],
      validateDeletion: async (_username, _password, { authorize }) => { await authorize(); },
      requestDeletion: async (_username, _password, { authorize }) => {
        reachedCommit.resolve();
        await continueCommit.promise;
        await authorize();
        committed = true;
      },
    },
  });
  const handler = routes.get("POST /api/me/deletion-request").at(-1);
  const req = {
    body: { password: "current-password", confirmation: "DELETE MY ACCOUNT" },
    currentOperator: { username: "va-one" },
    session: { operator: { username: "va-one", authVersion: 0 } },
    sessionID: "session-1",
  };
  const res = responseRecorder();
  let forwarded = null;
  const pending = handler(req, res, error => { forwarded = error; });
  await reachedCommit.promise;
  current = null;
  continueCommit.resolve();
  await pending;

  assert.equal(committed, false);
  assert.equal(forwarded, null);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "not logged in" });
});

test("post-commit audit, revocation, state, and session errors cannot misreport a locked account", async () => {
  const injected = new Error("injected post-commit failure");
  const { routes, failures } = register({
    requestStore: {
      createPublic: () => ({ id: "request-1" }),
      createVerified: () => ({ id: "request-1" }),
      markAccountLocked: () => { throw injected; },
      markFailed: () => { throw new Error("must not mark a committed request failed"); },
    },
    revokeAccountAccess: () => { throw injected; },
    destroyCurrentSession: async () => { throw injected; },
    recordAudit: () => { throw injected; },
  });
  const handler = routes.get("POST /api/me/deletion-request").at(-1);
  const req = {
    body: { password: "current-password", confirmation: "DELETE MY ACCOUNT" },
    currentOperator: { username: "va-one" },
    session: { operator: { username: "va-one", authVersion: 0 } },
    sessionID: "session-1",
  };
  const res = responseRecorder();
  let forwarded = null;
  await handler(req, res, error => { forwarded = error; });

  assert.equal(forwarded, null);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, requestId: "request-1", status: "account_locked" });
  assert.equal(failures.length, 4);
});

test("data export rechecks the stored session after collection before publishing data", async () => {
  const collected = deferred();
  const continueCollection = deferred();
  let current = { username: "va-one" };
  const { routes } = register({
    buildDataExport: async () => {
      collected.resolve();
      await continueCollection.promise;
      return { schemaVersion: 1, account: { username: "va-one" } };
    },
    resolveCurrentSession: async () => current,
  });
  const handler = routes.get("GET /api/me/data-export").at(-1);
  const req = { currentOperator: { username: "va-one" }, sessionID: "session-1" };
  const res = {
    ...responseRecorder(),
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
  };
  const pending = handler(req, res, error => { throw error; });
  await collected.promise;
  current = null;
  continueCollection.resolve();
  await pending;
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "not logged in" });
  assert.deepEqual(res.headers, {});
});
