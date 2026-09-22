import { proxyForDevice, decryptProxyPassword } from "./proxyPool.js";
import { allocateTunIface, listAllInterfaces as defaultListAllInterfaces, discoverTunPeer as defaultDiscoverTunPeer } from "./tunManager.js";
import { generatePfRuleset, parsePfCounters } from "./pfRuleGenerator.js";
import { diagnosticError } from "./errorCatalog.js";

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
  PF_CLEANUP_ERROR: "pf_cleanup_error",
  ROUTED: "routed",
  STOPPING: "stopping",
  STOP_ERROR: "stop_error",
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
const DEFAULT_RECOVERY_DELAY_MS = 1000;
const MAX_AUTOMATIC_RECOVERIES = 2;

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
    recoveryDelayMs = DEFAULT_RECOVERY_DELAY_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
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
    this.recoveryDelayMs = recoveryDelayMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.routes = new Map(); // deviceId -> { state, usbIp, tunIface, tunPeer, proxyId, lastError, lastPackets?, lastHealthCheckAt? }
    this.startPromises = new Map(); // deviceId -> in-flight setup, shared by duplicate admin requests
    this.stopPromises = new Map(); // deviceId -> in-flight teardown, shared by duplicate admin requests
    this.healthCheckTimer = null;
    this.recoveryTimers = new Map();
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

  _recordEvent(deviceId, type, detail = {}) {
    const current = this.routes.get(deviceId);
    if (!current) return;
    const diagnosticEvents = [...(current.diagnosticEvents || []), {
      type,
      at: new Date().toISOString(),
      ...detail,
    }].slice(-50);
    this.routes.set(deviceId, { ...current, diagnosticEvents });
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

  _desiredBlockedIps(excludeDeviceId = null) {
    const ips = [];
    for (const [deviceId, route] of this.routes) {
      if (deviceId === excludeDeviceId || !route.usbIp) continue;
      if ([ROUTING_STATES.ROUTE_LOST, ROUTING_STATES.TUN_ERROR, ROUTING_STATES.PF_SYNTAX_ERROR,
        ROUTING_STATES.PF_CLEANUP_ERROR].includes(route.state)) ips.push(route.usbIp);
    }
    return ips;
  }

  async _applyPfRuleset(devices, blockedIps = this._desiredBlockedIps()) {
    const ruleset = generatePfRuleset({ bridgeIface: this.bridgeIface, devices, blockedIps });
    const test = await this.privilegedOps.testRuleset(ruleset);
    if (!test.ok) {
      const error = new Error(`PF syntax check failed: ${test.error}`);
      error.pfSyntaxError = true;
      throw error;
    }
    await this.privilegedOps.loadRuleset(ruleset);
  }

  async _removeDeviceFromPf(deviceId) {
    const remaining = this._desiredPfDevices(deviceId);
    const blocked = this._desiredBlockedIps(deviceId);
    if (remaining.length > 0 || blocked.length > 0) {
      await this._applyPfRuleset(remaining, blocked);
    } else {
      await this.privilegedOps.clearAnchor();
    }
  }

  // `usbIp` must already be resolved (see the class-level comment).
  async startRouting(deviceId, options) {
    const inFlight = this.startPromises.get(deviceId);
    if (inFlight) return inFlight;
    const operation = (async () => {
      const stopping = this.stopPromises.get(deviceId);
      if (stopping) await stopping;
      return this._startRouting(deviceId, options);
    })();
    this.startPromises.set(deviceId, operation);
    try {
      return await operation;
    } finally {
      if (this.startPromises.get(deviceId) === operation) this.startPromises.delete(deviceId);
    }
  }

  async _startRouting(deviceId, { usbIp }) {
    if (typeof usbIp !== "string" || !usbIp) throw new Error("startRouting requires a known usbIp");

    const active = this.routes.get(deviceId);
    const wasRecovering = active?.state === ROUTING_STATES.ROUTE_LOST;
    if (active?.state === ROUTING_STATES.ROUTED) {
      if (active.usbIp === usbIp) return active;
      const error = new Error("routing is already active for this device; stop it before changing its USB IP");
      error.status = 409;
      throw error;
    }
    if (active) this.tunManager.stop(deviceId);

    const proxyRecord = proxyForDevice(this.proxyPoolStorePath, deviceId);
    if (!proxyRecord) throw new Error("no pool proxy is assigned to this device — assign one before starting routing");
    this._setState(deviceId, ROUTING_STATES.PROXY_LEASED, { usbIp, proxyId: proxyRecord.id });

    // Everything from here on can fail and must land in TUN_ERROR/
    // PF_SYNTAX_ERROR rather than leaving the route stuck at PROXY_LEASED
    // with no recorded error — interface discovery/allocation included,
    // not just the tunnel/PF steps below.
    let pfLoaded = false;
    try {
      const existingIfaces = await this.listAllInterfaces();
      const previousTunIface = this.routes.get(deviceId)?.tunIface ?? null;
      const tunIface = allocateTunIface({
        existingIfaces, preferred: previousTunIface, rangeStart: this.tunPortRangeStart, rangeEnd: this.tunPortRangeEnd,
      });
      this._setState(deviceId, ROUTING_STATES.TUN_STARTING, { usbIp, proxyId: proxyRecord.id, tunIface });
      this._recordEvent(deviceId, "TUNNEL_STARTING");

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
      this._recordEvent(deviceId, "TUNNEL_READY");

      this._setState(deviceId, ROUTING_STATES.PF_APPLYING, { usbIp, proxyId: proxyRecord.id, tunIface, tunPeer: peer.peerIp });
      this._recordEvent(deviceId, "PF_APPLY_STARTED");
      await this._applyPfRuleset(this._desiredPfDevices());
      pfLoaded = true;
      this._recordEvent(deviceId, "PF_APPLY_SUCCEEDED");
      await this.privilegedOps.clearState(usbIp);

      const routed = this._setState(deviceId, ROUTING_STATES.ROUTED, {
        usbIp, proxyId: proxyRecord.id, tunIface, tunPeer: peer.peerIp,
        failClosed: true, recoveryAttempts: 0, protected: false,
      });
      this._recordEvent(deviceId, wasRecovering ? "NETWORK_RECOVERED" : "NETWORK_ROUTE_READY",
        { verification: "device_egress_required" });
      return this.routes.get(deviceId) ?? routed;
    } catch (error) {
      let reportedError = error;
      let state = error.pfSyntaxError ? ROUTING_STATES.PF_SYNTAX_ERROR : ROUTING_STATES.TUN_ERROR;
      if (pfLoaded) {
        try {
          // Remove a rule that was installed for a route that never reached
          // ROUTED while its tunnel is still alive. This avoids leaving PF
          // pointed at a dead interface after a later setup step fails.
          await this._removeDeviceFromPf(deviceId);
        } catch (cleanupError) {
          reportedError = new Error(`${error.message}; PF rollback failed: ${cleanupError.message}`, { cause: error });
          state = ROUTING_STATES.PF_CLEANUP_ERROR;
        }
      }
      this.tunManager.stop(deviceId);
      this._setError(deviceId, state, reportedError.message);
      this._recordEvent(deviceId, state === ROUTING_STATES.PF_SYNTAX_ERROR || pfLoaded
        ? "PF_APPLY_FAILED" : "TUNNEL_FAILED", { errorCode: state === ROUTING_STATES.PF_SYNTAX_ERROR ? "F201" : "T202" });
      try { await this._applyFailClosed(deviceId); } catch { /* the original setup error remains primary */ }
      throw reportedError;
    }
  }

  async stopRouting(deviceId) {
    const inFlight = this.stopPromises.get(deviceId);
    if (inFlight) return inFlight;
    const operation = (async () => {
      const starting = this.startPromises.get(deviceId);
      if (starting) {
        try { await starting; } catch { /* tear down whatever the failed setup left behind */ }
      }
      return this._stopRouting(deviceId);
    })();
    this.stopPromises.set(deviceId, operation);
    try {
      return await operation;
    } finally {
      if (this.stopPromises.get(deviceId) === operation) this.stopPromises.delete(deviceId);
    }
  }

  async _stopRouting(deviceId) {
    const route = this.routes.get(deviceId);
    if (!route) {
      // A supervisor/process-manager race can leave a tunnel alive after its
      // in-memory route record has already disappeared. Stopping an unknown
      // route is therefore also a cheap defensive process cleanup.
      this.tunManager.stop(deviceId);
      return;
    }
    // Keep the route until privileged cleanup succeeds. STOPPING is ignored
    // by both health checks and desired-PF generation, so concurrent work
    // cannot resurrect it or retain its rule. If cleanup fails, preserving
    // the route makes a later stopRouting() call able to retry the removal.
    this._setState(deviceId, ROUTING_STATES.STOPPING);
    const recoveryTimer = this.recoveryTimers.get(deviceId);
    if (recoveryTimer) this.clearTimeoutFn(recoveryTimer);
    this.recoveryTimers.delete(deviceId);
    this.tunManager.stop(deviceId);
    try {
      await this._removeDeviceFromPf(deviceId);
      if (route.usbIp) await this.privilegedOps.clearState(route.usbIp);
    } catch (error) {
      this._setError(deviceId, ROUTING_STATES.STOP_ERROR, error.message);
      throw error;
    }
    this.routes.delete(deviceId);
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

      const tunnelState = this.tunManager.getStatus?.(deviceId)?.state;
      if ((tunnelState && tunnelState !== "running") || (!tunnelState && !this.tunManager.isRunning(deviceId))) {
        await this._handleRouteLost(deviceId, "T206", "tunnel process is no longer running");
        continue;
      }
      if (counters === null) continue;

      const entry = counters.find(c => c.usbIp === route.usbIp);
      if (!entry) {
        await this._handleRouteLost(deviceId, "F203", "this device's PF rule is no longer loaded in the anchor");
        continue;
      }
      this.routes.set(deviceId, { ...route, lastPackets: entry.packets, lastHealthCheckAt: new Date().toISOString() });
      this.onStateChanged(deviceId, this.routes.get(deviceId));
    }
  }

  async _applyFailClosed(deviceId) {
    const route = this.routes.get(deviceId);
    if (!route?.usbIp) return;
    const routed = this._desiredPfDevices(deviceId);
    const blocked = [...new Set([...this._desiredBlockedIps(deviceId), route.usbIp])];
    await this._applyPfRuleset(routed, blocked);
    const current = this.routes.get(deviceId);
    if (current) {
      this.routes.set(deviceId, { ...current, failClosed: true, internetBlocked: true, protected: false });
      this.onStateChanged(deviceId, this.routes.get(deviceId));
      this._recordEvent(deviceId, "INTERNET_FAIL_CLOSED");
    }
  }

  async _handleRouteLost(deviceId, code, message) {
    const route = this.routes.get(deviceId);
    if (!route || route.state !== ROUTING_STATES.ROUTED) return;
    const detail = diagnosticError(code, { why: message, technical: { usbIp: route.usbIp } });
    this._setError(deviceId, ROUTING_STATES.ROUTE_LOST, detail.name);
    this.routes.set(deviceId, {
      ...this.routes.get(deviceId), latestError: detail, protected: false,
      recoveryAttempts: route.recoveryAttempts ?? 0,
    });
    this._recordEvent(deviceId, "NETWORK_DEGRADED", { errorCode: code });
    try {
      await this._applyFailClosed(deviceId);
    } catch (error) {
      const pf = diagnosticError("F202", { why: error.message });
      this.routes.set(deviceId, { ...this.routes.get(deviceId), latestError: pf, internetBlocked: false });
      this.onStateChanged(deviceId, this.routes.get(deviceId));
      return;
    }
    this._scheduleRecovery(deviceId);
  }

  async quarantineRoute(deviceId, { code = "V204", why = "End-to-end verification could not prove the protected route." } = {}) {
    const route = this.routes.get(deviceId);
    if (!route?.usbIp) return null;
    const detail = diagnosticError(code, { why, technical: { routeState: route.state } });
    this._setError(deviceId, ROUTING_STATES.ROUTE_LOST, detail.name);
    this.routes.set(deviceId, {
      ...this.routes.get(deviceId),
      latestError: detail,
      protected: false,
      recoveryAttempts: route.recoveryAttempts ?? 0,
    });
    this._recordEvent(deviceId, "NETWORK_DEGRADED", { errorCode: detail.code });
    try {
      await this._applyFailClosed(deviceId);
    } finally {
      // Even if PF itself is unavailable, stop the tunnel so an existing
      // route-to rule cannot keep forwarding through an unverified exit.
      this.tunManager.stop(deviceId);
    }
    this.onStateChanged(deviceId, this.routes.get(deviceId));
    return this.routes.get(deviceId);
  }

  _scheduleRecovery(deviceId) {
    if (this.recoveryTimers.has(deviceId)) return;
    const route = this.routes.get(deviceId);
    if (!route || route.state !== ROUTING_STATES.ROUTE_LOST) return;
    const attempts = route.recoveryAttempts ?? 0;
    if (attempts >= MAX_AUTOMATIC_RECOVERIES) return;
    const timer = this.setTimeoutFn(async () => {
      this.recoveryTimers.delete(deviceId);
      const current = this.routes.get(deviceId);
      if (!current || current.state !== ROUTING_STATES.ROUTE_LOST) return;
      this.routes.set(deviceId, { ...current, recoveryAttempts: attempts + 1 });
      this._recordEvent(deviceId, "NETWORK_RECOVERY_STARTED", { attempt: attempts + 1 });
      this.tunManager.stop(deviceId);
      try {
        await this.startRouting(deviceId, { usbIp: current.usbIp });
      } catch (error) {
        const latest = this.routes.get(deviceId) ?? current;
        this.routes.set(deviceId, {
          ...latest,
          state: ROUTING_STATES.ROUTE_LOST,
          recoveryAttempts: attempts + 1,
          lastError: error.message,
          protected: false,
        });
        try { await this._applyFailClosed(deviceId); } catch { /* remains explicitly unprotected */ }
        this.onStateChanged(deviceId, this.routes.get(deviceId));
        this._scheduleRecovery(deviceId);
      }
    }, this.recoveryDelayMs);
    timer.unref?.();
    this.recoveryTimers.set(deviceId, timer);
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
    for (const timer of this.recoveryTimers.values()) this.clearTimeoutFn(timer);
    this.recoveryTimers.clear();
  }
}
