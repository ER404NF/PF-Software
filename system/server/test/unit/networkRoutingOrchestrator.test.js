import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createProxy, assignProxyToDevice } from "../../src/proxyPool.js";
import { NetworkRoutingOrchestrator, ROUTING_STATES } from "../../src/networkRoutingOrchestrator.js";

const MASTER_KEY = "a".repeat(32);

function tempStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-routing-")), "proxy-pool.json");
}

function samplePayload(overrides = {}) {
  return {
    provider: "Oxylabs", protocol: "socks5", host: "proxy.example.com", port: 7000,
    username: "user1", password: "s3cret", country: "US", label: "Pool 1", ...overrides,
  };
}

class FakePrivilegedOps {
  constructor({ testResult = { ok: true }, inspectOutput = "", quarantineError = null } = {}) {
    this.testResult = testResult;
    this.inspectOutput = inspectOutput;
    this.testCalls = [];
    this.loadCalls = [];
    this.clearStateCalls = [];
    this.clearAnchorCalls = 0;
    this.inspectCalls = 0;
    this.quarantineCalls = [];
    this.quarantineError = quarantineError;
  }
  async testRuleset(text) { this.testCalls.push(text); return this.testResult; }
  async loadRuleset(text) { this.loadCalls.push(text); return { ok: true }; }
  async clearState(ip) { this.clearStateCalls.push(ip); return { ok: true }; }
  async clearAnchor() { this.clearAnchorCalls += 1; return { ok: true }; }
  async quarantineBridge(iface) {
    this.quarantineCalls.push(iface);
    if (this.quarantineError) throw this.quarantineError;
    return { ok: true };
  }
  async inspectRules() {
    this.inspectCalls += 1;
    if (this.inspectOutput instanceof Error) throw this.inspectOutput;
    return this.inspectOutput;
  }
  async inspectBridge() { return { available: true, up: true }; }
}

class FakeTunManager {
  constructor() { this.starts = []; this.stops = []; this.activeIfaces = new Set(); this.runningDeviceIds = new Set(); }
  start(opts) {
    this.starts.push(opts);
    this.activeIfaces.add(opts.tunIface);
    this.runningDeviceIds.add(opts.deviceId);
  }
  stop(deviceId) {
    this.stops.push(deviceId);
    const lastStart = [...this.starts].reverse().find(s => s.deviceId === deviceId);
    if (lastStart) this.activeIfaces.delete(lastStart.tunIface);
    this.runningDeviceIds.delete(deviceId);
  }
  // Test-only: simulates the OS process dying without going through stop()
  // (e.g. crashed, killed externally) — isRunning() must reflect that.
  simulateCrash(deviceId) { this.runningDeviceIds.delete(deviceId); }
  isRunning(deviceId) { return this.runningDeviceIds.has(deviceId); }
  getStatus(deviceId) { return { state: this.isRunning(deviceId) ? "running" : "stopped" }; }
  listManagedDeviceIds() { return [...this.runningDeviceIds]; }
}

function makeOrchestrator({ proxyPoolStorePath, testResult, inspectOutput,
  peerResult = { localIp: "10.0.0.2", peerIp: "10.0.0.1" }, interfaces = ["lo0", "en0"],
  listAllInterfaces = null, recoveryDelayMs, setTimeoutFn, clearTimeoutFn, quarantineStorePath = null } = {}) {
  const tunManager = new FakeTunManager();
  const privilegedOps = new FakePrivilegedOps({ testResult, inspectOutput });
  const changes = [];
  const orchestrator = new NetworkRoutingOrchestrator({
    proxyPoolStorePath,
    proxyCredentialEncryptionKey: MASTER_KEY,
    tunManager,
    privilegedOps,
    bridgeIface: "bridge0",
    // Mirrors reality: once tunManager.start() has been called for a given
    // tunIface, a real `ifconfig -l` would show that interface from then
    // on — so allocateTunIface() must not hand the same name to a second
    // device.
    listAllInterfaces: listAllInterfaces ?? (async () => [...interfaces, ...tunManager.activeIfaces]),
    discoverTunPeer: peerResult instanceof Error
      ? async () => { throw peerResult; }
      : async () => peerResult,
    onStateChanged: (deviceId, route) => changes.push({ deviceId, route }),
    ...(recoveryDelayMs === undefined ? {} : { recoveryDelayMs }),
    ...(setTimeoutFn ? { setTimeoutFn } : {}),
    ...(clearTimeoutFn ? { clearTimeoutFn } : {}),
    ...(quarantineStorePath ? { quarantineStorePath } : {}),
  });
  return { orchestrator, tunManager, privilegedOps, changes };
}

test("startRouting refuses to run without a leased pool proxy", async () => {
  const storePath = tempStorePath();
  const { orchestrator } = makeOrchestrator({ proxyPoolStorePath: storePath });
  await assert.rejects(() => orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }), /no pool proxy is assigned/);
});

test("startRouting requires a known usbIp before doing anything else", async () => {
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: tempStorePath() });
  await assert.rejects(() => orchestrator.startRouting("mock-1", {}), /requires a known usbIp/);
  assert.equal(tunManager.starts.length, 0);
});

test("startup reconciliation clears only the private stale PF anchor before routing", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, inspectOutput: "stale private anchor rule" });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  assert.equal(privilegedOps.clearAnchorCalls, 1);
  assert.equal(orchestrator.reconciled, true);
});

test("routing refuses to start when private-anchor reconciliation cannot be inspected", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath, inspectOutput: new Error("permission denied") });
  await assert.rejects(() => orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }),
    error => error.code === "ROUTING_RECONCILIATION_REQUIRED" && error.status === 503);
  assert.equal(tunManager.starts.length, 0);
});

test("authorization revoked during routing preparation prevents tunnel and PF mutations", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  let authorized = true;
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({
    proxyPoolStorePath: storePath,
    listAllInterfaces: async () => { authorized = false; return ["lo0", "en0"]; },
  });

  await assert.rejects(
    () => orchestrator.startRouting("mock-1", {
      usbIp: "192.168.2.10",
      authorize: async () => {
        if (!authorized) throw Object.assign(new Error("routing authorization revoked"), { status: 403 });
      },
    }),
    /authorization revoked/,
  );
  assert.equal(tunManager.starts.length, 0);
  assert.equal(privilegedOps.loadCalls.some(rules => /route-to/.test(rules)), false,
    "authorization failure may add a fail-closed block but must never install a route");
});

