import test from "node:test";
import assert from "node:assert/strict";
import { registerProxyPoolRoutes } from "../../src/routes/proxyPoolRoutes.js";

function createApp() {
  const routes = new Map();
  const add = method => (path, middleware, handler) => routes.set(`${method} ${path}`, { middleware, handler });
  return { app: { get: add("GET"), post: add("POST"), patch: add("PATCH"), delete: add("DELETE") }, routes };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function publicProxy(record) {
  return record ? { id: record.id, label: record.label, country: record.country, leasedToDeviceId: record.leasedToDeviceId ?? null } : null;
}

function setup(overrides = {}) {
  const { app, routes } = createApp();
  const capabilities = { VIEW_PROXY_POOL: "proxy:view", MANAGE_PROXY: "proxy:manage", ASSIGN_PROXY: "proxy:assign" };
  const middlewareCalls = [];
  const records = new Map([["px_1", {
    id: "px_1", label: "Safe label", provider: "Provider", protocol: "socks5", host: "secret.example",
    port: 1080, username: "private-user", passwordEncrypted: "ciphertext", country: "IT", leasedToDeviceId: null,
  }]]);
  const healthMutations = [];
  const repository = {
    get: id => records.get(id) ?? null,
    create(fields) { const record = { id: "px_new", ...fields }; records.set(record.id, record); return record; },
    remove(id) { return records.delete(id); },
    assignToDevice({ deviceId, proxyId }) {
      const record = records.get(proxyId);
      if (proxyId && record?.leasedToDeviceId && record.leasedToDeviceId !== deviceId) {
        const error = new Error("this proxy is already assigned to another device"); error.status = 409; throw error;
      }
      if (record) record.leasedToDeviceId = deviceId;
      return record ?? null;
    },
    updateHealth(id, health) { healthMutations.push({ id, health }); const record = records.get(id); record.health = health; return record; },
    ...overrides.proxyPoolRepository,
  };
  const dependencies = {
    app,
    requireCapability(capability) { middlewareCalls.push(capability); return { capability }; },
    capabilities,
    authorizeCurrentOperator: async req => req.currentOperator,
    knownDevice: id => id === "device-a",
    canAccessDevice: (operator, id) => operator.allowedDevices.includes(id),
    proxyPoolRepository: repository,
    proxyCredentialEncryptionKey: "configured-key",
    decryptProxyPassword: () => "plaintext-for-tester-only",
    publicProxy,
    publicNetworkConfig: network => ({ enabled: network.enabled, egress: network.egress }),
    testProxy: async () => ({ status: "healthy", publicIpv4: "198.51.100.5", country: "IT", latencyMs: 12 }),
    getProxyPool: () => [...records.values()].map(publicProxy),
    refreshProxyPoolCache() {},
    setDeviceProxyEnabled: ({ enabled }) => ({ enabled, egress: enabled ? "proxy" : "direct" }),
    configPath: "fixture.json",
    deviceNetwork: new Map(),
    recordAudit() {},
    broadcastDeviceList() {},
    poolProxyForDevice: deviceId => publicProxy([...records.values()].find(item => item.leasedToDeviceId === deviceId)),
    now: () => new Date("2026-10-03T12:00:00.000Z"),
    ...overrides,
  };
  dependencies.proxyPoolRepository = overrides.proxyPoolRepository ? repository : dependencies.proxyPoolRepository;
  registerProxyPoolRoutes(dependencies);
  return { routes, middlewareCalls, records, healthMutations };
}

function request(overrides = {}) {
  return {
    params: {}, body: {},
    currentOperator: { username: "admin", allowedDevices: ["device-a"] },
    ...overrides,
  };
}

test("registers the exact proxy-pool route family with its capability middleware", () => {
  const { routes, middlewareCalls } = setup();
  assert.deepEqual([...routes.keys()], [
    "PATCH /api/admin/devices/:deviceId/proxy",
    "GET /api/admin/proxies",
    "POST /api/admin/proxies",
    "POST /api/admin/proxies/test",
    "POST /api/admin/proxies/:proxyId/test",
    "DELETE /api/admin/proxies/:proxyId",
    "PATCH /api/admin/devices/:deviceId/proxy-assignment",
  ]);
  assert.deepEqual(middlewareCalls, ["proxy:manage", "proxy:view", "proxy:manage", "proxy:manage", "proxy:manage", "proxy:manage", "proxy:assign"]);
});

test("fails closed when credential encryption is unavailable", () => {
  const { routes } = setup({ proxyCredentialEncryptionKey: "" });
  const res = response();
  routes.get("POST /api/admin/proxies").handler(request(), res, assert.fail);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /encryption/i);
});

