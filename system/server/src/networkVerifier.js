// Phase 0 network-isolation verification: given a device's assigned egress
// (deviceNetworkConfig.js), determine its observed egress IP right now and
// check it against every other device's most recently observed IP for an
// isolation-boundary violation — source-material's Client Account Separation
// reference §3.5: a stable, unusual IP shared across otherwise-unrelated
// accounts is a real linkage risk, and that's exactly what two devices on
// *different* assigned egress channels (different simIccid, or different
// vlanId) sharing an observed IP would mean: the isolation this Phase 0 work
// exists to enforce has silently failed — e.g. a cellular modem dropped and
// the phone fell back to a shared network, the exact failure mode the iOS
// Configuration Profile (a separate, out-of-band Phase 0 deliverable) is
// meant to block at the OS level.
//
// This deliberately does NOT reach into WdaDevice/MockDevice's tap/swipe/
// render contract (system/README.md "Current WebSocket protocol"/adapter
// docs) — WDA's control channel runs over USB iproxy and has no concept of
// the phone's own network egress, so there's nothing on that interface to
// call. Instead this mirrors wdaDevice.js's OWN shape one level up: a small
// fetch-based client, with a bounded timeout, pointed at whatever "what is
// my IP" endpoint is reachable via the device's actual assigned egress path.
// In Phase 1-3 (out of scope here — no real routers/SIMs exist yet) that's a
// small status endpoint on each VLAN's dedicated LTE modem, or an
// externally-reachable IP-echo service; here it's the fake fixture
// (server/fixtures/fake-network-check-server.js) mirroring fake-wda-
// server.js's own role for WdaDevice. The caller supplies the URL per check
// (like WdaDevice's constructor takes host/port) rather than this module
// reading it from devices.config.json — production wiring for "how do we
// know each device's check URL" is a Phase 1-3 concern once real hardware
// exists to have a URL at all.

import { egressIdentity } from "./deviceNetworkConfig.js";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 5000;

function emptyStatus() {
  return {
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
  };
}

function createNetworkVerifier({ deviceNetwork, timeoutMs = DEFAULT_TIMEOUT_MS,
  onError = (error) => console.error("Network verification transport failed:", error?.code || error?.name || "Error") } = {}) {
  const status = new Map(); // deviceId -> status shape above

  function getStatus(deviceId) {
    return status.get(deviceId) ?? emptyStatus();
  }

  // Finds another already-checked device, on a *different* egress identity
  // than `deviceId`, whose last observed IP matches `observedIp` — the
  // concrete signal that isolation has failed for one or both of them.
  function findCollision(deviceId, observedIp, identity) {
    for (const [otherId, otherStatus] of status) {
      if (otherId === deviceId) continue;
      if (otherStatus.networkObservedIp !== observedIp) continue;
      const otherIdentity = egressIdentity(deviceNetwork.get(otherId));
      if (otherIdentity !== identity) return otherId;
    }
    return null;
  }

  async function checkDevice(deviceId, checkUrl) {
    const identity = egressIdentity(deviceNetwork.get(deviceId));
    const checkedAt = () => new Date().toISOString();

    let observedIp;
    let observedIpv6 = null;
    let observedRegion = null;
    let dnsStatus = null;
    let proxyHealthy = null;
    let bandwidthMbps = null;
    try {
      const res = await fetch(checkUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      if (!res.ok) throw new Error(`network check failed: HTTP ${res.status}`);
      const body = await res.json();
      if (typeof body.ip !== "string" || isIP(body.ip) !== 4) {
        throw new Error("network check returned no ip");
      }
      observedIp = body.ip;
      observedIpv6 = typeof body.ipv6 === "string" && isIP(body.ipv6) === 6 ? body.ipv6 : null;
      observedRegion = typeof body.region === "string" && body.region.length <= 100 ? body.region : null;
      dnsStatus = typeof body.dnsStatus === "string" && body.dnsStatus.length <= 100 ? body.dnsStatus : null;
      proxyHealthy = typeof body.proxyHealthy === "boolean" ? body.proxyHealthy : null;
      bandwidthMbps = Number.isFinite(body.bandwidthMbps) && body.bandwidthMbps >= 0 && body.bandwidthMbps <= 1_000_000
        ? body.bandwidthMbps : null;
    } catch (err) {
      onError(err);
      const entry = { ...emptyStatus(), networkCheckedAt: checkedAt(), networkVerified: false,
        networkMismatchReason: "network check failed" };
      status.set(deviceId, entry);
      return entry;
    }

    const collision = findCollision(deviceId, observedIp, identity);
    const network = deviceNetwork.get(deviceId);
    const mismatches = [];
    if (collision) mismatches.push(`shares egress IP ${observedIp} with device "${collision}", which is on a different network assignment`);
    if (network?.expectedPublicIpv4 && network.expectedPublicIpv4 !== observedIp) {
      mismatches.push(`observed IPv4 ${observedIp} does not match configured IPv4 ${network.expectedPublicIpv4}`);
    }
    if (network?.expectedIpv6Policy === "blocked" && observedIpv6) mismatches.push("IPv6 was observed but policy requires it blocked");
    if (network?.expectedIpv6Policy === "required" && !observedIpv6) mismatches.push("IPv6 was not observed but policy requires it");
    if (proxyHealthy === false) mismatches.push("proxy health endpoint reported unhealthy");
    const entry = {
      networkObservedIp: observedIp,
      networkCheckedAt: checkedAt(),
      networkVerified: mismatches.length === 0,
      networkMismatch: mismatches.length > 0,
      networkMismatchReason: mismatches.length ? mismatches.join("; ") : null,
      networkObservedIpv6: observedIpv6,
      networkObservedRegion: observedRegion,
      networkDnsStatus: dnsStatus,
      networkProxyHealthy: proxyHealthy,
      networkBandwidthMbps: bandwidthMbps,
      networkRouteMatch: mismatches.length === 0,
    };
    status.set(deviceId, entry);

    // The collision is evidence against BOTH devices, not just the one that
    // happened to be checked second — the earlier device's own record must
    // be corrected too, or it would keep reporting a stale "verified: true".
    if (collision) {
      const other = status.get(collision);
      status.set(collision, {
        ...other,
        networkVerified: false,
        networkMismatch: true,
        networkMismatchReason: `shares egress IP ${observedIp} with device "${deviceId}", which is on a different network assignment`,
        networkRouteMatch: false,
      });
    }

    return entry;
  }

  return { checkDevice, getStatus };
}

export { createNetworkVerifier };
