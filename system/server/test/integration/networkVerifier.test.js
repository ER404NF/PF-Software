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

test("checkDevice against a lone device on its own SIM is verified with no mismatch", async () => {
  const verifier = makeVerifier([
    { id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } },
  ]);
  const result = await verifier.checkDevice("d1", CHECK_URL);
  assert.equal(result.networkObservedIp, "203.0.113.10");
  assert.equal(result.networkVerified, true);
  assert.equal(result.networkMismatch, false);
  assert.equal(result.networkMismatchReason, null);
  assert.ok(result.networkCheckedAt);
});

test("getStatus for a never-checked device returns all-null defaults", () => {
  const verifier = makeVerifier([{ id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } }]);
  assert.deepEqual(verifier.getStatus("d1"), {
    networkObservedIp: null,
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
    proxyResult: { status: "healthy", publicIpv4: "198.51.100.10", country: "US", checkedAt: new Date().toISOString() },
    route: { state: "routed" },
  });
  assert.equal(result.networkProxyHealthy, true);
  assert.equal(result.networkRouteMatch, true);
  assert.equal(result.networkVerified, false);
  assert.equal(result.networkProtectionState, "VERIFYING");
  assert.match(result.networkVerificationMessage, /device-originated/);
});

test("two devices on different SIMs sharing an observed IP are both flagged as a mismatch", async () => {
  const verifier = makeVerifier([
    { id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } },
    { id: "d2", network: { egress: "cellular-sim", simIccid: "222", controlIface: "usb" } },
  ]);

  await setIp("198.51.100.5");
  const first = await verifier.checkDevice("d1", CHECK_URL);
  assert.equal(first.networkVerified, true); // nothing to collide with yet

  const second = await verifier.checkDevice("d2", CHECK_URL); // still the same IP
  assert.equal(second.networkVerified, false);
  assert.equal(second.networkMismatch, true);
  assert.match(second.networkMismatchReason, /shares egress IP 198\.51\.100\.5 with device "d1"/);

  // d1's own record must be corrected retroactively too, not just d2's.
  const d1Status = verifier.getStatus("d1");
  assert.equal(d1Status.networkVerified, false);
  assert.equal(d1Status.networkMismatch, true);
  assert.match(d1Status.networkMismatchReason, /device "d2"/);
  assert.equal(d1Status.networkLatestError.code, "V204");
  assert.deepEqual(d1Status.networkDiagnosticEvents.at(-1), {
    type: "NETWORK_DEGRADED",
    at: d1Status.networkLatestError.at,
    errorCode: "V204",
  });
});

test("two devices on the SAME vlanId sharing an observed IP is expected, not a mismatch", async () => {
  const verifier = makeVerifier([
    { id: "d1", network: { egress: "vlan-proxy", vlanId: "vlan-7", controlIface: "usb" } },
    { id: "d2", network: { egress: "vlan-proxy", vlanId: "vlan-7", controlIface: "usb" } },
  ]);

  await setIp("198.51.100.9");
  await verifier.checkDevice("d1", CHECK_URL);
  const second = await verifier.checkDevice("d2", CHECK_URL);

  assert.equal(second.networkVerified, true);
  assert.equal(second.networkMismatch, false);
  assert.equal(verifier.getStatus("d1").networkVerified, true);
});

test("a device with no network assignment yet still gets a real collision check (identity null vs null is still 'different' from any real identity, but two unassigned devices share the null identity)", async () => {
  // Two genuinely unassigned devices share the same (null) identity, so
  // sharing an IP between them is not flagged — there's no isolation claim
  // to violate yet for either.
  const verifier = makeVerifier([{ id: "d1" }, { id: "d2" }]);
  await setIp("198.51.100.20");
  await verifier.checkDevice("d1", CHECK_URL);
  const second = await verifier.checkDevice("d2", CHECK_URL);
  assert.equal(second.networkVerified, true);
  assert.equal(second.networkMismatch, false);
});

test("an unassigned device colliding with an assigned device IS flagged — unassigned is not a free pass", async () => {
  const verifier = makeVerifier([
    { id: "d1", network: { egress: "cellular-sim", simIccid: "111", controlIface: "usb" } },
    { id: "d2" },
  ]);
  await setIp("198.51.100.30");
  await verifier.checkDevice("d1", CHECK_URL);
  const second = await verifier.checkDevice("d2", CHECK_URL);
  assert.equal(second.networkVerified, false);
  assert.equal(second.networkMismatch, true);
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
  await setIp("198.51.100.40");
  const first = await verifier.checkDevice("d1", CHECK_URL);
  await setIp("198.51.100.41");
  const second = await verifier.checkDevice("d1", CHECK_URL);

  assert.notEqual(first.networkObservedIp, second.networkObservedIp);
  assert.equal(verifier.getStatus("d1").networkObservedIp, "198.51.100.41");
});

test("verification compares configured IPv4 and IPv6 policy and records safe health metadata", async () => {
  const verifier = makeVerifier([{
    id: "d1",
    network: {
      egress: "cellular-sim", simIccid: "111", controlIface: "usb",
      expectedPublicIpv4: "198.51.100.99", expectedIpv6Policy: "required",
    },
  }]);
  await setIp("198.51.100.98");
  const result = await verifier.checkDevice("d1", CHECK_URL);
  assert.equal(result.networkVerified, false);
  assert.equal(result.networkRouteMatch, false);
  assert.match(result.networkMismatchReason, /does not match configured IPv4/);
  assert.match(result.networkMismatchReason, /IPv6 was not observed/);
  assert.equal(result.networkObservedRegion, "test-region");
  assert.equal(result.networkDnsStatus, "ok");
  assert.equal(result.networkProxyHealthy, true);
  assert.equal(result.networkBandwidthMbps, 100);
});
