// Host-side network evidence for a phone's assigned egress. Node's fetch runs
// in the Bodun server process; WDA has no API that originates arbitrary HTTP
// traffic through the iPhone's Internet path. A successful request can prove
// provider/host reachability and local route state, but it must remain
// VERIFYING until a separate, genuine phone-originated probe exists. Negative
// evidence remains fail closed.

import { isProxyEgress } from "./deviceNetworkStore.js";
import { diagnosticError } from "./errorCatalog.js";
import { isPublicIpv4 } from "./publicIp.js";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 5000;

function emptyStatus() {
  return {
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
  };
}

async function readBoundedJson(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("network check response exceeded size limit");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("network check response exceeded size limit");
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("network check response exceeded size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function createNetworkVerifier({ deviceNetwork, timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = 64 * 1024,
  onError = (error) => console.error("Network verification transport failed:", error?.code || error?.name || "Error") } = {}) {
  const status = new Map(); // deviceId -> status shape above
  const generations = new Map();

  function getStatus(deviceId) {
    return status.get(deviceId) ?? emptyStatus();
  }

  async function checkDevice(deviceId, checkUrl, { authorize = null, proveCurrentRoute = null } = {}) {
    const generation = generations.get(deviceId) ?? 0;
    await authorize?.();
    if (generation !== (generations.get(deviceId) ?? 0)) return getStatus(deviceId);
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
      const body = await readBoundedJson(res, maxResponseBytes);
      if (!isPublicIpv4(body?.ip)) {
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
      if ([401, 403].includes(err?.status)) throw err;
      if (generation !== (generations.get(deviceId) ?? 0)) return getStatus(deviceId);
      onError(err);
      const diagnostic = diagnosticError("V201", {
        why: "Bodun could not complete the host-side network endpoint request.",
        technical: { reason: err?.code || err?.name, timeoutMs },
      });
      const entry = { ...emptyStatus(), networkCheckedAt: checkedAt(), networkVerified: false,
        networkMismatchReason: "network check failed", networkProtectionState: "FAILED",
        networkVerificationMessage: diagnostic.why,
        networkLatestError: diagnostic,
        networkDiagnosticEvents: [{ type: "NETWORK_VERIFY_STARTED", at: diagnostic.at },
          { type: "NETWORK_DEGRADED", at: diagnostic.at, errorCode: diagnostic.code }] };
      status.set(deviceId, entry);
      return entry;
    }

    await authorize?.();
    if (generation !== (generations.get(deviceId) ?? 0)) return getStatus(deviceId);
    const network = deviceNetwork.get(deviceId);
    const mismatches = [];
    if (isProxyEgress(network?.egress)) {
      let routeProven = false;
      try { routeProven = typeof proveCurrentRoute === "function" && await proveCurrentRoute() === true; }
      catch { routeProven = false; }
      await authorize?.();
      if (generation !== (generations.get(deviceId) ?? 0)) return getStatus(deviceId);
      if (!routeProven) mismatches.push("current tunnel ownership, firewall rule, and bridge state could not be proven");
    }
    if (network?.expectedPublicIpv4 && network.expectedPublicIpv4 !== observedIp) {
      mismatches.push(`observed IPv4 ${observedIp} does not match configured IPv4 ${network.expectedPublicIpv4}`);
    }
    if (network?.expectedIpv6Policy === "blocked" && observedIpv6) mismatches.push("IPv6 was observed but policy requires it blocked");
    if (network?.expectedIpv6Policy === "required" && !observedIpv6) mismatches.push("IPv6 was not observed but policy requires it");
    if (proxyHealthy === false) mismatches.push("proxy health endpoint reported unhealthy");
    const errorCode = observedIpv6 && network?.expectedIpv6Policy === "blocked" ? "V203"
      : network?.expectedPublicIpv4 && network.expectedPublicIpv4 !== observedIp ? "V202"
        : mismatches.length ? "V204" : null;
    const latestError = errorCode ? diagnosticError(errorCode, { why: mismatches.join("; "),
      technical: { observedIpv6: Boolean(observedIpv6), mismatchCount: mismatches.length } }) : null;
    const eventAt = checkedAt();
    const entry = {
      networkObservedIp: null,
      networkHostObservedIpv4: observedIp,
      networkHostObservedIpv6: observedIpv6,
      networkHostObservedRegion: observedRegion,
      networkHostDnsStatus: dnsStatus,
      networkHostBandwidthMbps: bandwidthMbps,
      networkCheckedAt: eventAt,
      networkVerified: false,
      networkMismatch: mismatches.length > 0,
      networkMismatchReason: mismatches.length ? mismatches.join("; ") : null,
      networkObservedIpv6: null,
      networkObservedRegion: null,
      networkDnsStatus: null,
      networkProxyHealthy: proxyHealthy,
      networkBandwidthMbps: null,
      networkRouteMatch: mismatches.length === 0,
      networkVerificationLevel: "host-configured-egress-endpoint",
      networkProtectionState: mismatches.length === 0 ? "VERIFYING" : "FAILED",
      networkVerificationMessage: mismatches.length === 0
        ? "Host route verified — phone egress test required."
        : mismatches.join("; "),
      networkLatestError: latestError,
      networkDiagnosticEvents: [{ type: "NETWORK_VERIFY_STARTED", at: eventAt }, {
        type: mismatches.length === 0 ? "HOST_ROUTE_VERIFIED" : "NETWORK_DEGRADED",
        at: eventAt,
        ...(latestError ? { errorCode: latestError.code } : {}),
      }],
    };
    status.set(deviceId, entry);

    return entry;
  }

  function recordInfrastructureCheck(deviceId, { proxyResult, route, generation = generations.get(deviceId) ?? 0 }) {
    if (generation !== (generations.get(deviceId) ?? 0)) return getStatus(deviceId);
    const routeReady = route?.state === "routed";
    const message = routeReady
      ? "The proxy and local route are healthy. A device-originated egress probe is still required before this phone can be marked protected."
      : "The proxy is healthy, but this phone does not currently have a verified active route.";
    const entry = {
      ...emptyStatus(),
      networkHostObservedIpv4: proxyResult.publicIpv4,
      networkCheckedAt: proxyResult.checkedAt,
      networkVerified: false,
      networkMismatch: routeReady ? false : true,
      networkMismatchReason: message,
      networkHostObservedRegion: proxyResult.country,
      networkProxyHealthy: proxyResult.status === "healthy",
      networkRouteMatch: routeReady,
      networkVerificationLevel: "proxy-and-host-route",
      networkProtectionState: routeReady ? "VERIFYING" : "FAILED",
      networkVerificationMessage: message,
      networkLatestError: routeReady ? null : diagnosticError("V204", { why: message }),
      networkDiagnosticEvents: [{ type: "PROXY_TEST_SUCCEEDED", at: proxyResult.checkedAt }, {
        type: routeReady ? "NETWORK_VERIFY_STARTED" : "NETWORK_DEGRADED",
        at: proxyResult.checkedAt,
        ...(routeReady ? {} : { errorCode: "V204" }),
      }],
    };
    status.set(deviceId, entry);
    return entry;
  }

  function invalidate(deviceId, reason = "Network route or proxy assignment changed; run a new device network check.") {
    generations.set(deviceId, (generations.get(deviceId) ?? 0) + 1);
    const previous = getStatus(deviceId);
    const entry = {
      ...previous,
      networkCheckedAt: null,
      networkVerified: false,
      networkMismatch: false,
      networkMismatchReason: reason,
      networkProtectionState: "VERIFYING",
      networkVerificationMessage: reason,
      networkVerificationLevel: null,
      networkLatestError: diagnosticError("V204", { why: reason }),
    };
    status.set(deviceId, entry);
    return entry;
  }

  function getGeneration(deviceId) { return generations.get(deviceId) ?? 0; }

  return { checkDevice, getStatus, recordInfrastructureCheck, invalidate, getGeneration };
}

export { createNetworkVerifier };
