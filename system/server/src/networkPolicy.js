const DEFAULT_NETWORK_VERIFICATION_MAX_AGE_MS = 15 * 60 * 1000;

export function networkVerificationMaxAge(value = process.env.NETWORK_VERIFICATION_MAX_AGE_MS) {
  if (value == null || value === "") return DEFAULT_NETWORK_VERIFICATION_MAX_AGE_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 24 * 60 * 60 * 1000) {
    throw new Error("NETWORK_VERIFICATION_MAX_AGE_MS must be an integer from 1000 to 86400000");
  }
  return parsed;
}

export function networkAccessDecision({ network, status, now = new Date(), maxAgeMs = DEFAULT_NETWORK_VERIFICATION_MAX_AGE_MS } = {}) {
  if (!network) return { allowed: true, state: "network_unassigned", reason: null };
  const failClosed = (network.failPolicy ?? "fail-closed") === "fail-closed";
  const proxyDisabled = ["commercial-proxy", "self-hosted-proxy", "vlan-proxy"].includes(network.egress)
    && network.enabled === false;

  let blocked = null;
  if (proxyDisabled) {
    blocked = { state: "proxy_disabled", reason: "This phone is blocked because its proxy assignment is disabled." };
  } else if (!status?.networkCheckedAt) {
    blocked = { state: "network_not_verified", reason: "This phone is blocked until its network route passes verification." };
  } else if (status.networkVerified !== true) {
    blocked = {
      state: status.networkMismatch ? "network_mismatch" : "network_verification_failed",
      reason: "This phone is blocked because its network route failed verification. Check the proxy or gateway, run the network check again, or use another phone.",
    };
  } else {
    const checkedAt = Date.parse(status.networkCheckedAt);
    const ageMs = now.getTime() - checkedAt;
    if (!Number.isFinite(checkedAt) || ageMs < 0 || ageMs > maxAgeMs) {
      blocked = { state: "network_verification_stale", reason: "This phone is blocked because its network verification is stale. Run the network check again." };
    }
  }

  if (!blocked) return { allowed: true, state: "network_verified", reason: null };
  return failClosed ? { allowed: false, ...blocked } : { allowed: true, degraded: true, ...blocked };
}

export { DEFAULT_NETWORK_VERIFICATION_MAX_AGE_MS };