test("startRouting happy path: proxy_leased -> tun_starting -> pf_applying -> routed, with decrypted (not encrypted) credentials passed to the tunnel", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager, privilegedOps, changes } = makeOrchestrator({ proxyPoolStorePath: storePath });

  const result = await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });

  assert.equal(result.state, ROUTING_STATES.ROUTED);
  assert.equal(result.tunPeer, "10.0.0.1");
  assert.equal(tunManager.starts.length, 1);
  assert.equal(tunManager.starts[0].deviceId, "mock-1");
  assert.equal(tunManager.starts[0].tunIface, "utun0");
  assert.deepEqual(tunManager.starts[0].proxy, { protocol: "socks5", host: "proxy.example.com", port: 7000, username: "user1", password: "s3cret" });
  assert.equal(privilegedOps.testCalls.length, 1);
  assert.match(privilegedOps.testCalls[0], /192\.168\.2\.10/);
  assert.equal(privilegedOps.loadCalls.length, 1);
  assert.deepEqual(privilegedOps.clearStateCalls, ["192.168.2.10"]);

  const seenStates = changes.filter(c => c.deviceId === "mock-1").map(c => c.route.state);
  assert.deepEqual(seenStates, [
    ROUTING_STATES.PROXY_LEASED, ROUTING_STATES.TUN_STARTING, ROUTING_STATES.PF_APPLYING, ROUTING_STATES.ROUTED,
  ]);
});

test("concurrent startRouting requests for one device share one tunnel setup", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });

  const [first, second] = await Promise.all([
    orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }),
    orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }),
  ]);

  assert.equal(first.state, ROUTING_STATES.ROUTED);
  assert.equal(second.state, ROUTING_STATES.ROUTED);
  assert.equal(tunManager.starts.length, 1);
  assert.equal(privilegedOps.loadCalls.length, 1);
  assert.equal(tunManager.isRunning("mock-1"), true);
});

test("stopRouting requested during setup runs after setup and leaves no resurrected route", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath });
  let releaseInterfaces;
  orchestrator.listAllInterfaces = () => new Promise(resolve => { releaseInterfaces = resolve; });

  const starting = orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  await new Promise(resolve => setImmediate(resolve));
  const stopping = orchestrator.stopRouting("mock-1");
  releaseInterfaces(["lo0", "en0"]);
  await Promise.all([starting, stopping]);

  assert.equal(orchestrator.getRoute("mock-1"), null);
  assert.equal(tunManager.isRunning("mock-1"), false);
});

test("a tunnel that never reports a peer address ends in tun_error and stops the tunnel process", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager } = makeOrchestrator({
    proxyPoolStorePath: storePath, peerResult: new Error("interface not up"),
  });

  await assert.rejects(() => orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }), /never reported a peer address/);
  const route = orchestrator.getRoute("mock-1");
  assert.equal(route.state, ROUTING_STATES.TUN_ERROR);
  assert.equal(tunManager.stops.includes("mock-1"), true);
});

test("a failure discovering/allocating the tun interface still lands in tun_error, not stuck at proxy_leased with no error", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath });
  orchestrator.listAllInterfaces = async () => { throw new Error("ifconfig -l failed"); };

  await assert.rejects(() => orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }), /ifconfig -l failed/);
  const route = orchestrator.getRoute("mock-1");
  assert.equal(route.state, ROUTING_STATES.TUN_ERROR);
  assert.equal(route.lastError, "Proxy tunnel failed to start");
  assert.equal(route.latestError.code, "T202");
  assert.doesNotMatch(JSON.stringify(route), /ifconfig -l failed/);
  assert.equal(tunManager.starts.length, 0, "never got as far as starting a tunnel");
});

test("a stale tunnel cleanup failure before route startup is classified and remains unprotected", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath });
  orchestrator.routes.set("mock-1", {
    state: ROUTING_STATES.TUN_ERROR, usbIp: "192.168.2.10", proxyId: proxy.id, protected: false,
  });
  tunManager.stop = async () => { throw new Error("stale tunnel could not be stopped"); };

  await assert.rejects(
    () => orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }),
    /stale tunnel could not be stopped/,
  );

  const route = orchestrator.getRoute("mock-1");
  assert.equal(route.state, ROUTING_STATES.TUN_ERROR);
  assert.equal(route.latestError.code, "T202");
  assert.equal(route.protected, false);
  assert.equal(route.internetBlocked, true, "the existing USB path is blocked when PF remains available");
  assert.doesNotMatch(JSON.stringify(route), /stale tunnel could not be stopped/);
});

test("a PF syntax failure ends in pf_syntax_error, the ruleset is never loaded, and the tunnel is torn down", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({
    proxyPoolStorePath: storePath, testResult: { ok: false, error: "syntax error in rule" },
  });

  await assert.rejects(() => orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }), /PF syntax check failed/);
  assert.equal(orchestrator.getRoute("mock-1").state, ROUTING_STATES.PF_SYNTAX_ERROR);
  assert.equal(privilegedOps.loadCalls.length, 0, "an unsyntactic ruleset must never be loaded");
  assert.equal(tunManager.stops.includes("mock-1"), true);
});

test("a failure after PF is loaded rolls back the device rule before stopping its tunnel", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });
  privilegedOps.clearState = async ip => {
    privilegedOps.clearStateCalls.push(ip);
    throw new Error("state table unavailable");
  };

  await assert.rejects(
    () => orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }),
    /state table unavailable/,
  );

  assert.equal(tunManager.isRunning("mock-1"), false);
  assert.equal(privilegedOps.loadCalls.length, 2, "the routed rule is replaced by a fail-closed block after the late failure");
  assert.match(privilegedOps.loadCalls[0], /route-to .*192\.168\.2\.10/);
  assert.match(privilegedOps.loadCalls[1], /block in quick on bridge0 inet from 192\.168\.2\.10 to any/);
  assert.equal(privilegedOps.clearAnchorCalls, 1, "the installed rule must be removed during rollback");
  assert.equal(orchestrator.getRoute("mock-1").state, ROUTING_STATES.TUN_ERROR);
});

