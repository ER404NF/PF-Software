import { proxyForDevice, decryptProxyPassword } from "./proxyPool.js";
import { allocateTunIface, listAllInterfaces as defaultListAllInterfaces, discoverTunPeer as defaultDiscoverTunPeer } from "./tunManager.js";
import { generatePfRuleset, parsePfCounters } from "./pfRuleGenerator.js";

// Drives the automatable portion of the Automation Architecture guide's
// §5 device state machine, for devices that already have a leased pool
// proxy: PROXY_LEASED -> TUN_STARTING -> PF_APPLYING -> ROUTED, with the
// guide's own error states (TUN_ERROR, PF_SYNTAX_ERROR) instead of ever
// guessing past a failure.
//
// Deliberately NOT included here: NETWORK_MAPPING (binding a UDID to its
// USB bridge member) and USB-IP discovery. Both are inherently a
// human-paced, one-phone-at-a-time workflow (guide §4.4/§7 — Internet
// Sharing is enabled per phone, then the bridge diff is captured), not
// something a continuous background loop can safely do on its own. This
// orchestrator takes the resulting `usbIp` as an already-known input, the
// same way it takes an already-leased pool proxy as an input rather than
// leasing one itself.
export const ROUTING_STATES = Object.freeze({
  PROXY_LEASED: "proxy_leased",
  TUN_STARTING: "tun_starting",
  TUN_ERROR: "tun_error",
  PF_APPLYING: "pf_applying",
  PF_SYNTAX_ERROR: "pf_syntax_error",
  ROUTED: "routed",
  // A device that reached ROUTED and then lost either its tunnel process
  // or its loaded PF rule outside of a deliberate stopRouting() call
  // (guide §5's HEALTH_CHECKING -> NETWORK_ERROR -> RECOVER_ROUTE
  // transition) — distinct from TUN_ERROR/PF_SYNTAX_ERROR, which are
  // setup-time failures, not a regression from an already-working state.
  ROUTE_LOST: "route_lost",
});

