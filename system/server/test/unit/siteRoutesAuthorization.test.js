import test from "node:test";
import assert from "node:assert/strict";
import { registerSiteRoutes } from "../../src/routes/siteRoutes.js";

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

function registeredRoutes(siteStore, currentStoredOperator) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers.at(-1)); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)); },
    patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers.at(-1)); },
    delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers.at(-1)); },
  };
  registerSiteRoutes({
    app,
    siteStore,
    siteLinkHub: {
      siteStatus: () => ({ connected: false }),
      disconnect() {},
      removeSite() {},
    },
    requireCapability: () => (_req, _res, next) => next(),
    manageSitesCapability: "manage_sites",
    currentStoredOperator,
    hasCapability: operator => operator?.role === "admin",
    auditLog: { logEvent() {} },
    hubOrigin: () => "https://hub.example.test",
    schedulingTimeZone: "Europe/Rome",
    broadcastDeviceList() {},
  });
  return routes;
}

for (const scenario of [
  { method: "POST", path: "/api/admin/sites", operation: "create", params: {}, body: { name: "Rome" } },
  { method: "PATCH", path: "/api/admin/sites/:siteId", operation: "update", params: { siteId: "rome" }, body: { name: "Rome Two" } },
  { method: "POST", path: "/api/admin/sites/:siteId/rotate-token", operation: "rotate", params: { siteId: "rome" }, body: {} },
  { method: "DELETE", path: "/api/admin/sites/:siteId", operation: "remove", params: { siteId: "rome" }, body: {} },
]) {
  test(`site ${scenario.operation} rechecks authorization at the repository commit point`, async () => {
    const reachedCommit = deferred();
    const continueCommit = deferred();
    let current = { username: "admin", role: "admin" };
    let committed = false;
    const mutate = async (...args) => {
      const options = args.at(-1)?.authorize ? args.at(-1) : {};
      reachedCommit.resolve();
      await continueCommit.promise;
      await options.authorize?.();
      committed = true;
      if (scenario.operation === "create" || scenario.operation === "rotate") {
        return { site: { id: "rome", name: "Rome", timeZone: "Europe/Rome" }, token: "pfs_test" };
      }
      if (scenario.operation === "update") return { id: "rome", name: "Rome Two", timeZone: "Europe/Rome" };
      return true;
    };
    const siteStore = {
      list: async () => [],
      get: async () => ({ id: "rome", name: "Rome", timeZone: "Europe/Rome" }),
      create: mutate,
      update: mutate,
      rotate: mutate,
      remove: mutate,
    };
    const routes = registeredRoutes(siteStore, async () => current);
    const req = {
      body: scenario.body,
      params: scenario.params,
      currentOperator: current,
      session: { operator: { username: "admin" } },
      sessionID: "session-1",
    };
    const res = responseRecorder();
    let forwarded = null;
    const pending = routes.get(`${scenario.method} ${scenario.path}`)(req, res, error => { forwarded = error; });

    await reachedCommit.promise;
    current = null;
    continueCommit.resolve();
    await pending;

    assert.equal(committed, false, "revoked authorization must stop the durable mutation");
    assert.equal(forwarded, null);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body?.code, "AUTHENTICATION_REQUIRED");
  });
}