test("a second device routing regenerates the FULL ruleset including the first (full-replace, not append)", async () => {
  const storePath = tempStorePath();
  const proxyA = createProxy(storePath, samplePayload({ label: "A" }), MASTER_KEY);
  const proxyB = createProxy(storePath, samplePayload({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxyA.id });
  assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxyB.id });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });

  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  await orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" });

  const lastRuleset = privilegedOps.loadCalls[privilegedOps.loadCalls.length - 1];
  assert.match(lastRuleset, /192\.168\.2\.10/);
  assert.match(lastRuleset, /192\.168\.2\.11/);
});

test("stopRouting regenerates the ruleset for the remaining devices and clears the stopped device's state", async () => {
  const storePath = tempStorePath();
  const proxyA = createProxy(storePath, samplePayload({ label: "A" }), MASTER_KEY);
  const proxyB = createProxy(storePath, samplePayload({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxyA.id });
  assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxyB.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  await orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" });

  await orchestrator.stopRouting("mock-1");

  assert.equal(tunManager.stops.includes("mock-1"), true);
  const lastRuleset = privilegedOps.loadCalls[privilegedOps.loadCalls.length - 1];
  assert.equal(lastRuleset.includes("192.168.2.10"), false);
  assert.match(lastRuleset, /192\.168\.2\.11/);
  assert.equal(privilegedOps.clearStateCalls[privilegedOps.clearStateCalls.length - 1], "192.168.2.10");
  assert.equal(orchestrator.getRoute("mock-1"), null);
});

test("stopRouting the LAST routed device clears the whole anchor instead of loading an empty ruleset", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });

  await orchestrator.stopRouting("mock-1");

  assert.equal(privilegedOps.clearAnchorCalls, 1);
});

test("a failed PF cleanup keeps teardown retryable instead of forgetting the stale route", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });

  privilegedOps.clearAnchor = async () => {
    privilegedOps.clearAnchorCalls += 1;
    throw new Error("pfctl unavailable");
  };

  await assert.rejects(() => orchestrator.stopRouting("mock-1"), /pfctl unavailable/);
  assert.equal(tunManager.isRunning("mock-1"), false);
  assert.equal(orchestrator.getRoute("mock-1").state, ROUTING_STATES.STOP_ERROR);
  assert.equal(orchestrator.getRoute("mock-1").lastError, "PF rules could not be loaded");
  assert.equal(orchestrator.getRoute("mock-1").latestError.code, "F202");
  assert.doesNotMatch(JSON.stringify(orchestrator.getRoute("mock-1")), /pfctl unavailable/);

  privilegedOps.clearAnchor = async () => {
    privilegedOps.clearAnchorCalls += 1;
    return { ok: true };
  };
  await orchestrator.stopRouting("mock-1");

  assert.equal(orchestrator.getRoute("mock-1"), null);
  assert.equal(privilegedOps.clearAnchorCalls, 2);
});

test("stopRouting a device with no active route is a harmless no-op", async () => {
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: tempStorePath() });
  await orchestrator.stopRouting("never-started");
  assert.equal(tunManager.stops.includes("never-started"), true); // stop() is still called defensively
  assert.equal(privilegedOps.clearAnchorCalls, 0);
  assert.equal(privilegedOps.clearStateCalls.length, 0);
});

test("retrying after a failed attempt reuses the same tunIface, since the failed tunnel was already stopped", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  let attempt = 0;
  const { orchestrator, tunManager } = makeOrchestrator({
    proxyPoolStorePath: storePath,
    peerResult: { localIp: "10.0.0.2", peerIp: "10.0.0.1" },
  });
  // Override: every internal retry within the FIRST startRouting() call
  // fails (there are up to PEER_DISCOVERY_ATTEMPTS of them), then the next
  // startRouting() call succeeds on its first attempt — exercises the same
  // startRouting() path both times, unlike two separate orchestrators.
  orchestrator.discoverTunPeer = async () => {
    attempt += 1;
    if (attempt <= 5) throw new Error("interface not up");
    return { localIp: "10.0.0.2", peerIp: "10.0.0.1" };
  };

  await assert.rejects(() => orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }));
  assert.equal(tunManager.starts[0].tunIface, "utun0");
  assert.equal(tunManager.activeIfaces.has("utun0"), false, "the failed attempt's interface must be freed");

  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  assert.equal(tunManager.starts[1].tunIface, "utun0");
});

function inspectFor(usbIp, packets) {
  return [
    `@1 pass in quick on bridge0 route-to (utun0 10.0.0.1) inet proto tcp from ${usbIp} to any flags S/SA keep state`,
    `  [ Evaluations: 9        Packets: ${packets}         Bytes: 1024          States: 1     ]`,
  ].join("\n");
}

test("checkHealth is a no-op when nothing is routed", async () => {
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: tempStorePath() });
  await orchestrator.checkHealth();
  assert.equal(privilegedOps.inspectCalls, 0);
});

test("checkHealth records the PF packet counter on an otherwise-healthy routed device", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator } = makeOrchestrator({ proxyPoolStorePath: storePath, inspectOutput: inspectFor("192.168.2.10", 42) });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });

  await orchestrator.checkHealth();

  const route = orchestrator.getRoute("mock-1");
  assert.equal(route.state, ROUTING_STATES.ROUTED);
  assert.equal(route.lastPackets, 42);
  assert.ok(route.lastHealthCheckAt);
});

test("current-route proof requires the live tunnel, its PF rule and an active bridge", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({
    proxyPoolStorePath: storePath, inspectOutput: inspectFor("192.168.2.10", 1),
  });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  tunManager.hasCurrentOwnership = async () => true;
  assert.equal(await orchestrator.verifyCurrentRoute("mock-1"), true);
  tunManager.hasCurrentOwnership = async () => false;
  assert.equal(await orchestrator.verifyCurrentRoute("mock-1"), false);
  tunManager.hasCurrentOwnership = async () => true;
  privilegedOps.inspectBridge = async () => ({ available: true, up: false });
  assert.equal(await orchestrator.verifyCurrentRoute("mock-1"), false);
});

test("checkHealth marks a device route_lost when its tunnel process has died outside of stopRouting", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath, inspectOutput: inspectFor("192.168.2.10", 1) });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  tunManager.simulateCrash("mock-1");

  await orchestrator.checkHealth();

  const route = orchestrator.getRoute("mock-1");
  assert.equal(route.state, ROUTING_STATES.ROUTE_LOST);
  assert.equal(route.latestError.code, "T206");
  assert.equal(route.internetBlocked, true);
});

