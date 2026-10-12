import test from "node:test";
import assert from "node:assert/strict";
import { registerProxyProviderRoutes } from "../../src/routes/proxyProviderRoutes.js";

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("provider inventory authorizes before external calls and reauthorizes before response", async () => {
  const routes = new Map();
  const app = {
    get(path, middleware, handler) { routes.set(`GET ${path}`, { middleware, handler }); },
    patch() {}, post() {}, delete() {},
  };
  let authorized = true;
  let inventoryCalls = 0;
  let releaseInventory;
  const inventoryGate = new Promise(resolve => { releaseInventory = resolve; });
  const provider = { id: "fixture", label: "Fixture", supportsRotation: false,
    async listExits() { inventoryCalls += 1; await inventoryGate; return [{ id: "safe", region: "test" }]; } };
  registerProxyProviderRoutes({
    app, registry: new Map([[provider.id, provider]]), capabilities: { VIEW_PROXY_POOL: "view", MANAGE_PROXY: "manage", ASSIGN_PROXY: "assign" },
    requireCapability: capability => capability,
    currentStoredOperator: async () => authorized ? { username: "admin" } : null,
    hasCapability: () => true, canAccessDevice: () => true, knownDevice: () => true,
    auditLog: { logEvent() {} },
  });
  const route = routes.get("GET /api/admin/proxy-providers");
  const denied = response();
  authorized = false;
  await route.handler({}, denied, error => { throw error; });
  assert.equal(denied.statusCode, 401);
  assert.equal(inventoryCalls, 0);

  authorized = true;
  const stale = response();
  const pending = route.handler({}, stale, error => { throw error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inventoryCalls, 1);
  authorized = false;
  releaseInventory();
  await pending;
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.body.code, "AUTHENTICATION_REQUIRED");
});
