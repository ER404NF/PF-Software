// Phase 0 of per-phone network isolation (source-material/Client Account
// Separation — Technical Reference (REDACTED).md §3.5: "IP is strong
// evidence when it is stable and unusual — a static ... IP seen on twenty
// otherwise unrelated accounts is a very clear signal"). This is legitimate
// network infrastructure for keeping separately-authorized client accounts
// apart, not fingerprint spoofing or platform-detection evasion — those
// remain out of scope per CLAUDE.md's non-goals.
//
// Loaded from devices.config.json's new optional per-device `network` block,
// the same file (and, below, the same loading style) devices.config.json's
// `devices` array already uses — see index.js's loadDevices(). Real hardware
// (SIMs, VLANs, routers — Phases 1-3) doesn't exist yet, so `network` is
// optional per device: a device with none is simply "not yet assigned,"
// which is the expected state for every device today.
//
// EGRESS is the phone's actual outbound path:
//   - "cellular-sim": the phone's own carrier SIM is its egress — the
//     isolation boundary is the SIM itself, identified by simIccid.
//   - "vlan-proxy": a Wi-Fi-only phone routes through a dedicated LTE
//     modem+SIM shared by every phone on the same vlanId — the isolation
//     boundary is the VLAN, identified by vlanId (phones on the same vlanId
//     are *expected* to share an egress IP; phones on different vlanId/
//     simIccid are not — see networkVerifier.js).
// controlIface is always "usb" today: WDA's control channel goes over the
// existing USB iproxy tunnel regardless of egress, unrelated to and
// unaffected by this work — this field just records that fact per device.

import { isIP } from "node:net";

const EGRESS_TYPES = Object.freeze([
  "direct-wifi",
  "cellular-sim",
  "commercial-proxy",
  "self-hosted-proxy",
  "network-gateway",
  "vlan-proxy",
]);
const IPV6_POLICIES = new Set(["unspecified", "allowed", "blocked", "required"]);
const FAIL_POLICIES = new Set(["fail-open", "fail-closed"]);
const INLINE_SECRET = /(password|token|secret|api.?key|private.?key)$/i;

function optionalText(value, field, maximum = 200) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`network.${field} must be a non-empty string`);
  return value.trim();
}

function safeCheckUrl(value) {
  if (value == null) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error("network.checkUrl must be a valid URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("network.checkUrl must use http/https without embedded credentials");
  }
  return url.toString();
}