test("route loss with a PF block failure stops forwarding and requires explicit host recovery", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const timers = [];
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({
    proxyPoolStorePath: storePath,
    inspectOutput: inspectFor("192.168.2.10", 1),
    recoveryDelayMs: 0,
    setTimeoutFn: fn => { timers.push(fn); return { unref() {} }; },
    clearTimeoutFn() {},
  });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  tunManager.simulateCrash("mock-1");
  privilegedOps.loadRuleset = async text => {
    privilegedOps.loadCalls.push(text);
    if (/block in quick/.test(text)) throw new Error("pfctl unavailable");
    return { ok: true };
  };

  await orchestrator.checkHealth();

  let route = orchestrator.getRoute("mock-1");
  assert.equal(route.state, ROUTING_STATES.ROUTE_LOST);
  assert.equal(route.routeFailure.code, "T206", "the original route-loss cause remains available");
  assert.equal(route.protectionError.code, "F202");
  assert.equal(route.protectionState, "bridge_quarantined");
  assert.equal(route.internetBlocked, true, "verified bridge shutdown is an emergency block, not proxy protection");
  assert.equal(route.deviceQuarantined, true);
  assert.equal(route.manualInterventionRequired, true);
  assert.deepEqual(privilegedOps.quarantineCalls, ["bridge0"]);
  assert.equal(route.protected, false);
  assert.equal(tunManager.isRunning("mock-1"), false, "the forwarding tunnel is shut down; direct-route blocking still needs PF proof");
  assert.equal(timers.length, 0, "host quarantine must cancel automatic protection and routing retries");
  assert.equal(orchestrator.getHostRoutingStatus().state, "quarantined");
});

test("shared-bridge quarantine stops and marks every routed phone, not only the trigger", async () => {
  const storePath = tempStorePath();
  const proxyA = createProxy(storePath, samplePayload({ label: "A" }), MASTER_KEY);
  const proxyB = createProxy(storePath, samplePayload({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxyA.id });
  assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxyB.id });
  const timers = [];
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({
    proxyPoolStorePath: storePath,
    inspectOutput: [inspectFor("192.168.2.10", 1), inspectFor("192.168.2.11", 1)].join("\n"),
    recoveryDelayMs: 0,
    setTimeoutFn: fn => { timers.push(fn); return { unref() {} }; },
    clearTimeoutFn() {},
  });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  await orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" });
  tunManager.simulateCrash("mock-1");
  privilegedOps.loadRuleset = async text => {
    if (/block in quick/.test(text)) throw new Error("pfctl unavailable");
    return { ok: true };
  };

  await orchestrator.checkHealth();

  for (const deviceId of ["mock-1", "mock-2"]) {
    const route = orchestrator.getRoute(deviceId);
    assert.equal(route.state, ROUTING_STATES.ROUTE_LOST);
    assert.equal(route.protectionState, "bridge_quarantined");
    assert.equal(route.protected, false);
    assert.equal(route.manualInterventionRequired, true);
    assert.equal(tunManager.isRunning(deviceId), false);
  }
  assert.equal(orchestrator.getRoute("mock-2").latestError.code, "F209");
  assert.deepEqual(privilegedOps.quarantineCalls, ["bridge0"]);

  const startsBeforeRefusal = tunManager.starts.length;
  await assert.rejects(
    () => orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" }),
    error => error.code === "ROUTING_HOST_QUARANTINED" && error.status === 409,
  );
  assert.equal(tunManager.starts.length, startsBeforeRefusal, "quarantine cannot be bypassed by another start request");
});

test("emergency quarantine stops a supervisor-managed tunnel absent from routes and persists the complete inventory", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  orchestrator.routes.set("trigger", { state: ROUTING_STATES.ROUTE_LOST, usbIp: "192.168.2.10" });
  tunManager.runningDeviceIds.add("orphan-managed");

  await orchestrator._enforceEmergencyQuarantine("trigger", new Error("pf failed"));

  assert.equal(tunManager.stops.includes("orphan-managed"), true);
  const persisted = JSON.parse(fs.readFileSync(quarantineStorePath, "utf8"));
  assert.deepEqual(new Set(persisted.affectedDeviceIds), new Set(["trigger", "orphan-managed"]));
  assert.equal(persisted.affectedDeviceInventoryComplete, true);
  assert.equal(persisted.state, "quarantined");
});

test("an invalid managed-tunnel inventory forces recovery-required and cannot publish quarantine complete", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  orchestrator.routes.set("trigger", { state: ROUTING_STATES.ROUTE_LOST, usbIp: "192.168.2.10" });
  tunManager.listManagedDeviceIds = () => ({ invalid: true });

  await orchestrator._enforceEmergencyQuarantine("trigger", new Error("pf failed"));

  const persisted = JSON.parse(fs.readFileSync(quarantineStorePath, "utf8"));
  assert.equal(persisted.affectedDeviceInventoryComplete, false);
  assert.equal(persisted.state, "recovery_required");
  await assert.rejects(orchestrator.recoverHostRouting(), /complete affected-device inventory/);
});

test("a persisted-only tunnel that remains managed after stop keeps emergency quarantine in recovery-required", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  orchestrator.routes.set("trigger", { state: ROUTING_STATES.ROUTE_LOST, usbIp: "192.168.2.10" });
  tunManager.runningDeviceIds.add("persisted-only");
  tunManager.stop = deviceId => { tunManager.stops.push(deviceId); };

  await orchestrator._enforceEmergencyQuarantine("trigger", new Error("pf failed"));

  assert.equal(tunManager.stops.includes("persisted-only"), true);
  const persisted = JSON.parse(fs.readFileSync(quarantineStorePath, "utf8"));
  assert.equal(persisted.state, "recovery_required");
  assert.equal(persisted.reasonCode, "T202");
});

