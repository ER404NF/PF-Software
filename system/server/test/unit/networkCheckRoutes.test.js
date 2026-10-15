import { test } from "node:test";
import assert from "node:assert/strict";
import { registerNetworkCheckRoutes } from "../../src/routes/networkCheckRoutes.js";

test("pool-only network verification audits derived commercial-proxy egress without credentials", async () => {
  const handlers = new Map();
  const auditEvents = [];
  const app = { post: (routePath, routeHandler) => { handlers.set(routePath, routeHandler); } };
  const assigned = { id: "proxy-safe-id" };
  const stored = {
    id: assigned.id, protocol: "socks5", host: "proxy.example.test", port: 1080,
    username: "private-user", encryptedPassword: "private-ciphertext", country: "US",
  };
  const effectiveNetwork = { egress: "commercial-proxy", enabled: true, failPolicy: "fail-closed" };
  let liveRouting = null;
  let routingHealthChecks = 0;
  registerNetworkCheckRoutes({
    app,
    hasCapability: () => true,
    runNetworkCheckCapability: "run_network_check",
    knownDevice: () => true,
    canAccessDevice: () => true,
    deviceNetwork: { get: () => effectiveNetwork },
    isProxyEgress: egress => egress === "commercial-proxy",
    resolveNetworkCheckTarget: () => null,
    poolProxyForDevice: () => assigned,
    proxyCredentialEncryptionKey: "configured",
    proxyPoolRepository: { get: () => stored, updateHealth() {} },
    testProxy: async () => ({ status: "healthy", publicIpv4: "203.0.113.10" }),
    decryptProxyPassword: () => "private-password",
    refreshProxyPoolCache() {},
    getNetworkRoutingOrchestrator: () => liveRouting,
    networkVerifier: {
      getGeneration: () => 4,
      recordInfrastructureCheck: () => ({ networkVerificationLevel: "proxy-and-host-route", protected: false }),
    },
    networkDecision: () => ({ allowed: true }),
    taskQueue: { stopDevice() {}, tick() {} },
    wss: { clients: [] },
    broadcastDeviceList() {},
    identityService: { resolveSessionPrincipal: async () => ({ username: "safe-operator" }) },
    auditLog: { logEvent() {} },
    recordAudit: event => auditEvents.push(event),
    publicNetworkConfig: network => ({ egress: network.egress }),
    withNetworkEgress: (_deviceId, detail) => ({ ...detail, networkEgress: effectiveNetwork.egress }),
  });

  // The real server registers routes before startup creates the routing
  // orchestrator. The handler must resolve that owner when the request runs,
  // not capture the startup-time null value.
  liveRouting = {
    async checkHealth() { routingHealthChecks += 1; },
    getRoute: () => ({ state: "routed" }),
  };

  const response = await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    Promise.resolve(handlers.get("/api/devices/:deviceId/network-check")({
      currentOperator: { username: "safe-operator" }, params: { deviceId: "pool-only" },
      body: {}, session: { operator: "safe-operator" },
    }, res)).catch(reject);
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.network.egress, "commercial-proxy");
  assert.equal(routingHealthChecks, 1);
  assert.equal(auditEvents.length, 1);
  assert.deepEqual(auditEvents[0].detail, {
    proxyId: "proxy-safe-id", level: "proxy-and-host-route", protected: false,
    networkEgress: "commercial-proxy",
  });
  assert.doesNotMatch(JSON.stringify(auditEvents[0]), /private-user|private-password|private-ciphertext|proxy\.example\.test/);
});

test("configured checks resolve late-bound route proof and quarantine from the live orchestrator", async () => {
  const handlers = new Map();
  let liveRouting = null;
  let proofs = 0;
  let quarantines = 0;
  registerNetworkCheckRoutes({
    app: { post: (routePath, handler) => handlers.set(routePath, handler) },
    hasCapability: () => true,
    runNetworkCheckCapability: "run_network_check",
    manageRoutingCapability: "manage_routing",
    knownDevice: () => true,
    canAccessDevice: () => true,
    deviceNetwork: { get: () => ({ egress: "commercial-proxy", enabled: true }) },
    isProxyEgress: egress => egress === "commercial-proxy",
    resolveNetworkCheckTarget: () => "https://check.example.test/ip",
    poolProxyForDevice: () => null,
    proxyPoolRepository: {},
    getNetworkRoutingOrchestrator: () => liveRouting,
    networkVerifier: {
      async checkDevice(_deviceId, _url, { proveCurrentRoute }) {
        await proveCurrentRoute();
        return { networkMismatch: true, networkMismatchReason: "route mismatch", networkLatestError: { code: "V204" } };
      },
    },
    networkDecision: () => ({ allowed: false }),
    taskQueue: { stopDevice() {}, tick() {} },
    wss: { clients: [] },
    broadcastDeviceList() {},
    identityService: { resolveSessionPrincipal: async () => ({ username: "safe-operator" }) },
    recordAudit() {},
    publicNetworkConfig: () => ({}),
    withNetworkEgress: (_deviceId, detail) => detail,
  });
  liveRouting = {
    async verifyCurrentRoute() { proofs += 1; return true; },
    async quarantineRoute() { quarantines += 1; },
  };

  const response = await new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); } };
    Promise.resolve(handlers.get("/api/devices/:deviceId/network-check")({
      currentOperator: { username: "safe-operator" }, params: { deviceId: "phone-1" },
      body: {}, session: { operator: "safe-operator" },
    }, res)).catch(reject);
  });
  assert.equal(response.status, 200);
  assert.equal(proofs, 1);
  assert.equal(quarantines, 1);
});
