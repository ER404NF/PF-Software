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

const DEFAULT_TIMEOUT_MS = 5000;

function emptyStatus() {
  return {
    networkObservedIp: null,
    networkCheckedAt: null,
    networkVerified: null,
    networkMismatch: null,
    networkMismatchReason: null,
  };
}

function createNetworkVerifier({ deviceNetwork, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
    try {
      const res = await fetch(checkUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`network check failed: HTTP ${res.status}`);
      const body = await res.json();
      if (typeof body.ip !== "string" || body.ip.length === 0) {
        throw new Error("network check returned no ip");
      }
      observedIp = body.ip;
    } catch (err) {
      const entry = { ...emptyStatus(), networkCheckedAt: checkedAt(), networkVerified: false, networkMismatchReason: `network check failed: ${err.message}` };
      status.set(deviceId, entry);
      return entry;
    }

    const collision = findCollision(deviceId, observedIp, identity);
    const entry = {
      networkObservedIp: observedIp,
      networkCheckedAt: checkedAt(),
      networkVerified: !collision,
      networkMismatch: Boolean(collision),
      networkMismatchReason: collision
        ? `shares egress IP ${observedIp} with device "${collision}", which is on a different network assignment`
        : null,
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
      });
    }

    return entry;
  }

  return { checkDevice, getStatus };
}

export { createNetworkVerifier };