test("a concurrent device cannot start while shared-bridge quarantine is awaiting shutdown", async () => {
  const storePath = tempStorePath();
  const proxyA = createProxy(storePath, samplePayload({ label: "A" }), MASTER_KEY);
  const proxyB = createProxy(storePath, samplePayload({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxyA.id });
  assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxyB.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({
    proxyPoolStorePath: storePath, inspectOutput: inspectFor("192.168.2.10", 1),
  });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  tunManager.simulateCrash("mock-1");
  privilegedOps.loadRuleset = async text => {
    if (/block in quick/.test(text)) throw new Error("sensitive pf failure");
    return { ok: true };
  };
  let releaseBridge;
  let quarantineStarted;
  const started = new Promise(resolve => { quarantineStarted = resolve; });
  privilegedOps.quarantineBridge = async iface => {
    privilegedOps.quarantineCalls.push(iface);
    quarantineStarted();
    await new Promise(resolve => { releaseBridge = resolve; });
    return { ok: true };
  };

  const health = orchestrator.checkHealth();
  await started;
  const startsBefore = tunManager.starts.length;
  const loadsBefore = privilegedOps.loadCalls.length;
  await assert.rejects(
    () => orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" }),
    error => error.code === "ROUTING_HOST_QUARANTINED" && !String(error.message).includes("sensitive"),
  );
  assert.equal(tunManager.starts.length, startsBefore);
  assert.equal(privilegedOps.loadCalls.length, loadsBefore, "the blocked phone must not load another PF ruleset");
  releaseBridge();
  await health;
});

test("bridge shutdown failure persists recovery-required state and blocks starts after restart", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  const proxyA = createProxy(storePath, samplePayload({ label: "A" }), MASTER_KEY);
  const proxyB = createProxy(storePath, samplePayload({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxyA.id });
  assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxyB.id });
  const first = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath,
    inspectOutput: inspectFor("192.168.2.10", 1) });
  await first.orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  first.tunManager.simulateCrash("mock-1");
  first.privilegedOps.loadRuleset = async text => {
    if (/block in quick/.test(text)) throw new Error("pf unavailable: credential=secret");
    return { ok: true };
  };
  first.privilegedOps.quarantineBridge = async () => { throw new Error("ifconfig raw stderr /private/path"); };
  await first.orchestrator.checkHealth();
  assert.equal(first.orchestrator.getHostRoutingStatus().state, "recovery_required");
  const raw = fs.readFileSync(quarantineStorePath, "utf8");
  assert.doesNotMatch(raw, /credential|secret|private\/path|pf unavailable/i);

  const second = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  assert.equal(second.orchestrator.getHostRoutingStatus().state, "recovery_required");
  await assert.rejects(
    () => second.orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" }),
    error => error.code === "ROUTING_RECOVERY_REQUIRED",
  );
  assert.equal(second.tunManager.starts.length, 0);
});

test("quarantine preserves the triggering failure and records route cleanup failures separately", async () => {
  const storePath = tempStorePath();
  const proxyA = createProxy(storePath, samplePayload({ label: "A" }), MASTER_KEY);
  const proxyB = createProxy(storePath, samplePayload({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxyA.id });
  assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxyB.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({
    proxyPoolStorePath: storePath,
    inspectOutput: [inspectFor("192.168.2.10", 1), inspectFor("192.168.2.11", 1)].join("\n"),
  });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  await orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" });
  tunManager.simulateCrash("mock-1");
  const originalStop = tunManager.stop.bind(tunManager);
  tunManager.stop = async deviceId => {
    if (deviceId === "mock-2") throw new Error("private cleanup stderr secret=1");
    return originalStop(deviceId);
  };
  privilegedOps.loadRuleset = async text => {
    if (/block in quick/.test(text)) throw new Error("primary pf failure");
    return { ok: true };
  };
  await orchestrator.checkHealth();
  assert.equal(orchestrator.getRoute("mock-1").routeFailure.code, "T206");
  assert.equal(orchestrator.getRoute("mock-2").cleanupError.code, "T202");
  assert.doesNotMatch(JSON.stringify(orchestrator.getRoute("mock-2").cleanupError), /secret|private cleanup/i);
  assert.equal(orchestrator.getHostRoutingStatus().state, "recovery_required");
});

test("corrupt persisted quarantine fails closed", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  fs.writeFileSync(quarantineStorePath, "{not-json", { mode: 0o600 });
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  assert.equal(orchestrator.getHostRoutingStatus().state, "recovery_required");
  await assert.rejects(() => orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" }),
    error => error.code === "ROUTING_RECOVERY_REQUIRED");
  assert.equal(tunManager.starts.length, 0);
});

test("explicit recovery refuses an unsafe bridge, then clears quarantine idempotently after checks pass", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  fs.writeFileSync(quarantineStorePath, `${JSON.stringify({
    version: 1, state: "quarantined", bridgeIface: "bridge0", reasonCode: "F202",
    timestamp: new Date().toISOString(), manualInterventionRequired: true, affectedDeviceIds: ["mock-1"],
    affectedDeviceInventoryComplete: true,
  })}\n`, { mode: 0o600 });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  privilegedOps.inspectBridge = async () => ({ available: true, up: false });
  await assert.rejects(() => orchestrator.recoverHostRouting(), error => error.code === "ROUTING_BRIDGE_UNAVAILABLE");
  assert.equal(fs.existsSync(quarantineStorePath), true);

  privilegedOps.inspectBridge = async () => ({ available: true, up: true });
  const recovered = await orchestrator.recoverHostRouting();
  assert.equal(recovered.state, "healthy");
  assert.equal(fs.existsSync(quarantineStorePath), false);
  assert.equal((await orchestrator.recoverHostRouting()).state, "healthy");
});

test("revoked recovery authorization cannot clear the durable host barrier", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  fs.writeFileSync(quarantineStorePath, `${JSON.stringify({
    version: 1, state: "quarantined", bridgeIface: "bridge0", reasonCode: "F202",
    timestamp: new Date().toISOString(), manualInterventionRequired: true, affectedDeviceIds: ["mock-1"],
    affectedDeviceInventoryComplete: true,
  })}\n`, { mode: 0o600 });
  const { orchestrator } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  let checks = 0;
  await assert.rejects(() => orchestrator.recoverHostRouting({
    authorize: async () => {
      checks += 1;
      if (checks >= 3) { const error = new Error("revoked"); error.status = 403; throw error; }
    },
  }), /revoked/);
  assert.equal(fs.existsSync(quarantineStorePath), true);
  assert.equal(orchestrator.getHostRoutingStatus().state, "quarantined");
});

