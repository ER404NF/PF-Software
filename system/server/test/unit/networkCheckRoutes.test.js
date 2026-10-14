import { test } from "node:test";
import assert from "node:assert/strict";
import { registerNetworkCheckRoutes } from "../../src/routes/networkCheckRoutes.js";

test("pool-only network verification audits derived commercial-proxy egress without credentials", async () => {
  let handler;
  const auditEvents = [];
  const app = { post: (_path, routeHandler) => { handler = routeHandler; } };
  const assigned = { id: "proxy-safe-id" };
  const stored = {
    id: assigned.id, protocol: "socks5", host: "proxy.example.test", port: 1080,
    username: "private-user", encryptedPassword: "private-ciphertext", country: "US",
  };
  const effectiveNetwork = { egress: "commercial-proxy", enabled: true, failPolicy: "fail-closed" };
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
    networkRoutingOrchestrator: { async checkHealth() {}, getRoute: () => ({ state: "routed" }) },
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

  const response = await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    Promise.resolve(handler({
      currentOperator: { username: "safe-operator" }, params: { deviceId: "pool-only" },
      body: {}, session: { operator: "safe-operator" },
    }, res)).catch(reject);
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.network.egress, "commercial-proxy");
  assert.equal(auditEvents.length, 1);
  assert.deepEqual(auditEvents[0].detail, {
    proxyId: "proxy-safe-id", level: "proxy-and-host-route", protected: false,
    networkEgress: "commercial-proxy",
  });
  assert.doesNotMatch(JSON.stringify(auditEvents[0]), /private-user|private-password|private-ciphertext|proxy\.example\.test/);
});
