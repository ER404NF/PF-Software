import { proxyForDevice, decryptProxyPassword } from "./proxyPool.js";
import { allocateTunIface, listAllInterfaces as defaultListAllInterfaces, discoverTunPeer as defaultDiscoverTunPeer } from "./tunManager.js";
import { generatePfRuleset, parsePfCounters } from "./pfRuleGenerator.js";
import { diagnosticError } from "./errorCatalog.js";
import { operationalErrorKind } from "./safeOperationalLog.js";
import {
  ROUTING_HOST_STATES,
  RoutingQuarantineStoreError,
  clearRoutingQuarantineState,
  isRoutingHostBlocked,
  readRoutingQuarantineState,
  repairRoutingQuarantineState,
  verifyRoutingQuarantineStorage,
  writeRoutingQuarantineState,
} from "./routingQuarantineStore.js";

export { ROUTING_HOST_STATES } from "./routingQuarantineStore.js";

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
const MAX_PROTECTION_RETRIES = 2;

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
    onHostStateChanged = () => {},
    recoveryDelayMs = DEFAULT_RECOVERY_DELAY_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    quarantineStorePath = null,
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
    this.onHostStateChanged = onHostStateChanged;
    this.recoveryDelayMs = recoveryDelayMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.quarantineStorePath = quarantineStorePath;
    this.routes = new Map(); // deviceId -> { state, usbIp, tunIface, tunPeer, proxyId, lastError, lastPackets?, lastHealthCheckAt? }
    this.startPromises = new Map(); // deviceId -> in-flight setup, shared by duplicate admin requests
    this.stopPromises = new Map(); // deviceId -> in-flight teardown, shared by duplicate admin requests
    this.healthCheckTimer = null;
    this.recoveryTimers = new Map();
    this.reconciliationPromise = null;
    this.reconciled = false;
    this.quarantinePromise = null;
    this.recoveryPromise = null;
    this.repairPromise = null;
    this.hostSetupPromises = new Set();
    this.hostRoutingState = this._loadHostRoutingState();
  }

  _loadHostRoutingState() {
    try {
      const persisted = readRoutingQuarantineState(this.quarantineStorePath, this.bridgeIface);
      if (!persisted) verifyRoutingQuarantineStorage(this.quarantineStorePath);
      return persisted ?? {
        version: 1, state: ROUTING_HOST_STATES.HEALTHY, bridgeIface: this.bridgeIface,
        reasonCode: null, timestamp: null, manualInterventionRequired: false, affectedDeviceIds: [],
        affectedDeviceInventoryComplete: true,
      };
    } catch (error) {
      if (!(error instanceof RoutingQuarantineStoreError)) throw error;
      return {
        version: 1, state: ROUTING_HOST_STATES.RECOVERY_REQUIRED, bridgeIface: this.bridgeIface,
        reasonCode: error.code, timestamp: null, manualInterventionRequired: true, affectedDeviceIds: [],
        affectedDeviceInventoryComplete: false, stateUnreadable: true,
        failureMarkerInvalid: error.failureMarkerInvalid === true,
      };
    }
  }

  getHostRoutingStatus() {
    const state = this.hostRoutingState;
    return {
      state: state.state,
      reasonCode: state.reasonCode,
      timestamp: state.timestamp,
      manualInterventionRequired: state.manualInterventionRequired === true,
      affectedDeviceCount: state.affectedDeviceIds?.length ?? 0,
      bridgeAvailable: state.bridgeAvailable ?? null,
      repairRequired: state.stateUnreadable === true,
      operationInProgress: Boolean(this.quarantinePromise || this.recoveryPromise || this.repairPromise),
    };
  }

  _routingBlockedError() {
    const recovery = this.hostRoutingState.state === ROUTING_HOST_STATES.RECOVERY_REQUIRED;
    const error = new Error(recovery
      ? "routing recovery is required on this host before any phone can be routed"
      : "routing is quarantined on this host until an administrator completes recovery checks");
    error.status = 409;
    error.expose = true;
    error.code = recovery ? "ROUTING_RECOVERY_REQUIRED" : "ROUTING_HOST_QUARANTINED";
    return error;
  }

  _assertHostRoutingAllowed() {
    if (isRoutingHostBlocked(this.hostRoutingState)) throw this._routingBlockedError();
  }

  assertRoutingAvailable() {
    this._assertHostRoutingAllowed();
    return true;
  }

  async runHostRoutingSetup(operation) {
    this._assertHostRoutingAllowed();
    const promise = Promise.resolve().then(async () => {
      this._assertHostRoutingAllowed();
      const result = await operation();
      this._assertHostRoutingAllowed();
      return result;
    });
    this.hostSetupPromises.add(promise);
    try { return await promise; }
    finally { this.hostSetupPromises.delete(promise); }
  }

  _persistHostRoutingState(next) {
    this.hostRoutingState = { ...next };
    const persisted = writeRoutingQuarantineState(this.quarantineStorePath, next, this.bridgeIface);
    this.hostRoutingState = persisted;
    this.onHostStateChanged(this.getHostRoutingStatus());
    return persisted;
  }

  _beginHostQuarantine(deviceId, reasonCode = "F202", { affectedDeviceIds = null, inventoryComplete = true } = {}) {
    if (isRoutingHostBlocked(this.hostRoutingState)) return this.hostRoutingState;
    const completeAffectedIds = [...new Set((affectedDeviceIds ?? [...this.routes.keys(), deviceId]).filter(Boolean))];
    const next = {
      version: 1,
      state: ROUTING_HOST_STATES.QUARANTINING,
      bridgeIface: this.bridgeIface,
      reasonCode,
      timestamp: new Date().toISOString(),
      manualInterventionRequired: true,
      affectedDeviceIds: completeAffectedIds,
      affectedDeviceInventoryComplete: inventoryComplete === true,
    };
    this.hostRoutingState = next;
    try { return this._persistHostRoutingState(next); }
    catch {
      this.hostRoutingState = { ...next, state: ROUTING_HOST_STATES.RECOVERY_REQUIRED,
        reasonCode: "ROUTING_QUARANTINE_PERSIST_FAILED" };
      this.onHostStateChanged(this.getHostRoutingStatus());
      return this.hostRoutingState;
    }
  }

  // This app owns one private PF anchor. Clearing that anchor at first use is
  // safe across restarts and cannot affect foreign PF rules. We deliberately
  // do not signal unknown tun2proxy processes: without persisted exact process
  // identity they are foreign/unproven. A fresh unused utun is allocated later.
  async reconcileStartup() {
    if (this.reconciled) return { reconciled: true };
    if (this.reconciliationPromise) return this.reconciliationPromise;
    const operation = (async () => {
      try {
        if (isRoutingHostBlocked(this.hostRoutingState)) {
          this.reconciled = true;
          return { reconciled: true, routingBlocked: true, hostRouting: this.getHostRoutingStatus() };
        }
        const existingRules = await this.privilegedOps.inspectRules();
        if (String(existingRules || "").trim()) await this.privilegedOps.clearAnchor();
        this.reconciled = true;
        return { reconciled: true };
      } catch (error) {
        const failure = new Error("Bodun could not safely restore its network state; protected routing is unavailable", { cause: error });
        failure.status = 503;
        failure.code = "ROUTING_RECONCILIATION_REQUIRED";
        throw failure;
      }
    })();
    this.reconciliationPromise = operation;
    try { return await operation; } finally {
      if (this.reconciliationPromise === operation) this.reconciliationPromise = null;
    }
  }

  getRoute(deviceId) {
    return this.routes.get(deviceId) ?? null;
  }

  getRouteRecoveryStatus(deviceId) {
    const route = this.routes.get(deviceId);
    if (!route) return null;
    const attempts = route.recoveryAttempts ?? 0;
    return {
      automaticRecoveryPending: this.recoveryTimers.has(deviceId) || this.startPromises.has(deviceId),
      automaticRecoveryExhausted: route.state === ROUTING_STATES.ROUTE_LOST
        && attempts >= MAX_AUTOMATIC_RECOVERIES,
    };
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

  _recordFailure(deviceId, state, code, error) {
    const detail = diagnosticError(code, {
      technical: { errorKind: operationalErrorKind(error) },
    });
    this._setError(deviceId, state, detail.name);
    this.routes.set(deviceId, { ...this.routes.get(deviceId), latestError: detail, protected: false });
    return detail;
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
        ROUTING_STATES.PF_CLEANUP_ERROR, ROUTING_STATES.STOP_ERROR].includes(route.state)) ips.push(route.usbIp);
    }
    return ips;
  }

  async _applyPfRuleset(devices, blockedIps = this._desiredBlockedIps()) {
    this._assertHostRoutingAllowed();
    const ruleset = generatePfRuleset({ bridgeIface: this.bridgeIface, devices, blockedIps });
    const test = await this.privilegedOps.testRuleset(ruleset);
    this._assertHostRoutingAllowed();
    if (!test.ok) {
      const error = new Error(`PF syntax check failed: ${test.error}`);
      error.pfSyntaxError = true;
      throw error;
    }
    await this.privilegedOps.loadRuleset(ruleset);
    this._assertHostRoutingAllowed();
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
    this._assertHostRoutingAllowed();
    await this.reconcileStartup();
    this._assertHostRoutingAllowed();
    const inFlight = this.startPromises.get(deviceId);
    if (inFlight) {
      await options?.authorize?.();
      const result = await inFlight;
      await options?.authorize?.();
      return result;
    }
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

  async _startRouting(deviceId, { usbIp, authorize = null }) {
    if (typeof usbIp !== "string" || !usbIp) throw new Error("startRouting requires a known usbIp");

    await authorize?.();
    this._assertHostRoutingAllowed();

    const active = this.routes.get(deviceId);
    if (active?.deviceQuarantined) {
      const error = new Error("routing is quarantined after a fail-closed bridge shutdown; stop routing and complete the host recovery checks before starting again");
      error.status = 409;
      error.expose = true;
      error.code = "ROUTING_BRIDGE_QUARANTINED";
      throw error;
    }
    const wasRecovering = active?.state === ROUTING_STATES.ROUTE_LOST;
    if (active?.state === ROUTING_STATES.ROUTED) {
      if (active.usbIp === usbIp) return active;
      const error = new Error("routing is already active for this device; stop it before changing its USB IP");
      error.status = 409;
      error.expose = true;
      error.code = "ROUTING_ALREADY_ACTIVE";
      throw error;
    }
    if (active) {
      this._assertHostRoutingAllowed();
      try {
        await this.tunManager.stop(deviceId);
      } catch (error) {
        this._recordFailure(deviceId, ROUTING_STATES.TUN_ERROR, "T202", error);
        this.routes.set(deviceId, {
          ...this.routes.get(deviceId), internetBlocked: false, protectionState: "unverified",
        });
        try { await this._applyFailClosed(deviceId); }
        catch (protectionError) { await this._enforceEmergencyQuarantine(deviceId, protectionError); }
        throw error;
      }
    }

    const proxyRecord = proxyForDevice(this.proxyPoolStorePath, deviceId);
    if (!proxyRecord) throw new Error("no pool proxy is assigned to this device — assign one before starting routing");
    this._assertHostRoutingAllowed();
    this._setState(deviceId, ROUTING_STATES.PROXY_LEASED, { usbIp, proxyId: proxyRecord.id });

    // Everything from here on can fail and must land in TUN_ERROR/
    // PF_SYNTAX_ERROR rather than leaving the route stuck at PROXY_LEASED
    // with no recorded error — interface discovery/allocation included,
    // not just the tunnel/PF steps below.
    let pfLoaded = false;
    try {
      const existingIfaces = await this.listAllInterfaces();
      await authorize?.();
      this._assertHostRoutingAllowed();
      const previousTunIface = this.routes.get(deviceId)?.tunIface ?? null;
      const tunIface = allocateTunIface({
        existingIfaces, preferred: previousTunIface, rangeStart: this.tunPortRangeStart, rangeEnd: this.tunPortRangeEnd,
      });
      this._setState(deviceId, ROUTING_STATES.TUN_STARTING, { usbIp, proxyId: proxyRecord.id, tunIface });
      this._recordEvent(deviceId, "TUNNEL_STARTING");

      const currentProxy = proxyForDevice(this.proxyPoolStorePath, deviceId);
      if (!currentProxy || currentProxy.id !== proxyRecord.id || currentProxy.leasedToDeviceId !== deviceId) {
        const error = new Error("proxy assignment changed while the route was starting; retry with the current assignment");
        error.status = 409;
        error.expose = true;
        throw error;
      }
      const password = decryptProxyPassword(proxyRecord, this.proxyCredentialEncryptionKey);
      this._assertHostRoutingAllowed();
      this.tunManager.start({
        deviceId, tunIface,
        proxy: { protocol: proxyRecord.protocol, host: proxyRecord.host, port: proxyRecord.port, username: proxyRecord.username, password },
      });
      if (typeof this.tunManager.waitForOwnership === "function"
        && await this.tunManager.waitForOwnership(deviceId) !== true) {
        throw new Error("tunnel process ownership could not be recorded");
      }

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
      this._assertHostRoutingAllowed();
      this._recordEvent(deviceId, "TUNNEL_READY");

      this._setState(deviceId, ROUTING_STATES.PF_APPLYING, { usbIp, proxyId: proxyRecord.id, tunIface, tunPeer: peer.peerIp });
      this._recordEvent(deviceId, "PF_APPLY_STARTED");
      await authorize?.();
      this._assertHostRoutingAllowed();
      await this._applyPfRuleset(this._desiredPfDevices());
      pfLoaded = true;
      this._recordEvent(deviceId, "PF_APPLY_SUCCEEDED");
      await authorize?.();
      this._assertHostRoutingAllowed();
      await this.privilegedOps.clearState(usbIp);

      this._assertHostRoutingAllowed();
      const routed = this._setState(deviceId, ROUTING_STATES.ROUTED, {
        usbIp, proxyId: proxyRecord.id, tunIface, tunPeer: peer.peerIp,
        failClosed: true, recoveryAttempts: 0, protected: false,
      });
      this._recordEvent(deviceId, wasRecovering ? "NETWORK_RECOVERED" : "NETWORK_ROUTE_READY",
        { verification: "device_egress_required" });
      return this.routes.get(deviceId) ?? routed;
    } catch (error) {
      if (["ROUTING_HOST_QUARANTINED", "ROUTING_RECOVERY_REQUIRED"].includes(error?.code)) {
        try { await this.tunManager.stop(deviceId); }
        catch (cleanupError) { this._recordCleanupFailure(deviceId, cleanupError); }
        const current = this.routes.get(deviceId);
        if (current) {
          this.routes.set(deviceId, {
            ...current, state: ROUTING_STATES.ROUTE_LOST, protected: false,
            deviceQuarantined: true, manualInterventionRequired: true,
            protectionState: "bridge_quarantined", lastError: error.message,
          });
          this.onStateChanged(deviceId, this.routes.get(deviceId));
        }
        throw error;
      }
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
      try { await this.tunManager.stop(deviceId); }
      catch (cleanupError) { this._recordCleanupFailure(deviceId, cleanupError); }
      const errorCode = state === ROUTING_STATES.PF_SYNTAX_ERROR ? "F201"
        : state === ROUTING_STATES.PF_CLEANUP_ERROR ? "F202"
          : "T202";
      this._recordFailure(deviceId, state, errorCode, reportedError);
      this._recordEvent(deviceId, state === ROUTING_STATES.PF_SYNTAX_ERROR || pfLoaded
        ? "PF_APPLY_FAILED" : "TUNNEL_FAILED", { errorCode: state === ROUTING_STATES.PF_SYNTAX_ERROR ? "F201" : "T202" });
      try { await this._applyFailClosed(deviceId); }
      catch (protectionError) { await this._enforceEmergencyQuarantine(deviceId, protectionError); }
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
      await this.tunManager.stop(deviceId);
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
    await this.tunManager.stop(deviceId);
    try {
      await this._removeDeviceFromPf(deviceId);
      if (route.usbIp) await this.privilegedOps.clearState(route.usbIp);
    } catch (error) {
      this._recordFailure(deviceId, ROUTING_STATES.STOP_ERROR, "F202", error);
      try { await this._applyFailClosed(deviceId); }
      catch (protectionError) { await this._enforceEmergencyQuarantine(deviceId, protectionError); }
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
    if (isRoutingHostBlocked(this.hostRoutingState)) return;
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
      if (counters === null) {
        await this._handleRouteLost(deviceId, "F203", "PF rules could not be inspected; route health is unknown");
        continue;
      }

      const entry = counters.find(c => c.usbIp === route.usbIp);
      if (!entry) {
        await this._handleRouteLost(deviceId, "F203", "this device's PF rule is no longer loaded in the anchor");
        continue;
      }
      this.routes.set(deviceId, { ...route, lastPackets: entry.packets, lastHealthCheckAt: new Date().toISOString() });
      this.onStateChanged(deviceId, this.routes.get(deviceId));
    }
  }

  // A device-originated egress result is only meaningful while the complete
  // local route underneath it is current. This read-only proof deliberately
  // checks durable process ownership, the private PF rule and the configured
  // bridge each time; a stale in-memory ROUTED record is never sufficient.
  async verifyCurrentRoute(deviceId) {
    if (isRoutingHostBlocked(this.hostRoutingState)) return false;
    const route = this.routes.get(deviceId);
    if (!route || route.state !== ROUTING_STATES.ROUTED || !route.usbIp) return false;
    const tunnelState = this.tunManager.getStatus?.(deviceId)?.state;
    if (tunnelState !== "running" || this.tunManager.isRunning?.(deviceId) !== true) return false;
    if (typeof this.tunManager.hasCurrentOwnership === "function"
      && await this.tunManager.hasCurrentOwnership(deviceId) !== true) return false;
    let counters;
    let bridge;
    try {
      counters = parsePfCounters(await this.privilegedOps.inspectRules());
      bridge = await this.privilegedOps.inspectBridge(this.bridgeIface);
    } catch {
      return false;
    }
    return counters.some(entry => entry.usbIp === route.usbIp)
      && bridge?.available === true && bridge?.up === true;
  }

  async _applyFailClosed(deviceId) {
    const route = this.routes.get(deviceId);
    if (!route?.usbIp) return;
    const routed = this._desiredPfDevices(deviceId);
    const blocked = [...new Set([...this._desiredBlockedIps(deviceId), route.usbIp])];
    await this._applyPfRuleset(routed, blocked);
    const current = this.routes.get(deviceId);
    if (current) {
      this.routes.set(deviceId, {
        ...current, failClosed: true, internetBlocked: true, protected: false,
        protectionState: "blocked", protectionAttempts: 0, protectionError: null,
      });
      this.onStateChanged(deviceId, this.routes.get(deviceId));
      this._recordEvent(deviceId, "INTERNET_FAIL_CLOSED");
    }
  }

  _recordProtectionFailure(deviceId, error) {
    const current = this.routes.get(deviceId);
    if (!current) return null;
    const protectionError = diagnosticError("F202", {
      technical: { errorKind: operationalErrorKind(error) },
    });
    this.routes.set(deviceId, {
      ...current,
      // Keep the route-loss diagnostic as the primary cause. PF failure is a separate
      // protection failure and must never be mistaken for a verified network block.
      routeFailure: current.routeFailure ?? current.latestError ?? null,
      protectionError,
      protectionState: "block_failed",
      protected: false,
      internetBlocked: false,
      protectionAttempts: current.protectionAttempts ?? 0,
    });
    this.onStateChanged(deviceId, this.routes.get(deviceId));
    this._recordEvent(deviceId, "INTERNET_FAIL_CLOSED_FAILED", { errorCode: protectionError.code });
    return protectionError;
  }

  _recordCleanupFailure(deviceId, error) {
    const current = this.routes.get(deviceId);
    if (!current) return null;
    const cleanupError = diagnosticError("T202", {
      why: "The tunnel cleanup step also failed.",
      technical: { errorKind: operationalErrorKind(error) },
    });
    this.routes.set(deviceId, { ...current, cleanupError });
    this.onStateChanged(deviceId, this.routes.get(deviceId));
    this._recordEvent(deviceId, "TUNNEL_CLEANUP_FAILED", { errorCode: cleanupError.code });
    return cleanupError;
  }

  async _enforceEmergencyQuarantine(deviceId, protectionError) {
    this._recordProtectionFailure(deviceId, protectionError);
    if (this.recoveryPromise || this.repairPromise) return false;
    if (this.quarantinePromise) return this.quarantinePromise;
    const operation = this._performEmergencyQuarantine(deviceId);
    this.quarantinePromise = operation;
    try { return await operation; }
    finally {
      if (this.quarantinePromise === operation) this.quarantinePromise = null;
    }
  }

  async _performEmergencyQuarantine(deviceId) {
    let currentlyManaged = [];
    let inventoryComplete = true;
    try {
      if (typeof this.tunManager.listManagedDeviceIds !== "function") inventoryComplete = false;
      else {
        currentlyManaged = this.tunManager.listManagedDeviceIds();
        if (!Array.isArray(currentlyManaged)
          || currentlyManaged.some(id => typeof id !== "string" || !id)) {
          currentlyManaged = [];
          inventoryComplete = false;
        }
      }
    } catch {
      currentlyManaged = [];
      inventoryComplete = false;
    }
    const affectedIds = [...new Set([
      ...(this.hostRoutingState.affectedDeviceIds || []), ...this.routes.keys(), ...currentlyManaged, deviceId,
    ].filter(Boolean))];
    this._beginHostQuarantine(deviceId, "F202", { affectedDeviceIds: affectedIds, inventoryComplete });
    let bridgeError = null;
    const cleanupFailures = [];
    if (this.hostSetupPromises.size) await Promise.allSettled([...this.hostSetupPromises]);
    try { await this.privilegedOps.quarantineBridge(this.bridgeIface); }
    catch (error) { bridgeError = error; }

    for (const affectedId of affectedIds) {
      const recoveryTimer = this.recoveryTimers.get(affectedId);
      if (recoveryTimer) this.clearTimeoutFn(recoveryTimer);
      this.recoveryTimers.delete(affectedId);
      try { await this._stopManagedTunnelAndVerify(affectedId); }
      catch (error) {
        cleanupFailures.push(affectedId);
        this._recordCleanupFailure(affectedId, error);
      }
      const current = this.routes.get(affectedId);
      if (!current) continue;
      const bridgeFailure = affectedId === deviceId ? current.latestError : diagnosticError("F209", {
        why: "The shared Internet Sharing bridge was quarantined after another phone could not be blocked safely.",
      });
      const quarantineError = bridgeError ? diagnosticError("F208", {
        technical: { errorKind: operationalErrorKind(bridgeError) },
      }) : null;
      this.routes.set(affectedId, {
        ...current,
        state: affectedId === deviceId ? current.state : ROUTING_STATES.ROUTE_LOST,
        latestError: bridgeFailure,
        routeFailure: current.routeFailure ?? bridgeFailure,
        failClosed: bridgeError === null,
        internetBlocked: bridgeError === null,
        protected: false,
        protectionState: bridgeError ? "quarantine_failed" : "bridge_quarantined",
        deviceQuarantined: true,
        manualInterventionRequired: true,
        quarantineError,
      });
      this.onStateChanged(affectedId, this.routes.get(affectedId));
      this._recordEvent(affectedId, bridgeError ? "NETWORK_BRIDGE_QUARANTINE_FAILED" : "NETWORK_BRIDGE_QUARANTINED",
        bridgeError ? { errorCode: "F208", scope: "shared_bridge" } : { scope: "shared_bridge" });
    }

    const finalHostState = {
      ...this.hostRoutingState,
      state: bridgeError || cleanupFailures.length || !inventoryComplete
        ? ROUTING_HOST_STATES.RECOVERY_REQUIRED : ROUTING_HOST_STATES.QUARANTINED,
      reasonCode: bridgeError ? "F208" : cleanupFailures.length ? "T202"
        : !inventoryComplete ? "ROUTING_TUNNEL_INVENTORY_INCOMPLETE" : "F202",
      affectedDeviceIds: affectedIds,
      affectedDeviceInventoryComplete: inventoryComplete,
    };
    try { this._persistHostRoutingState(finalHostState); }
    catch {
      this.hostRoutingState = { ...finalHostState, state: ROUTING_HOST_STATES.RECOVERY_REQUIRED,
        reasonCode: "ROUTING_QUARANTINE_PERSIST_FAILED" };
      this.onHostStateChanged(this.getHostRoutingStatus());
    }
    return bridgeError === null && cleanupFailures.length === 0 && inventoryComplete;
  }

  async recoverHostRouting({ authorize = null } = {}) {
    await authorize?.();
    if (this.quarantinePromise) {
      const error = new Error("routing quarantine is still in progress");
      error.status = 409; error.code = "ROUTING_QUARANTINE_IN_PROGRESS"; error.expose = true;
      throw error;
    }
    if (this.repairPromise) {
      const error = new Error("routing state repair is still in progress");
      error.status = 409; error.code = "ROUTING_REPAIR_IN_PROGRESS"; error.expose = true;
      throw error;
    }
    if (this.startPromises.size || this.hostSetupPromises.size) {
      const error = new Error("routing activity is still stopping; retry recovery after it finishes");
      error.status = 409; error.code = "ROUTING_ACTIVITY_IN_PROGRESS"; error.expose = true;
      throw error;
    }
    if (this.recoveryPromise) {
      const error = new Error("routing recovery is already in progress");
      error.status = 409; error.code = "ROUTING_RECOVERY_IN_PROGRESS"; error.expose = true;
      throw error;
    }
    const operation = this._performHostRoutingRecovery({ authorize });
    this.recoveryPromise = operation;
    this.onHostStateChanged(this.getHostRoutingStatus());
    try { await operation; }
    finally {
      if (this.recoveryPromise === operation) this.recoveryPromise = null;
      this.onHostStateChanged(this.getHostRoutingStatus());
    }
    return this.getHostRoutingStatus();
  }

  _unsafeRecoveryError(message = "routing recovery could not prove that every managed tunnel stopped") {
    const error = new Error(message);
    error.status = 409;
    error.code = "ROUTING_RECOVERY_UNSAFE";
    error.expose = true;
    return error;
  }

  async _stopManagedTunnelAndVerify(deviceId) {
    let result;
    try { result = await this.tunManager.stop(deviceId); }
    catch { throw this._unsafeRecoveryError(); }
    const status = this.tunManager.getStatus?.(deviceId);
    let stillManaged = false;
    try {
      const managed = this.tunManager.listManagedDeviceIds?.();
      stillManaged = Array.isArray(managed) && managed.includes(deviceId);
    } catch {
      stillManaged = true;
    }
    if (result?.ok === false || this.tunManager.isRunning?.(deviceId) === true
      || status?.state === "stop_failed" || status?.state === "running"
      || status?.state === "starting" || status?.state === "restarting" || stillManaged) {
      throw this._unsafeRecoveryError();
    }
    return true;
  }

  async _performHostRoutingRecovery({ authorize = null } = {}) {
    let persisted = this.hostRoutingState;
    if (this.quarantineStorePath) {
      persisted = readRoutingQuarantineState(this.quarantineStorePath, this.bridgeIface);
      if (!persisted) {
        if (!isRoutingHostBlocked(this.hostRoutingState)) return this.getHostRoutingStatus();
        throw new RoutingQuarantineStoreError();
      }
    }
    if (!isRoutingHostBlocked(persisted)) return this.getHostRoutingStatus();
    if (persisted.affectedDeviceInventoryComplete !== true) throw this._unsafeRecoveryError(
      "routing recovery cannot prove the complete affected-device inventory; host-level repair is required",
    );
    let currentlyManaged = [];
    if (typeof this.tunManager.listManagedDeviceIds === "function") {
      try { currentlyManaged = this.tunManager.listManagedDeviceIds(); }
      catch { throw this._unsafeRecoveryError(); }
      if (!Array.isArray(currentlyManaged)) throw this._unsafeRecoveryError();
    }
    const affectedIds = [...new Set([...(persisted.affectedDeviceIds || []), ...currentlyManaged])];

    for (const affectedId of affectedIds) {
      await authorize?.();
      await this._stopManagedTunnelAndVerify(affectedId);
    }
    await authorize?.();
    await this.privilegedOps.clearAnchor();
    await authorize?.();
    const rules = await this.privilegedOps.inspectRules();
    if (String(rules || "").trim()) {
      const error = new Error("routing recovery could not verify that stale firewall state was removed");
      error.status = 409; error.code = "ROUTING_RECOVERY_UNSAFE"; error.expose = true;
      throw error;
    }
    await authorize?.();
    const bridge = await this.privilegedOps.inspectBridge(this.bridgeIface);
    if (!bridge?.available || !bridge?.up) {
      const blocked = {
        ...persisted,
        state: ROUTING_HOST_STATES.RECOVERY_REQUIRED,
        reasonCode: "ROUTING_BRIDGE_UNAVAILABLE",
        manualInterventionRequired: true,
        bridgeAvailable: false,
      };
      try {
        const persistedBlocked = this._persistHostRoutingState(blocked);
        this.hostRoutingState = { ...persistedBlocked, bridgeAvailable: false };
        this.onHostStateChanged(this.getHostRoutingStatus());
      }
      catch {
        this.hostRoutingState = { ...blocked, reasonCode: "ROUTING_QUARANTINE_PERSIST_FAILED" };
        this.onHostStateChanged(this.getHostRoutingStatus());
      }
      const error = new Error("routing recovery requires the configured Internet Sharing bridge to be available and active");
      error.status = 409; error.code = "ROUTING_BRIDGE_UNAVAILABLE"; error.expose = true;
      throw error;
    }
    await authorize?.();
    for (const affectedId of affectedIds) {
      if (this.tunManager.isRunning?.(affectedId)) {
        const error = new Error("routing recovery found a stale tunnel process; stop it before clearing quarantine");
        error.status = 409; error.code = "ROUTING_RECOVERY_UNSAFE"; error.expose = true;
        throw error;
      }
    }
    clearRoutingQuarantineState(this.quarantineStorePath);
    this.hostRoutingState = {
      version: 1, state: ROUTING_HOST_STATES.HEALTHY, bridgeIface: this.bridgeIface,
      reasonCode: null, timestamp: null, manualInterventionRequired: false, affectedDeviceIds: [], bridgeAvailable: true,
      affectedDeviceInventoryComplete: true,
    };
    for (const affectedId of affectedIds) {
      const current = this.routes.get(affectedId);
      if (!current) continue;
      this.routes.set(affectedId, {
        ...current, deviceQuarantined: false, manualInterventionRequired: false,
        protectionState: "unverified", internetBlocked: false, protected: false,
      });
      this.onStateChanged(affectedId, this.routes.get(affectedId));
    }
    this.onHostStateChanged(this.getHostRoutingStatus());
    return this.getHostRoutingStatus();
  }

  async repairHostRoutingState({ authorize = null, confirmed = false } = {}) {
    await authorize?.();
    if (confirmed !== true) {
      const error = new Error("explicit confirmation is required to repair host routing state");
      error.status = 409; error.code = "ROUTING_REPAIR_CONFIRMATION_REQUIRED"; error.expose = true;
      throw error;
    }
    if (this.quarantinePromise || this.recoveryPromise || this.repairPromise
      || this.startPromises.size || this.hostSetupPromises.size) {
      const error = new Error("another host routing safety operation is in progress");
      error.status = 409; error.code = "ROUTING_SAFETY_OPERATION_IN_PROGRESS"; error.expose = true;
      throw error;
    }
    if (this.hostRoutingState.stateUnreadable !== true) {
      const error = new Error("host routing state does not require repair");
      error.status = 409; error.code = "ROUTING_REPAIR_NOT_REQUIRED"; error.expose = true;
      throw error;
    }
    const operation = this._performHostRoutingStateRepair({ authorize });
    this.repairPromise = operation;
    this.onHostStateChanged(this.getHostRoutingStatus());
    let repaired;
    try { repaired = await operation; }
    finally {
      if (this.repairPromise === operation) this.repairPromise = null;
      this.onHostStateChanged(this.getHostRoutingStatus());
    }
    return { ...this.getHostRoutingStatus(), originalPreserved: repaired.originalPreserved };
  }

  async _performHostRoutingStateRepair({ authorize = null } = {}) {
    let managedIds = [];
    if (this.hostRoutingState.affectedDeviceInventoryComplete !== true) {
      if (this.hostRoutingState.failureMarkerInvalid === true
        || typeof this.tunManager.listManagedDeviceIds !== "function") {
        throw this._unsafeRecoveryError(
          "host routing state cannot be repaired because the affected-device inventory is incomplete",
        );
      }
      try { managedIds = this.tunManager.listManagedDeviceIds(); }
      catch { throw this._unsafeRecoveryError(); }
      if (!Array.isArray(managedIds)) throw this._unsafeRecoveryError();
    }
    const affectedIds = [...new Set([
      ...this.routes.keys(), ...(this.hostRoutingState.affectedDeviceIds || []), ...managedIds,
    ])];
    for (const affectedId of affectedIds) {
      await authorize?.();
      await this._stopManagedTunnelAndVerify(affectedId);
    }
    await authorize?.();
    await this.privilegedOps.clearAnchor();
    await authorize?.();
    const rules = await this.privilegedOps.inspectRules();
    if (String(rules || "").trim()) {
      const error = new Error("host routing state repair could not verify an empty firewall anchor");
      error.status = 409; error.code = "ROUTING_REPAIR_UNSAFE"; error.expose = true;
      throw error;
    }
    await authorize?.();
    const bridge = await this.privilegedOps.inspectBridge(this.bridgeIface);
    if (!bridge?.available || !bridge?.up) {
      const error = new Error("host routing state repair requires the configured bridge to be available and active");
      error.status = 409; error.code = "ROUTING_BRIDGE_UNAVAILABLE"; error.expose = true;
      throw error;
    }
    await authorize?.();
    for (const affectedId of affectedIds) {
      if (this.tunManager.isRunning?.(affectedId)) {
        const error = new Error("host routing state repair found a managed tunnel still running");
        error.status = 409; error.code = "ROUTING_REPAIR_UNSAFE"; error.expose = true;
        throw error;
      }
    }
    await authorize?.();
    const next = {
      version: 1,
      state: ROUTING_HOST_STATES.RECOVERY_REQUIRED,
      bridgeIface: this.bridgeIface,
      reasonCode: "ROUTING_STATE_REPAIRED",
      timestamp: new Date().toISOString(),
      manualInterventionRequired: true,
      affectedDeviceIds: affectedIds,
      affectedDeviceInventoryComplete: true,
    };
    const repaired = repairRoutingQuarantineState(this.quarantineStorePath, next, this.bridgeIface);
    this.hostRoutingState = repaired.state;
    this.onHostStateChanged(this.getHostRoutingStatus());
    return { ...this.getHostRoutingStatus(), originalPreserved: Boolean(repaired.backupId) };
  }

  async _handleRouteLost(deviceId, code, message) {
    const route = this.routes.get(deviceId);
    if (!route || route.state !== ROUTING_STATES.ROUTED) return;
    const detail = diagnosticError(code, { why: message, technical: { usbIp: route.usbIp } });
    this._setError(deviceId, ROUTING_STATES.ROUTE_LOST, detail.name);
    this.routes.set(deviceId, {
      ...this.routes.get(deviceId), latestError: detail, protected: false,
      routeFailure: detail,
      recoveryAttempts: route.recoveryAttempts ?? 0,
    });
    this._recordEvent(deviceId, "NETWORK_DEGRADED", { errorCode: code });
    try {
      await this._applyFailClosed(deviceId);
    } catch (error) {
      try { await this.tunManager.stop(deviceId); }
      catch (cleanupError) { this._recordCleanupFailure(deviceId, cleanupError); }
      await this._enforceEmergencyQuarantine(deviceId, error);
      this._scheduleProtectionRetry(deviceId);
      return;
    }
    this._scheduleRecovery(deviceId);
  }

  _scheduleProtectionRetry(deviceId) {
    if (isRoutingHostBlocked(this.hostRoutingState)) return;
    if (this.recoveryTimers.has(deviceId)) return;
    const current = this.routes.get(deviceId);
    if (!current || (current.protectionAttempts ?? 0) >= MAX_PROTECTION_RETRIES) return;
    const timer = this.setTimeoutFn(() => (async () => {
      this.recoveryTimers.delete(deviceId);
      if (isRoutingHostBlocked(this.hostRoutingState)) return;
      const route = this.routes.get(deviceId);
      if (!route || route.state !== ROUTING_STATES.ROUTE_LOST || route.protectionState === "blocked") return;
      const attempts = route.protectionAttempts ?? 0;
      if (attempts >= MAX_PROTECTION_RETRIES) return;
      this.routes.set(deviceId, { ...route, protectionAttempts: attempts + 1 });
      try {
        await this._applyFailClosed(deviceId);
      } catch (error) {
        await this._enforceEmergencyQuarantine(deviceId, error);
        this._scheduleProtectionRetry(deviceId);
        return;
      }
      const latest = this.routes.get(deviceId);
      if (!latest?.deviceQuarantined) this._scheduleRecovery(deviceId);
    })().catch(error => {
      this._recordCleanupFailure(deviceId, error);
    }), Math.max(this.recoveryDelayMs, 5000));
    timer.unref?.();
    this.recoveryTimers.set(deviceId, timer);
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
    let protectionError = null;
    try { await this._applyFailClosed(deviceId); }
    catch (error) { protectionError = error; }
    try { await this.tunManager.stop(deviceId); }
    catch (error) { this._recordCleanupFailure(deviceId, error); }
    if (protectionError) {
      await this._enforceEmergencyQuarantine(deviceId, protectionError);
      this._scheduleProtectionRetry(deviceId);
    }
    this.onStateChanged(deviceId, this.routes.get(deviceId));
    return this.routes.get(deviceId);
  }

  _scheduleRecovery(deviceId) {
    if (isRoutingHostBlocked(this.hostRoutingState)) return;
    if (this.recoveryTimers.has(deviceId)) return;
    const route = this.routes.get(deviceId);
    if (!route || route.state !== ROUTING_STATES.ROUTE_LOST) return;
    const attempts = route.recoveryAttempts ?? 0;
    if (attempts >= MAX_AUTOMATIC_RECOVERIES) return;
    const timer = this.setTimeoutFn(() => (async () => {
      this.recoveryTimers.delete(deviceId);
      if (isRoutingHostBlocked(this.hostRoutingState)) return;
      const current = this.routes.get(deviceId);
      if (!current || current.state !== ROUTING_STATES.ROUTE_LOST) return;
      this.routes.set(deviceId, { ...current, recoveryAttempts: attempts + 1 });
      this._recordEvent(deviceId, "NETWORK_RECOVERY_STARTED", { attempt: attempts + 1 });
      try { await this.tunManager.stop(deviceId); }
      catch (error) { this._recordCleanupFailure(deviceId, error); }
      try {
        await this.startRouting(deviceId, { usbIp: current.usbIp });
      } catch (error) {
        const latest = this.routes.get(deviceId) ?? current;
        const detail = diagnosticError("T202", {
          technical: { errorKind: operationalErrorKind(error) },
        });
        this.routes.set(deviceId, {
          ...latest,
          state: ROUTING_STATES.ROUTE_LOST,
          recoveryAttempts: attempts + 1,
          lastError: detail.name,
          latestError: detail,
          protected: false,
        });
        try { await this._applyFailClosed(deviceId); }
        catch (protectionError) { await this._enforceEmergencyQuarantine(deviceId, protectionError); }
        this.onStateChanged(deviceId, this.routes.get(deviceId));
        this._scheduleRecovery(deviceId);
      }
    })().catch(error => {
      this._recordCleanupFailure(deviceId, error);
    }), this.recoveryDelayMs);
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