test("recovery is rejected while emergency quarantine is still running and durable state stays deterministic", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  orchestrator.routes.set("mock-1", { state: ROUTING_STATES.ROUTE_LOST, usbIp: "192.168.2.10" });
  let releaseBridge;
  privilegedOps.quarantineBridge = () => new Promise(resolve => { releaseBridge = resolve; });
  const quarantine = orchestrator._enforceEmergencyQuarantine("mock-1", new Error("pf failed"));
  assert.equal(orchestrator.getHostRoutingStatus().state, "quarantining");
  await assert.rejects(() => orchestrator.recoverHostRouting(), error => error.code === "ROUTING_QUARANTINE_IN_PROGRESS");
  assert.equal(orchestrator.getHostRoutingStatus().state, "quarantining");
  releaseBridge({ ok: true });
  await quarantine;
  assert.equal(orchestrator.getHostRoutingStatus().state, "quarantined");
  assert.equal(JSON.parse(fs.readFileSync(quarantineStorePath, "utf8")).state, "quarantined");
});

test("emergency quarantine waits for an in-flight host setup before shutting down the shared bridge", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  orchestrator.routes.set("mock-1", { state: ROUTING_STATES.ROUTE_LOST, usbIp: "192.168.2.10" });
  let releaseSetup;
  const setup = orchestrator.runHostRoutingSetup(() => new Promise(resolve => { releaseSetup = resolve; }));
  const setupRejected = assert.rejects(setup, error => error.code === "ROUTING_HOST_QUARANTINED");
  await Promise.resolve();
  const quarantine = orchestrator._enforceEmergencyQuarantine("mock-1", new Error("pf failed"));
  assert.equal(orchestrator.getHostRoutingStatus().state, "quarantining");
  assert.equal(privilegedOps.quarantineCalls.length, 0);
  releaseSetup({ ok: true });
  await setupRejected;
  await quarantine;
  assert.deepEqual(privilegedOps.quarantineCalls, ["bridge0"]);
  assert.equal(orchestrator.getHostRoutingStatus().state, "quarantined");
});

test("concurrent recovery calls perform only one destructive recovery sequence", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  fs.writeFileSync(quarantineStorePath, `${JSON.stringify({
    version: 1, state: "quarantined", bridgeIface: "bridge0", reasonCode: "F202",
    timestamp: new Date().toISOString(), manualInterventionRequired: true, affectedDeviceIds: ["mock-1"],
    affectedDeviceInventoryComplete: true,
  })}\n`, { mode: 0o600 });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  let releaseClear;
  let clearCalls = 0;
  privilegedOps.clearAnchor = () => { clearCalls += 1; return new Promise(resolve => { releaseClear = resolve; }); };
  const first = orchestrator.recoverHostRouting();
  await Promise.resolve();
  await assert.rejects(() => orchestrator.recoverHostRouting(), error => error.code === "ROUTING_RECOVERY_IN_PROGRESS");
  assert.equal(clearCalls, 1);
  releaseClear({ ok: true });
  assert.equal((await first).state, "healthy");
});

test("recovery stops persisted and newly enumerated managed tunnels before clearing quarantine", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  fs.writeFileSync(quarantineStorePath, `${JSON.stringify({
    version: 1, state: "quarantined", bridgeIface: "bridge0", reasonCode: "F202",
    timestamp: new Date().toISOString(), manualInterventionRequired: true,
    affectedDeviceIds: ["mock-1"], affectedDeviceInventoryComplete: true,
  })}\n`, { mode: 0o600 });
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  tunManager.runningDeviceIds.add("synthetic-managed-device");
  const recovered = await orchestrator.recoverHostRouting();
  assert.equal(recovered.operationInProgress, false);
  assert.deepEqual(tunManager.stops.sort(), ["mock-1", "synthetic-managed-device"]);
});

test("a resolved stop failure keeps recovery blocked and does not clear firewall state", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  fs.writeFileSync(quarantineStorePath, `${JSON.stringify({
    version: 1, state: "quarantined", bridgeIface: "bridge0", reasonCode: "F202",
    timestamp: new Date().toISOString(), manualInterventionRequired: true,
    affectedDeviceIds: ["mock-1"], affectedDeviceInventoryComplete: true,
  })}\n`, { mode: 0o600 });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  tunManager.stop = () => ({ ok: false, error: "private process detail" });
  tunManager.getStatus = () => ({ state: "stop_failed" });
  await assert.rejects(() => orchestrator.recoverHostRouting(), error =>
    error.code === "ROUTING_RECOVERY_UNSAFE" && !error.message.includes("private process detail"));
  assert.equal(privilegedOps.clearAnchorCalls, 0);
  assert.equal(orchestrator.getHostRoutingStatus().state, "quarantined");
  assert.equal(fs.existsSync(quarantineStorePath), true);
});

test("a resolved stop failure forces emergency quarantine into recovery-required", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  const { orchestrator, tunManager } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  orchestrator.routes.set("mock-1", { state: ROUTING_STATES.ROUTE_LOST, usbIp: "192.168.2.10" });
  tunManager.stop = () => ({ ok: false, error: "unconfirmed" });
  tunManager.getStatus = () => ({ state: "stop_failed" });
  await orchestrator._enforceEmergencyQuarantine("mock-1", new Error("pf failed"));
  assert.equal(orchestrator.getHostRoutingStatus().state, "recovery_required");
  assert.equal(orchestrator.getHostRoutingStatus().reasonCode, "T202");
  assert.equal(JSON.parse(fs.readFileSync(quarantineStorePath, "utf8")).state, "recovery_required");
});

test("a malformed failure marker cannot be repaired into a guessed recoverable inventory", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  fs.writeFileSync(`${quarantineStorePath}.failure`, "{broken-marker", { mode: 0o600 });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  await assert.rejects(
    () => orchestrator.repairHostRoutingState({ confirmed: true, authorize: async () => {} }),
    error => error.code === "ROUTING_RECOVERY_UNSAFE",
  );
  assert.equal(privilegedOps.clearAnchorCalls, 0);
  assert.equal(fs.readFileSync(`${quarantineStorePath}.failure`, "utf8"), "{broken-marker");
});

test("initial quarantine persistence failure remains blocked after restart", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  fs.mkdirSync(quarantineStorePath);
  const first = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  first.orchestrator.routes.set("mock-1", { state: ROUTING_STATES.ROUTE_LOST, usbIp: "192.168.2.10" });
  await first.orchestrator._enforceEmergencyQuarantine("mock-1", new Error("pf failed"));
  assert.equal(first.orchestrator.getHostRoutingStatus().state, "recovery_required");
  await assert.rejects(() => first.orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" }),
    error => error.code === "ROUTING_RECOVERY_REQUIRED");
  assert.equal(first.tunManager.starts.length, 0);
  const second = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  assert.equal(second.orchestrator.getHostRoutingStatus().state, "recovery_required");
});