// Throws with a specific, actionable message rather than letting a malformed
// entry surface as a cryptic TypeError somewhere downstream — the network
// block, when present, describes a real physical assignment (which SIM,
// which VLAN) that's worth catching a typo in at load time.
function parseNetworkConfig(raw, deviceId) {
  if (raw == null) return null;

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`devices.config.json: device "${deviceId}" has an invalid network block (must be an object)`);
  }
  const secretKey = Object.keys(raw).find(key => INLINE_SECRET.test(key));
  if (secretKey) throw new Error(`devices.config.json: device "${deviceId}" stores secret material in network.${secretKey}; use an environment-variable reference instead`);
  if (!EGRESS_TYPES.includes(raw.egress)) {
    throw new Error(
      `devices.config.json: device "${deviceId}" has an invalid network.egress "${raw.egress}" (must be one of: ${EGRESS_TYPES.join(", ")})`
    );
  }
  if (raw.egress === "cellular-sim" && (typeof raw.simIccid !== "string" || raw.simIccid.trim().length === 0)) {
    throw new Error(`devices.config.json: device "${deviceId}" has egress "cellular-sim" but no simIccid`);
  }
  if (raw.egress === "vlan-proxy" && (typeof raw.vlanId !== "string" || raw.vlanId.trim().length === 0)) {
    throw new Error(`devices.config.json: device "${deviceId}" has egress "vlan-proxy" but no vlanId`);
  }
  if (["commercial-proxy", "self-hosted-proxy"].includes(raw.egress)
    && (typeof raw.profileId !== "string" || raw.profileId.trim().length === 0)) {
    throw new Error(`devices.config.json: device "${deviceId}" has egress "${raw.egress}" but no profileId`);
  }
  if (["direct-wifi", "network-gateway"].includes(raw.egress)
    && (typeof raw.gatewayId !== "string" || raw.gatewayId.trim().length === 0)) {
    throw new Error(`devices.config.json: device "${deviceId}" has egress "${raw.egress}" but no gatewayId`);
  }
  if (raw.controlIface !== "usb") {
    throw new Error(
      `devices.config.json: device "${deviceId}" has network.controlIface "${raw.controlIface}" (only "usb" is supported — the WDA control channel is unaffected by egress isolation)`
    );
  }

  const expectedPublicIpv4 = optionalText(raw.expectedPublicIpv4, "expectedPublicIpv4", 45);
  if (expectedPublicIpv4 && isIP(expectedPublicIpv4) !== 4) throw new Error("network.expectedPublicIpv4 must be an IPv4 address");
  const expectedIpv6Policy = raw.expectedIpv6Policy ?? "unspecified";
  if (!IPV6_POLICIES.has(expectedIpv6Policy)) throw new Error(`network.expectedIpv6Policy must be one of: ${[...IPV6_POLICIES].join(", ")}`);
  const failPolicy = raw.failPolicy ?? "fail-closed";
  if (!FAIL_POLICIES.has(failPolicy)) throw new Error("network.failPolicy must be fail-open or fail-closed");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("network.enabled must be a boolean");

  return {
    egress: raw.egress,
    vlanId: raw.egress === "vlan-proxy" ? raw.vlanId.trim() : null,
    simIccid: raw.egress === "cellular-sim" ? raw.simIccid.trim() : null,
    profileId: ["commercial-proxy", "self-hosted-proxy"].includes(raw.egress) ? raw.profileId.trim() : null,
    gatewayId: ["direct-wifi", "network-gateway"].includes(raw.egress) ? raw.gatewayId.trim() : null,
    controlIface: raw.controlIface,
    enabled: raw.enabled !== false,
    failPolicy,
    providerLabel: optionalText(raw.providerLabel, "providerLabel"),
    gatewayLabel: optionalText(raw.gatewayLabel, "gatewayLabel"),
    configuredRegion: optionalText(raw.configuredRegion, "configuredRegion", 100),
    expectedPublicIpv4,
    expectedIpv6Policy,
    credentialEnv: optionalText(raw.credentialEnv, "credentialEnv", 100),
    checkUrl: safeCheckUrl(raw.checkUrl),
  };
}

function publicNetworkConfig(network) {
  if (!network) return null;
  return {
    egress: network.egress,
    enabled: network.enabled !== false,
    failPolicy: network.failPolicy ?? "fail-closed",
    providerLabel: network.providerLabel ?? null,
    gatewayLabel: network.gatewayLabel ?? null,
    configuredRegion: network.configuredRegion ?? null,
    expectedPublicIpv4: network.expectedPublicIpv4 ?? null,
    expectedIpv6Policy: network.expectedIpv6Policy ?? "unspecified",
    simIdentifierSuffix: network.simIccid ? network.simIccid.slice(-4) : null,
    controlIface: network.controlIface,
  };
}

// deviceId -> parsed network config, or null for a device with no `network`
// block yet. Mirrors loadDevices()'s own raw-JSON-in, Map-out shape.
function loadDeviceNetworkMap(raw) {
  const map = new Map();
  for (const d of raw.devices ?? []) {
    map.set(d.id, parseNetworkConfig(d.network, d.id));
  }
  return map;
}

// The identity a device's observed egress IP is checked against for
// collisions (networkVerifier.js): two devices assigned to the *same*
// identity are expected to share an IP (same SIM, or same VLAN's shared
// modem); two devices with *different* identities sharing an IP is the
// isolation failure this Phase 0 work exists to catch.
function egressIdentity(network) {
  if (!network) return null;
  if (network.egress === "cellular-sim") return `sim:${network.simIccid}`;
  if (network.egress === "vlan-proxy") return `vlan:${network.vlanId}`;
  if (["commercial-proxy", "self-hosted-proxy"].includes(network.egress)) return `proxy:${network.profileId}`;
  return `gateway:${network.gatewayId}`;
}

export { EGRESS_TYPES, parseNetworkConfig, loadDeviceNetworkMap, egressIdentity, publicNetworkConfig };
