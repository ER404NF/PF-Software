import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createNetworkVerifier } from "../../src/networkVerifier.js";
import { loadDeviceNetworkMap } from "../../src/deviceNetworkConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../../fixtures/fake-network-check-server.js");

let child;
let BASE_URL;
let CHECK_URL;

// Ephemeral port ("0"), not a fixed one — same TIME_WAIT-avoidance reasoning
// as wdaDevice.test.js's own fixture spawn.
function spawnFakeCheckServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fixturePath, "0"], { stdio: "pipe" });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/\[fake-network-check\] listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        proc.stdout.off("data", onData);
        resolve({ proc, baseUrl: `http://127.0.0.1:${match[1]}` });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("error", reject);
  });
}

before(async () => {
  const { proc, baseUrl } = await spawnFakeCheckServer();
  child = proc;
  BASE_URL = baseUrl;
  CHECK_URL = `${BASE_URL}/ip`;
});

after(() => {
  child.kill();
});

beforeEach(async () => {
  await fetch(`${BASE_URL}/debug/reset`, { method: "POST" });
});

function setIp(ip) {
  return fetch(`${BASE_URL}/debug/set-ip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ip }),
  });
}

function makeVerifier(devicesConfig) {
  const deviceNetwork = loadDeviceNetworkMap({ devices: devicesConfig });
  return createNetworkVerifier({ deviceNetwork, timeoutMs: 500 });
}

test("a server-side check records host evidence but cannot prove phone egress", async () => {
  const verifier = makeVerifier([
    { id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } },
  ]);
  const result = await verifier.checkDevice("d1", CHECK_URL);
  assert.equal(result.networkObservedIp, null);
  assert.equal(result.networkHostObservedIpv4, "8.8.8.8");
  assert.equal(result.networkVerified, false);
  assert.equal(result.networkMismatch, false);
  assert.equal(result.networkMismatchReason, null);
  assert.equal(result.networkProtectionState, "VERIFYING");
  assert.equal(result.networkVerificationLevel, "host-configured-egress-endpoint");
  assert.match(result.networkVerificationMessage, /phone egress test required/);
  assert.ok(result.networkCheckedAt);
});

test("getStatus for a never-checked device returns all-null defaults", () => {
  const verifier = makeVerifier([{ id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } }]);
  assert.deepEqual(verifier.getStatus("d1"), {
    networkObservedIp: null,
    networkHostObservedIpv4: null,
    networkHostObservedIpv6: null,
    networkHostObservedRegion: null,
    networkHostDnsStatus: null,
    networkHostBandwidthMbps: null,
    networkCheckedAt: null,
    networkVerified: null,
    networkMismatch: null,
    networkMismatchReason: null,
    networkObservedIpv6: null,
    networkObservedRegion: null,
    networkDnsStatus: null,
    networkProxyHealthy: null,
    networkBandwidthMbps: null,
    networkRouteMatch: null,
    networkVerificationLevel: null,
    networkProtectionState: "UNCONFIGURED",
    networkVerificationMessage: null,
    networkLatestError: null,
    networkDiagnosticEvents: [],
  });
});

test("proxy and host-route checks remain VERIFYING until a device-originated egress probe passes", () => {
  const verifier = makeVerifier([{ id: "d1", network: { egress: "commercial-proxy", profileId: "p1", controlIface: "usb" } }]);
  const result = verifier.recordInfrastructureCheck("d1", {
    proxyResult: { status: "healthy", publicIpv4: "8.8.8.8", country: "US", checkedAt: new Date().toISOString() },
    route: { state: "routed" },
  });
  assert.equal(result.networkProxyHealthy, true);
  assert.equal(result.networkRouteMatch, true);
  assert.equal(result.networkVerified, false);
  assert.equal(result.networkProtectionState, "VERIFYING");
  assert.match(result.networkVerificationMessage, /device-originated/);
});

test("authorized phone evidence promotes a current protected route and detects cross-phone collisions", async () => {
  const deviceNetwork = loadDeviceNetworkMap({ devices: [
    { id: "d1", network: { egress: "commercial-proxy", profileId: "p1", controlIface: "usb", expectedIpv6Policy: "blocked" } },
    { id: "d2", network: { egress: "commercial-proxy", profileId: "p2", controlIface: "usb", expectedIpv6Policy: "blocked" } },
  ] });
  const verifier = createNetworkVerifier({ deviceNetwork, timeoutMs: 500 });
  const infrastructure = { status: "healthy", publicIpv4: "8.8.8.8", country: "US", checkedAt: new Date().toISOString() };
  verifier.recordInfrastructureCheck("d1", { proxyResult: infrastructure, route: { state: "routed" } });
  const protectedResult = await verifier.recordDeviceEvidence("d1", {
    observedIpv4: "8.8.8.8", dnsPassed: true, webrtcPassed: true, ipv6PolicyPassed: true,
  }, { authorize: async () => {}, proveCurrentRoute: async () => true });
  assert.equal(protectedResult.networkVerified, true);
  assert.equal(protectedResult.networkProtectionState, "PROTECTED");
  assert.equal(protectedResult.networkVerificationLevel, "device-originated-manual-attestation");

  verifier.recordInfrastructureCheck("d2", { proxyResult: infrastructure, route: { state: "routed" } });
  await assert.rejects(() => verifier.recordDeviceEvidence("d2", {
    observedIpv4: "8.8.8.8", dnsPassed: true, webrtcPassed: true, ipv6PolicyPassed: true,
  }, { authorize: async () => {}, proveCurrentRoute: async () => true }), /shares a public IPv4/);
});

test("expired phone evidence does not reserve a rotating public IP forever", async () => {
  const deviceNetwork = loadDeviceNetworkMap({ devices: [
    { id: "d1", network: { egress: "commercial-proxy", profileId: "p1", controlIface: "usb" } },
    { id: "d2", network: { egress: "commercial-proxy", profileId: "p2", controlIface: "usb" } },
  ] });
  const verifier = createNetworkVerifier({ deviceNetwork, timeoutMs: 500, maxHostEvidenceAgeMs: 5 });
  const evidence = { observedIpv4: "8.8.8.8", dnsPassed: true, webrtcPassed: true, ipv6PolicyPassed: true };
  const infrastructure = () => ({
    proxyResult: { status: "healthy", publicIpv4: "8.8.8.8", checkedAt: new Date().toISOString() },
    route: { state: "routed" },
  });
  verifier.recordInfrastructureCheck("d1", infrastructure());
  await verifier.recordDeviceEvidence("d1", evidence,
    { authorize: async () => {}, proveCurrentRoute: async () => true });
  await new Promise(resolve => setTimeout(resolve, 15));
  verifier.recordInfrastructureCheck("d2", infrastructure());
  const result = await verifier.recordDeviceEvidence("d2", evidence,
    { authorize: async () => {}, proveCurrentRoute: async () => true });
  assert.equal(result.networkVerified, true);
  assert.equal(result.networkObservedIp, "8.8.8.8");
});

test("phone evidence fails closed without complete leak checks or a current proxy route", async () => {
  const verifier = makeVerifier([
    { id: "d1", network: { egress: "commercial-proxy", profileId: "p1", controlIface: "usb", expectedIpv6Policy: "blocked" } },
  ]);
  verifier.recordInfrastructureCheck("d1", {
    proxyResult: { status: "healthy", publicIpv4: "8.8.4.4", country: "US", checkedAt: new Date().toISOString() },
    route: { state: "routed" },
  });
  await assert.rejects(() => verifier.recordDeviceEvidence("d1", {
    observedIpv4: "8.8.4.4", dnsPassed: true, webrtcPassed: false, ipv6PolicyPassed: true,
  }, { authorize: async () => {}, proveCurrentRoute: async () => true }), /DNS, WebRTC, and IPv6/);
  await assert.rejects(() => verifier.recordDeviceEvidence("d1", {
    observedIpv4: "8.8.4.4", dnsPassed: true, webrtcPassed: true, ipv6PolicyPassed: true,
  }, { authorize: async () => {}, proveCurrentRoute: async () => false }), /no longer current/);
  await assert.rejects(() => verifier.recordDeviceEvidence("d1", {
    observedIpv4: "8.8.4.4", observedIpv6: "2001:4860:4860::8888",
    dnsPassed: true, webrtcPassed: true, ipv6PolicyPassed: true,
  }, { authorize: async () => {}, proveCurrentRoute: async () => true }), /requires IPv6 to be blocked/);
  assert.equal(verifier.getStatus("d1").networkVerified, false);
});

test("phone evidence rejects missing authorization, invalid addresses, incomplete confirmations, and stale host checks", async () => {
  const verifier = makeVerifier([{
    id: "d1", network: {
      egress: "cellular-sim", simIccid: "111", controlIface: "usb",
      expectedPublicIpv4: "8.8.8.8", expectedIpv6Policy: "required",
    },
  }]);
  const host = checkedAt => verifier.recordInfrastructureCheck("d1", {
    proxyResult: { status: "healthy", publicIpv4: "8.8.8.8", country: "US", checkedAt },
    route: { state: "routed" },
  });
  host(new Date().toISOString());
  const complete = { observedIpv4: "8.8.8.8", observedIpv6: "2001:4860:4860::8888",
    dnsPassed: true, webrtcPassed: true, ipv6PolicyPassed: true };
  await assert.rejects(() => verifier.recordDeviceEvidence("d1", complete), /authorization is required/i);
  await assert.rejects(() => verifier.recordDeviceEvidence("d1", { ...complete, observedIpv4: "127.0.0.1" },
    { authorize: async () => {} }), /public IPv4/);
  await assert.rejects(() => verifier.recordDeviceEvidence("d1", { ...complete, observedIpv4: "1.1.1.1" },
    { authorize: async () => {} }), /does not match/);
  await assert.rejects(() => verifier.recordDeviceEvidence("d1", { ...complete, observedIpv6: "not-ipv6" },
    { authorize: async () => {} }), /valid IPv6/);
  for (const field of ["dnsPassed", "webrtcPassed", "ipv6PolicyPassed"]) {
    await assert.rejects(() => verifier.recordDeviceEvidence("d1", { ...complete, [field]: false },
      { authorize: async () => {} }), /DNS, WebRTC, and IPv6/);
  }
  await assert.rejects(() => verifier.recordDeviceEvidence("d1", { ...complete, observedIpv6: null },
    { authorize: async () => {} }), /requires an IPv6/);

  host("2020-01-01T00:00:00.000Z");
  await assert.rejects(() => verifier.recordDeviceEvidence("d1", complete,
    { authorize: async () => {} }), /immediately before/);
  assert.equal(verifier.getStatus("d1").networkVerified, false);
});

test("route invalidation or authorization revocation during proof cannot commit stale phone evidence", async () => {
  const makeProxyVerifier = () => {
    const verifier = makeVerifier([{
      id: "d1", network: { egress: "commercial-proxy", profileId: "p1", controlIface: "usb" },
    }]);
    verifier.recordInfrastructureCheck("d1", {
      proxyResult: { status: "healthy", publicIpv4: "8.8.8.8", country: "US", checkedAt: new Date().toISOString() },
      route: { state: "routed" },
    });
    return verifier;
  };
  const evidence = { observedIpv4: "8.8.8.8", dnsPassed: true, webrtcPassed: true, ipv6PolicyPassed: true };

  const invalidated = makeProxyVerifier();
  let releaseProof;
  let proofStarted;
  const started = new Promise(resolve => { proofStarted = resolve; });
  const proof = new Promise(resolve => { releaseProof = resolve; });
  const pending = invalidated.recordDeviceEvidence("d1", evidence, {
    authorize: async () => {},
    proveCurrentRoute: async () => { proofStarted(); await proof; return true; },
  });
  await started;
  invalidated.invalidate("d1");
  releaseProof();
  await assert.rejects(pending, /host route changed/);
  assert.equal(invalidated.getStatus("d1").networkVerified, false);
  assert.equal(invalidated.getStatus("d1").networkProtectionState, "UNVERIFIED");
  assert.equal(invalidated.getStatus("d1").networkRouteMatch, false);

  const revoked = makeProxyVerifier();
  let authorized = true;
  await assert.rejects(() => revoked.recordDeviceEvidence("d1", evidence, {
    authorize: async () => {
      if (!authorized) throw Object.assign(new Error("authorization changed"), { status: 403 });
    },
    proveCurrentRoute: async () => { authorized = false; return true; },
  }), /authorization changed/);
  assert.equal(revoked.getStatus("d1").networkVerified, false);
});

test("fresh tunnel, PF and bridge proof still cannot turn a host request into phone proof", async () => {
  const verifier = makeVerifier([{ id: "d1", network: { egress: "commercial-proxy", profileId: "p1", controlIface: "usb" } }]);
  const unproven = await verifier.checkDevice("d1", CHECK_URL);
  assert.equal(unproven.networkVerified, false);
  assert.equal(unproven.networkProtectionState, "FAILED");
  assert.match(unproven.networkMismatchReason, /could not be proven/);

  const proven = await verifier.checkDevice("d1", CHECK_URL, { proveCurrentRoute: async () => true });
  assert.equal(proven.networkVerified, false);
  assert.equal(proven.networkMismatch, false);
  assert.equal(proven.networkProtectionState, "VERIFYING");
  assert.match(proven.networkVerificationMessage, /phone egress test required/);
});

test("host observations are never used as evidence of cross-phone IP collision", async () => {
  const verifier = makeVerifier([
    { id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } },
    { id: "d2", network: { egress: "cellular-sim", simIccid: "222", controlIface: "usb" } },
  ]);

  await setIp("1.1.1.1");
  const first = await verifier.checkDevice("d1", CHECK_URL);
  assert.equal(first.networkVerified, false);

  const second = await verifier.checkDevice("d2", CHECK_URL); // still the same IP
  assert.equal(second.networkVerified, false);
  assert.equal(second.networkMismatch, false);
  assert.equal(second.networkHostObservedIpv4, "1.1.1.1");
  const d1Status = verifier.getStatus("d1");
  assert.equal(d1Status.networkVerified, false);
  assert.equal(d1Status.networkMismatch, false);
});

test("two devices on the SAME vlanId sharing an observed IP is expected, not a mismatch", async () => {
  const verifier = makeVerifier([
    { id: "d1", network: { egress: "vlan-proxy", vlanId: "vlan-7", controlIface: "usb" } },
    { id: "d2", network: { egress: "vlan-proxy", vlanId: "vlan-7", controlIface: "usb" } },
  ]);

  await setIp("9.9.9.9");
  await verifier.checkDevice("d1", CHECK_URL, { proveCurrentRoute: async () => true });
  const second = await verifier.checkDevice("d2", CHECK_URL, { proveCurrentRoute: async () => true });

  assert.equal(second.networkVerified, false);
  assert.equal(second.networkMismatch, false);
  assert.equal(verifier.getStatus("d1").networkVerified, false);
});

test("unassigned devices also remain VERIFYING after a host-side request", async () => {
  const verifier = makeVerifier([{ id: "d1" }, { id: "d2" }]);
  await setIp("8.8.4.4");
  await verifier.checkDevice("d1", CHECK_URL);
  const second = await verifier.checkDevice("d2", CHECK_URL);
  assert.equal(second.networkVerified, false);
  assert.equal(second.networkMismatch, false);
  assert.equal(second.networkProtectionState, "VERIFYING");
});

test("an assigned and unassigned device cannot be compared using host-side observations", async () => {
  const verifier = makeVerifier([
    { id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } },
    { id: "d2" },
  ]);
  await setIp("1.0.0.1");
  await verifier.checkDevice("d1", CHECK_URL);
  const second = await verifier.checkDevice("d2", CHECK_URL);
  assert.equal(second.networkVerified, false);
  assert.equal(second.networkMismatch, false);
});

test("an unreachable check endpoint is reported as unverified, not a false mismatch", async () => {
  const verifier = makeVerifier([{ id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } }]);
  await fetch(`${BASE_URL}/debug/hang`, { method: "POST" });

  const start = Date.now();
  const result = await verifier.checkDevice("d1", CHECK_URL);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `expected the bounded timeout to fire well under 2s, took ${elapsed}ms`);
  assert.equal(result.networkObservedIp, null);
  assert.equal(result.networkVerified, false);
  assert.equal(result.networkMismatch, null); // failed to check at all — distinct from a confirmed collision
  assert.match(result.networkMismatchReason, /network check failed/);
});

test("network verification does not follow redirects", async () => {
  const errors = [];
  const deviceNetwork = loadDeviceNetworkMap({ devices: [
    { id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } },
  ] });
  const verifier = createNetworkVerifier({ deviceNetwork, timeoutMs: 500, onError: error => errors.push(error) });
  const result = await verifier.checkDevice("d1", `${BASE_URL}/redirect`);
  assert.equal(result.networkVerified, false);
  assert.equal(result.networkObservedIp, null);
  assert.equal(result.networkMismatchReason, "network check failed");
  assert.equal(errors.length, 1);
});

test("re-checking a device replaces its status rather than accumulating stale fields", async () => {
  const verifier = makeVerifier([{ id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } }]);
  await setIp("4.2.2.1");
  const first = await verifier.checkDevice("d1", CHECK_URL);
  await setIp("4.2.2.2");
  const second = await verifier.checkDevice("d1", CHECK_URL);

  assert.notEqual(first.networkHostObservedIpv4, second.networkHostObservedIpv4);
  assert.equal(verifier.getStatus("d1").networkHostObservedIpv4, "4.2.2.2");
  assert.equal(verifier.getStatus("d1").networkObservedIp, null);
});

test("verification compares configured IPv4 and IPv6 policy and records safe health metadata", async () => {
  const verifier = makeVerifier([{
    id: "d1",
    network: {
      egress: "cellular-sim", simIccid: "111", controlIface: "usb",
      expectedPublicIpv4: "208.67.222.222", expectedIpv6Policy: "required",
    },
  }]);
  await setIp("208.67.220.220");
  const result = await verifier.checkDevice("d1", CHECK_URL);
  assert.equal(result.networkVerified, false);
  assert.equal(result.networkRouteMatch, false);
  assert.match(result.networkMismatchReason, /does not match configured IPv4/);
  assert.match(result.networkMismatchReason, /IPv6 was not observed/);
  assert.equal(result.networkObservedRegion, null);
  assert.equal(result.networkDnsStatus, null);
  assert.equal(result.networkHostObservedRegion, "test-region");
  assert.equal(result.networkHostDnsStatus, "ok");
  assert.equal(result.networkProxyHealthy, true);
  assert.equal(result.networkBandwidthMbps, null);
  assert.equal(result.networkHostBandwidthMbps, 100);
});