test("final quarantine persistence failure remains blocked after restart without temporary leakage", async () => {
  const storePath = tempStorePath();
  const root = path.dirname(storePath);
  const quarantineStorePath = path.join(root, "routing-quarantine.json");
  const first = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  first.orchestrator.routes.set("mock-1", { state: ROUTING_STATES.ROUTE_LOST, usbIp: "192.168.2.10" });
  let releaseBridge;
  first.privilegedOps.quarantineBridge = () => new Promise(resolve => { releaseBridge = resolve; });
  const quarantine = first.orchestrator._enforceEmergencyQuarantine("mock-1", new Error("pf failed secret=hidden"));
  fs.rmSync(quarantineStorePath);
  fs.mkdirSync(quarantineStorePath);
  releaseBridge({ ok: true });
  await quarantine;
  assert.equal(first.orchestrator.getHostRoutingStatus().state, "recovery_required");
  const second = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  assert.equal(second.orchestrator.getHostRoutingStatus().state, "recovery_required");
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith(".tmp")), []);
  assert.doesNotMatch(JSON.stringify(second.orchestrator.getHostRoutingStatus()), /secret|hidden/i);
});

test("explicit malformed-state repair preserves evidence and requires confirmation and live authorization", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  const original = "{broken-state";
  fs.writeFileSync(quarantineStorePath, original, { mode: 0o600 });
  const { orchestrator } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  assert.equal(orchestrator.getHostRoutingStatus().repairRequired, true);
  await assert.rejects(() => orchestrator.repairHostRoutingState(),
    error => error.code === "ROUTING_REPAIR_CONFIRMATION_REQUIRED");
  assert.equal(fs.readFileSync(quarantineStorePath, "utf8"), original);

  let checks = 0;
  await assert.rejects(() => orchestrator.repairHostRoutingState({
    confirmed: true,
    authorize: async () => { checks += 1; if (checks >= 3) throw Object.assign(new Error("revoked"), { status: 403 }); },
  }), /revoked/);
  assert.equal(fs.readFileSync(quarantineStorePath, "utf8"), original);

  const repaired = await orchestrator.repairHostRoutingState({ confirmed: true, authorize: async () => {} });
  assert.equal(repaired.state, "recovery_required");
  assert.equal(repaired.originalPreserved, true);
  assert.equal(repaired.operationInProgress, false);
  const backup = fs.readdirSync(path.dirname(quarantineStorePath)).find(name => name.includes(".invalid-") && name.endsWith(".bak"));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(path.dirname(quarantineStorePath), backup), "utf8"), original);
  assert.doesNotMatch(JSON.stringify(repaired), /broken-state|routing-quarantine|[A-Z]:\\/i);
});

test("a resolved stop failure prevents malformed-state repair from touching PF or evidence", async () => {
  const storePath = tempStorePath();
  const quarantineStorePath = path.join(path.dirname(storePath), "routing-quarantine.json");
  const original = "{broken-state";
  fs.writeFileSync(quarantineStorePath, original, { mode: 0o600 });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, quarantineStorePath });
  tunManager.listManagedDeviceIds = () => ["mock-1"];
  tunManager.stop = () => ({ ok: false, error: "private process output" });
  tunManager.getStatus = () => ({ state: "stop_failed" });
  await assert.rejects(
    () => orchestrator.repairHostRoutingState({ confirmed: true, authorize: async () => {} }),
    error => error.code === "ROUTING_RECOVERY_UNSAFE" && !error.message.includes("private process output"),
  );
  assert.equal(privilegedOps.clearAnchorCalls, 0);
  assert.equal(fs.readFileSync(quarantineStorePath, "utf8"), original);
});

test("checkHealth marks a device route_lost when its PF rule has vanished from the anchor", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  // inspectOutput deliberately has no rule for 192.168.2.10 — as if the
  // anchor were flushed externally without going through stopRouting().
  const { orchestrator } = makeOrchestrator({ proxyPoolStorePath: storePath, inspectOutput: inspectFor("192.168.2.99", 1) });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });

  await orchestrator.checkHealth();

  const route = orchestrator.getRoute("mock-1");
  assert.equal(route.state, ROUTING_STATES.ROUTE_LOST);
  assert.equal(route.latestError.code, "F203");
  assert.equal(route.internetBlocked, true);
});

test("route loss blocks and rebuilds only the affected phone", async () => {
  const storePath = tempStorePath();
  const proxyA = createProxy(storePath, samplePayload({ label: "A" }), MASTER_KEY);
  const proxyB = createProxy(storePath, samplePayload({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxyA.id });
  assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxyB.id });
  const timers = [];
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({
    proxyPoolStorePath: storePath,
    inspectOutput: [inspectFor("192.168.2.10", 1), inspectFor("192.168.2.11", 1)].join("\n"),
    recoveryDelayMs: 0,
    setTimeoutFn: fn => { timers.push(fn); return { unref() {} }; },
    clearTimeoutFn() {},
  });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  await orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" });
  tunManager.simulateCrash("mock-1");

  await orchestrator.checkHealth();

  assert.equal(orchestrator.getRoute("mock-1").state, ROUTING_STATES.ROUTE_LOST);
  assert.equal(orchestrator.getRoute("mock-1").internetBlocked, true);
  assert.equal(orchestrator.getRoute("mock-2").state, ROUTING_STATES.ROUTED);
  const blockedRules = privilegedOps.loadCalls.at(-1);
  assert.match(blockedRules, /block in quick on bridge0 inet from 192\.168\.2\.10 to any/);
  assert.match(blockedRules, /route-to .*from 192\.168\.2\.11/);
  assert.equal(timers.length, 1);

  await timers.shift()();

  assert.equal(orchestrator.getRoute("mock-1").state, ROUTING_STATES.ROUTED);
  assert.equal(orchestrator.getRoute("mock-2").state, ROUTING_STATES.ROUTED);
  assert.equal(tunManager.starts.filter(start => start.deviceId === "mock-1").length, 2);
  assert.equal(tunManager.starts.filter(start => start.deviceId === "mock-2").length, 1);
  assert.equal(privilegedOps.loadCalls.at(-1).includes("block in quick on bridge0 inet from 192.168.2.10"), false);
});