test("preserves device scope and proxyId validation", () => {
  const { routes } = setup();
  const denied = response();
  routes.get("PATCH /api/admin/devices/:deviceId/proxy-assignment").handler(
    request({ params: { deviceId: "device-a" }, body: { proxyId: "px_1" }, currentOperator: { username: "manager", allowedDevices: [] } }),
    denied,
    assert.fail,
  );
  assert.equal(denied.statusCode, 403);
  const invalid = response();
  routes.get("PATCH /api/admin/devices/:deviceId/proxy-assignment").handler(
    request({ params: { deviceId: "device-a" }, body: { proxyId: 12 } }), invalid, assert.fail,
  );
  assert.equal(invalid.statusCode, 400);
});

test("preserves exclusive lease conflicts and assigned-proxy deletion refusal", () => {
  const assignedError = new Error("release this proxy from its assigned device before deleting it"); assignedError.status = 409;
  const { routes } = setup({ proxyPoolRepository: {
    assignToDevice() { const error = new Error("this proxy is already assigned to another device"); error.status = 409; throw error; },
    remove() { throw assignedError; },
  } });
  const assignment = response();
  routes.get("PATCH /api/admin/devices/:deviceId/proxy-assignment").handler(
    request({ params: { deviceId: "device-a" }, body: { proxyId: "px_1" } }), assignment, assert.fail,
  );
  assert.equal(assignment.statusCode, 409);
  const deletion = response();
  routes.get("DELETE /api/admin/proxies/:proxyId").handler(request({ params: { proxyId: "px_1" } }), deletion, assert.fail);
  assert.equal(deletion.statusCode, 409);
});

test("revocation during a saved asynchronous test suppresses the result and health mutation", async () => {
  const gate = deferred();
  const authorizationError = new Error("not logged in"); authorizationError.status = 401;
  const { routes, healthMutations } = setup({
    testProxy: () => gate.promise,
    authorizeCurrentOperator: async () => { throw authorizationError; },
  });
  const res = response();
  const pending = routes.get("POST /api/admin/proxies/:proxyId/test").handler(
    request({ params: { proxyId: "px_1" } }), res, assert.fail,
  );
  gate.resolve({ status: "healthy", publicIpv4: "198.51.100.5", latencyMs: 9 });
  await pending;
  assert.equal(res.statusCode, 401);
  assert.deepEqual(healthMutations, []);
  assert.equal(JSON.stringify(res.body).includes("198.51.100.5"), false);
});

test("revocation after a failed saved test also prevents failed-health mutation", async () => {
  const failure = new Error("connect failed");
  failure.diagnostic = { code: "P111", name: "Connection failed" };
  const authorizationError = new Error("capability required"); authorizationError.status = 403;
  const { routes, healthMutations } = setup({
    testProxy: async () => { throw failure; },
    authorizeCurrentOperator: async () => { throw authorizationError; },
  });
  const res = response();
  await routes.get("POST /api/admin/proxies/:proxyId/test").handler(request({ params: { proxyId: "px_1" } }), res, assert.fail);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(healthMutations, []);
});

test("unknown repository and tester failures propagate to Express error middleware", async () => {
  const repositoryFailure = new Error("repository unavailable");
  const repository = setup({ proxyPoolRepository: { remove() { throw repositoryFailure; } } });
  let propagated;
  repository.routes.get("DELETE /api/admin/proxies/:proxyId").handler(
    request({ params: { proxyId: "px_1" } }), response(), error => { propagated = error; },
  );
  assert.equal(propagated, repositoryFailure);

  const testerFailure = new Error("tester crashed");
  const tester = setup({ testProxy: async () => { throw testerFailure; } });
  propagated = null;
  await tester.routes.get("POST /api/admin/proxies/test").handler(request(), response(), error => { propagated = error; });
  assert.equal(propagated, testerFailure);
});

test("public pool and successful test responses contain no stored credentials", async () => {
  const { routes } = setup();
  const list = response();
  routes.get("GET /api/admin/proxies").handler(request(), list);
  const tested = response();
  await routes.get("POST /api/admin/proxies/:proxyId/test").handler(request({ params: { proxyId: "px_1" } }), tested, assert.fail);
  for (const body of [list.body, tested.body]) {
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("secret.example"), false);
    assert.equal(serialized.includes("private-user"), false);
    assert.equal(serialized.includes("plaintext-for-tester-only"), false);
    assert.equal(serialized.includes("ciphertext"), false);
  }
});