const PEER_DISCOVERY_ATTEMPTS = 5;
const PEER_DISCOVERY_DELAY_MS = 500;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class NetworkRoutingOrchestrator {
  constructor({
    proxyPoolStorePath,
    proxyCredentialEncryptionKey,
    tunManager,
    privilegedOps,
    bridgeIface,
    tunPortRangeStart = 0,
    tunPortRangeEnd = 63,
    listAllInterfaces = defaultListAllInterfaces,
    discoverTunPeer = defaultDiscoverTunPeer,
    onStateChanged = () => {},
  }) {
    if (!bridgeIface) throw new Error("bridgeIface is required");
    this.proxyPoolStorePath = proxyPoolStorePath;
    this.proxyCredentialEncryptionKey = proxyCredentialEncryptionKey;
    this.tunManager = tunManager;
    this.privilegedOps = privilegedOps;
    this.bridgeIface = bridgeIface;
    this.tunPortRangeStart = tunPortRangeStart;
    this.tunPortRangeEnd = tunPortRangeEnd;
    this.listAllInterfaces = listAllInterfaces;
    this.discoverTunPeer = discoverTunPeer;
    this.onStateChanged = onStateChanged;
    this.routes = new Map(); // deviceId -> { state, usbIp, tunIface, tunPeer, proxyId, lastError, lastPackets?, lastHealthCheckAt? }
    this.healthCheckTimer = null;
  }

  getRoute(deviceId) {
    return this.routes.get(deviceId) ?? null;
  }

  _setState(deviceId, state, patch = {}) {
    const current = this.routes.get(deviceId) ?? {};
    const next = { ...current, ...patch, state, lastError: null };
    this.routes.set(deviceId, next);
    this.onStateChanged(deviceId, next);
    return next;
  }

  _setError(deviceId, state, message) {
    const current = this.routes.get(deviceId) ?? {};
    const next = { ...current, state, lastError: message };
    this.routes.set(deviceId, next);
    this.onStateChanged(deviceId, next);
    return next;
  }

  // Full-replace regeneration for every device currently at PF_APPLYING or
  // ROUTED (guide §6: "PF rules should be generated from the full current
  // desired state ... rather than incrementally appending ad hoc lines").
  // `excludeDeviceId` lets stopRouting() compute what the ruleset should
  // look like with that device already removed, before actually removing it.
  _desiredPfDevices(excludeDeviceId = null) {
    const devices = [];
    for (const [deviceId, route] of this.routes) {
      if (deviceId === excludeDeviceId) continue;
      if (route.state !== ROUTING_STATES.PF_APPLYING && route.state !== ROUTING_STATES.ROUTED) continue;
      devices.push({ usbIp: route.usbIp, tunIface: route.tunIface, tunPeer: route.tunPeer });
    }
    return devices;
  }

  async _applyPfRuleset(devices) {
    const ruleset = generatePfRuleset({ bridgeIface: this.bridgeIface, devices });
    const test = await this.privilegedOps.testRuleset(ruleset);
    if (!test.ok) {
      const error = new Error(`PF syntax check failed: ${test.error}`);
      error.pfSyntaxError = true;
      throw error;
    }
    await this.privilegedOps.loadRuleset(ruleset);
  }

  // `usbIp` must already be resolved (see the class-level comment).
  async startRouting(deviceId, { usbIp }) {
    if (typeof usbIp !== "string" || !usbIp) throw new Error("startRouting requires a known usbIp");

    const proxyRecord = proxyForDevice(this.proxyPoolStorePath, deviceId);
    if (!proxyRecord) throw new Error("no pool proxy is assigned to this device — assign one before starting routing");
    this._setState(deviceId, ROUTING_STATES.PROXY_LEASED, { usbIp, proxyId: proxyRecord.id });

    // Everything from here on can fail and must land in TUN_ERROR/
    // PF_SYNTAX_ERROR rather than leaving the route stuck at PROXY_LEASED
    // with no recorded error — interface discovery/allocation included,
    // not just the tunnel/PF steps below.
    try {
      const existingIfaces = await this.listAllInterfaces();
      const previousTunIface = this.routes.get(deviceId)?.tunIface ?? null;
      const tunIface = allocateTunIface({
        existingIfaces, preferred: previousTunIface, rangeStart: this.tunPortRangeStart, rangeEnd: this.tunPortRangeEnd,
      });
      this._setState(deviceId, ROUTING_STATES.TUN_STARTING, { usbIp, proxyId: proxyRecord.id, tunIface });

      const password = decryptProxyPassword(proxyRecord, this.proxyCredentialEncryptionKey);
      this.tunManager.start({
        deviceId, tunIface,
        proxy: { protocol: proxyRecord.protocol, host: proxyRecord.host, port: proxyRecord.port, username: proxyRecord.username, password },
      });

      let peer = null;
      for (let attempt = 0; attempt < PEER_DISCOVERY_ATTEMPTS && !peer; attempt++) {
        if (attempt > 0) await wait(PEER_DISCOVERY_DELAY_MS);
        try {
          peer = await this.discoverTunPeer({ tunIface });
        } catch {
          // Interface may not be up yet — retried up to the bounded attempt count.
        }
      }
      if (!peer) throw new Error(`tunnel interface ${tunIface} never reported a peer address`);

      this._setState(deviceId, ROUTING_STATES.PF_APPLYING, { usbIp, proxyId: proxyRecord.id, tunIface, tunPeer: peer.peerIp });
      await this._applyPfRuleset(this._desiredPfDevices());
      await this.privilegedOps.clearState(usbIp);

      return this._setState(deviceId, ROUTING_STATES.ROUTED, { usbIp, proxyId: proxyRecord.id, tunIface, tunPeer: peer.peerIp });
    } catch (error) {
      this.tunManager.stop(deviceId);
      const state = error.pfSyntaxError ? ROUTING_STATES.PF_SYNTAX_ERROR : ROUTING_STATES.TUN_ERROR;
      this._setError(deviceId, state, error.message);
      throw error;
    }
  }

  async stopRouting(deviceId) {
    const route = this.routes.get(deviceId);
    // Deleted before any await (and before tunManager.stop(), which is what
    // makes isRunning() go false) so a health-check tick that interleaves
    // with this teardown sees the device as already gone rather than
    // "ROUTED but its tunnel just died" — checkHealth()'s own `!route`
    // guard then skips it instead of emitting a spurious ROUTE_LOST for a
    // deliberate stop. _desiredPfDevices() below doesn't need the entry
    // still present; it excludes `deviceId` explicitly either way.
    this.routes.delete(deviceId);
    this.tunManager.stop(deviceId);
    if (!route) return;
    const remaining = this._desiredPfDevices(deviceId);
    if (remaining.length > 0) {
      await this._applyPfRuleset(remaining);
    } else {
      await this.privilegedOps.clearAnchor();
    }
    if (route.usbIp) await this.privilegedOps.clearState(route.usbIp);
    this.onStateChanged(deviceId, null);
  }

  // Guide §4.10 HealthCheckService, the two automatable checks: "tunnel
  // process alive" and "generated device rule is loaded" — deliberately
  // NOT "packet counters increase" as a pass/fail signal, since a
  // legitimately idle device would false-positive as unhealthy; the raw
  // counter is still recorded on the route as informational data (also
  // useful for the guide's commissioning-time "counters increase after
  // traffic" check, done manually/by a future diagnostic, not by this
  // periodic loop guessing about idle vs. broken).
  async checkHealth() {
    const routedIds = [...this.routes.entries()]
      .filter(([, route]) => route.state === ROUTING_STATES.ROUTED)
      .map(([deviceId]) => deviceId);
    if (routedIds.length === 0) return;

    let counters = null;
    try {
      counters = parsePfCounters(await this.privilegedOps.inspectRules());
    } catch {
      counters = null; // can't verify PF this tick — tunnel-liveness check below still runs
    }

    for (const deviceId of routedIds) {
      const route = this.routes.get(deviceId);
      if (!route || route.state !== ROUTING_STATES.ROUTED) continue; // an earlier iteration this same tick already moved it

      if (!this.tunManager.isRunning(deviceId)) {
        this._setError(deviceId, ROUTING_STATES.ROUTE_LOST, "tunnel process is no longer running");
        continue;
      }
      if (counters === null) continue;

      const entry = counters.find(c => c.usbIp === route.usbIp);
      if (!entry) {
        this._setError(deviceId, ROUTING_STATES.ROUTE_LOST, "this device's PF rule is no longer loaded in the anchor");
        continue;
      }
      this.routes.set(deviceId, { ...route, lastPackets: entry.packets, lastHealthCheckAt: new Date().toISOString() });
      this.onStateChanged(deviceId, this.routes.get(deviceId));
    }
  }

  startHealthChecks({ intervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS } = {}) {
    if (this.healthCheckTimer) return;
    void this.checkHealth();
    this.healthCheckTimer = setInterval(() => {
      void this.checkHealth().catch(() => {}); // a failed tick is retried next interval, not thrown into the timer
    }, intervalMs);
    this.healthCheckTimer.unref?.();
  }

  stopHealthChecks() {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = null;
  }
}
