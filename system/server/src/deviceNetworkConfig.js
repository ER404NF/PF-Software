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

const EGRESS_TYPES = Object.freeze(["cellular-sim", "vlan-proxy"]);

// Throws with a specific, actionable message rather than letting a malformed
// entry surface as a cryptic TypeError somewhere downstream — the network
// block, when present, describes a real physical assignment (which SIM,
// which VLAN) that's worth catching a typo in at load time.
function parseNetworkConfig(raw, deviceId) {
  if (raw == null) return null;

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`devices.config.json: device "${deviceId}" has an invalid network block (must be an object)`);
  }
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
  if (raw.controlIface !== "usb") {
    throw new Error(
      `devices.config.json: device "${deviceId}" has network.controlIface "${raw.controlIface}" (only "usb" is supported — the WDA control channel is unaffected by egress isolation)`
    );
  }

  return {
    egress: raw.egress,
    vlanId: raw.egress === "vlan-proxy" ? raw.vlanId : null,
    simIccid: raw.egress === "cellular-sim" ? raw.simIccid : null,
    controlIface: raw.controlIface,
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
  return `vlan:${network.vlanId}`;
}

export { EGRESS_TYPES, parseNetworkConfig, loadDeviceNetworkMap, egressIdentity };