test("route recovery stops after the bounded retry budget and remains fail-closed", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const timers = [];
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({
    proxyPoolStorePath: storePath,
    inspectOutput: inspectFor("192.168.2.10", 1),
    recoveryDelayMs: 0,
    setTimeoutFn: fn => { timers.push(fn); return { unref() {} }; },
    clearTimeoutFn() {},
  });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  tunManager.simulateCrash("mock-1");
  await orchestrator.checkHealth();
  privilegedOps.loadRuleset = async text => {
    privilegedOps.loadCalls.push(text);
    if (text.includes("route-to")) throw new Error("simulated route load failure");
    return { ok: true };
  };

  await timers.shift()();
  assert.equal(timers.length, 1, "the first failed recovery schedules the final attempt");
  await timers.shift()();

  const route = orchestrator.getRoute("mock-1");
  assert.equal(route.state, ROUTING_STATES.ROUTE_LOST);
  assert.equal(route.recoveryAttempts, 2);
  assert.equal(route.internetBlocked, true);
  assert.equal(route.protected, false);
  assert.equal(timers.length, 0, "no restart loop continues after the bounded attempts");
  assert.match(privilegedOps.loadCalls.at(-1), /block in quick on bridge0 inet from 192\.168\.2\.10 to any/);
});

test("an end-to-end verification mismatch quarantines only that phone and stops its tunnel", async () => {
  const storePath = tempStorePath();
  const proxyA = createProxy(storePath, samplePayload({ label: "A" }), MASTER_KEY);
  const proxyB = createProxy(storePath, samplePayload({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxyA.id });
  assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxyB.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  await orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" });

  await orchestrator.quarantineRoute("mock-1", { code: "V202", why: "Unexpected exit IP" });

  const quarantined = orchestrator.getRoute("mock-1");
  assert.equal(quarantined.state, ROUTING_STATES.ROUTE_LOST);
  assert.equal(quarantined.latestError.code, "V202");
  assert.equal(quarantined.internetBlocked, true);
  assert.equal(tunManager.isRunning("mock-1"), false);
  assert.equal(orchestrator.getRoute("mock-2").state, ROUTING_STATES.ROUTED);
  assert.equal(tunManager.isRunning("mock-2"), true);
  assert.match(privilegedOps.loadCalls.at(-1), /block in quick on bridge0 inet from 192\.168\.2\.10 to any/);
  assert.match(privilegedOps.loadCalls.at(-1), /route-to .*from 192\.168\.2\.11/);
});

test("verification quarantine stops the tunnel even when the fail-closed PF reload fails", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, tunManager, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  privilegedOps.loadRuleset = async () => { throw new Error("pfctl unavailable"); };

  await orchestrator.quarantineRoute("mock-1");

  assert.equal(tunManager.isRunning("mock-1"), false);
  assert.equal(orchestrator.getRoute("mock-1").protected, false);
  assert.equal(orchestrator.getRoute("mock-1").protectionState, "bridge_quarantined");
  assert.deepEqual(privilegedOps.quarantineCalls, ["bridge0"]);
});

test("checkHealth fails closed when PF rules cannot be inspected", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  privilegedOps.inspectOutput = new Error("sudo timeout");

  await orchestrator.checkHealth();

  const route = orchestrator.getRoute("mock-1");
  assert.equal(route.state, ROUTING_STATES.ROUTE_LOST);
  assert.equal(route.latestError.code, "F203");
  assert.equal(route.internetBlocked, true);
});

test("checkHealth only ever inspects PF once per tick, even with multiple routed devices", async () => {
  const storePath = tempStorePath();
  const proxyA = createProxy(storePath, samplePayload({ label: "A" }), MASTER_KEY);
  const proxyB = createProxy(storePath, samplePayload({ label: "B" }), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxyA.id });
  assignProxyToDevice(storePath, { deviceId: "mock-2", proxyId: proxyB.id });
  const inspectOutput = [inspectFor("192.168.2.10", 5), inspectFor("192.168.2.11", 9)].join("\n");
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, inspectOutput });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  await orchestrator.startRouting("mock-2", { usbIp: "192.168.2.11" });

  const beforeHealth = privilegedOps.inspectCalls;
  await orchestrator.checkHealth();

  assert.equal(privilegedOps.inspectCalls, beforeHealth + 1);
  assert.equal(orchestrator.getRoute("mock-1").lastPackets, 5);
  assert.equal(orchestrator.getRoute("mock-2").lastPackets, 9);
});

test("startHealthChecks runs an immediate check and then on the configured interval; stopHealthChecks ends it", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, inspectOutput: inspectFor("192.168.2.10", 1) });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });

  const beforeHealth = privilegedOps.inspectCalls;
  orchestrator.startHealthChecks({ intervalMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 5)); // let the immediate check land
  assert.equal(privilegedOps.inspectCalls, beforeHealth + 1);

  await new Promise(resolve => setTimeout(resolve, 45));
  assert.ok(privilegedOps.inspectCalls >= 2, "expected at least one interval tick beyond the immediate check");

  orchestrator.stopHealthChecks();
  const callsAtStop = privilegedOps.inspectCalls;
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(privilegedOps.inspectCalls, callsAtStop, "no further ticks after stopHealthChecks()");
});

test("startHealthChecks is idempotent — calling it twice does not double the interval", async () => {
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: tempStorePath(), inspectOutput: "" });
  orchestrator.startHealthChecks({ intervalMs: 20 });
  orchestrator.startHealthChecks({ intervalMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 5));
  const callsAfterStart = privilegedOps.inspectCalls;
  orchestrator.stopHealthChecks();
  assert.equal(callsAfterStart, 0); // nothing routed yet — checkHealth() no-ops before ever calling inspectRules
});

test("a health check that interleaves with a deliberate stopRouting() never resurrects the route as route_lost", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator } = makeOrchestrator({ proxyPoolStorePath: storePath, inspectOutput: inspectFor("192.168.2.10", 1) });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });

  // Both start synchronously in the same tick — stopRouting() must delete
  // the route before its first await so checkHealth()'s per-device loop
  // (which reads state fresh via this.routes.get) never observes this
  // device as still ROUTED-but-dead partway through a deliberate stop.
  await Promise.all([orchestrator.stopRouting("mock-1"), orchestrator.checkHealth()]);

  assert.equal(orchestrator.getRoute("mock-1"), null);
});
