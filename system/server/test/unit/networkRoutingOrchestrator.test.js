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
  constructor({ testResult = { ok: true }, inspectOutput = "" } = {}) {
    this.testResult = testResult;
    this.inspectOutput = inspectOutput;
    this.testCalls = [];
    this.loadCalls = [];
    this.clearStateCalls = [];
    this.clearAnchorCalls = 0;
    this.inspectCalls = 0;
  }
  async testRuleset(text) { this.testCalls.push(text); return this.testResult; }
  async loadRuleset(text) { this.loadCalls.push(text); return { ok: true }; }
  async clearState(ip) { this.clearStateCalls.push(ip); return { ok: true }; }
  async clearAnchor() { this.clearAnchorCalls += 1; return { ok: true }; }
  async inspectRules() {
    this.inspectCalls += 1;
    if (this.inspectOutput instanceof Error) throw this.inspectOutput;
    return this.inspectOutput;
  }
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
}

function makeOrchestrator({ proxyPoolStorePath, testResult, inspectOutput,
  peerResult = { localIp: "10.0.0.2", peerIp: "10.0.0.1" }, interfaces = ["lo0", "en0"],
  recoveryDelayMs, setTimeoutFn, clearTimeoutFn } = {}) {
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
    listAllInterfaces: async () => [...interfaces, ...tunManager.activeIfaces],
    discoverTunPeer: peerResult instanceof Error
      ? async () => { throw peerResult; }
      : async () => peerResult,
    onStateChanged: (deviceId, route) => changes.push({ deviceId, route }),
    ...(recoveryDelayMs === undefined ? {} : { recoveryDelayMs }),
    ...(setTimeoutFn ? { setTimeoutFn } : {}),
    ...(clearTimeoutFn ? { clearTimeoutFn } : {}),
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
  assert.match(route.lastError, /ifconfig -l failed/);
  assert.equal(tunManager.starts.length, 0, "never got as far as starting a tunnel");
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
  assert.match(orchestrator.getRoute("mock-1").lastError, /pfctl unavailable/);

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

  await assert.rejects(() => orchestrator.quarantineRoute("mock-1"), /pfctl unavailable/);

  assert.equal(tunManager.isRunning("mock-1"), false);
  assert.equal(orchestrator.getRoute("mock-1").protected, false);
});

test("checkHealth never fails a device over a transient inspectRules error — it just skips the PF check that tick", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });
  privilegedOps.inspectOutput = new Error("sudo timeout");

  await orchestrator.checkHealth();

  assert.equal(orchestrator.getRoute("mock-1").state, ROUTING_STATES.ROUTED);
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

  await orchestrator.checkHealth();

  assert.equal(privilegedOps.inspectCalls, 1);
  assert.equal(orchestrator.getRoute("mock-1").lastPackets, 5);
  assert.equal(orchestrator.getRoute("mock-2").lastPackets, 9);
});

test("startHealthChecks runs an immediate check and then on the configured interval; stopHealthChecks ends it", async () => {
  const storePath = tempStorePath();
  const proxy = createProxy(storePath, samplePayload(), MASTER_KEY);
  assignProxyToDevice(storePath, { deviceId: "mock-1", proxyId: proxy.id });
  const { orchestrator, privilegedOps } = makeOrchestrator({ proxyPoolStorePath: storePath, inspectOutput: inspectFor("192.168.2.10", 1) });
  await orchestrator.startRouting("mock-1", { usbIp: "192.168.2.10" });

  orchestrator.startHealthChecks({ intervalMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 5)); // let the immediate check land
  assert.equal(privilegedOps.inspectCalls, 1);

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
