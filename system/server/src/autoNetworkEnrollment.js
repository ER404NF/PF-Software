import { discoveredDeviceId, discoverIosDevices as defaultDiscoverIosDevices } from "./deviceDiscovery.js";
import { listBridgeMembers as defaultListBridgeMembers, discoverBridgeOwnIp as defaultDiscoverBridgeOwnIp } from "./usbNetworkMapper.js";
import { captureDeviceTraffic as defaultCaptureDeviceTraffic, discoverDeviceIp } from "./usbIpDiscovery.js";
import { getUsbNetworkRecord, setUsbIface, setUsbIp, loadUsbNetworkRecords } from "./usbNetworkStore.js";
import { proxyForDevice } from "./proxyPool.js";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const IP_DISCOVERY_COOLDOWN_MS = 15_000;
const IP_DISCOVERY_STRUGGLING_AFTER = 5; // attempts before the UI note changes tone, never stops retrying

// Automates the two manual steps left after Phase A (WDA/iproxy) and
// start-routing: network enrollment (Architecture guide §4.4) and USB-IP
// discovery (§4.5). Both remain fundamentally "wait for evidence, only act
// when it's unambiguous" — this class just runs that waiting loop itself
// instead of requiring an admin to click Start/Confirm/Discover in
// sequence. It NEVER auto-pairs when more than one candidate is pending on
// either side — that stays exactly as "stop and ask a human" as the guide
// requires; only the single-candidate, unambiguous case is automated.
//
// Deliberately independent of networkRoutingOrchestrator.js (no import) —
// `startRouting` is injected as a plain function, so this module doesn't
// need a real NetworkRoutingOrchestrator instance (or its privileged
// dependencies) in its own tests, and so networkRoutingOrchestrator.js's
// own "network mapping is out of scope for this class" boundary stays true
// even now that something else automates that mapping.
export class AutoNetworkEnrollment {
  constructor({
    bridgeIface,
    usbNetworkStorePath,
    proxyPoolStorePath,
    manualUdids = new Set(),
    startRouting = null, // async (deviceId, { usbIp }) => route | null — omit to leave routing manual
    discoverIosDevices = defaultDiscoverIosDevices,
    listBridgeMembers = defaultListBridgeMembers,
    discoverBridgeOwnIp = defaultDiscoverBridgeOwnIp,
    captureDeviceTraffic = defaultCaptureDeviceTraffic,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onStatusChanged = () => {},
  }) {
    if (!bridgeIface) throw new Error("bridgeIface is required");
    this.bridgeIface = bridgeIface;
    this.usbNetworkStorePath = usbNetworkStorePath;
    this.proxyPoolStorePath = proxyPoolStorePath;
    this.manualUdids = manualUdids;
    this.startRouting = startRouting;
    this.discoverIosDevices = discoverIosDevices;
    this.listBridgeMembers = listBridgeMembers;
    this.discoverBridgeOwnIp = discoverBridgeOwnIp;
    this.captureDeviceTraffic = captureDeviceTraffic;
    this.pollIntervalMs = pollIntervalMs;
    this.onStatusChanged = onStatusChanged;
    this.status = new Map(); // logicalId -> { state, note, updatedAt }
    this.ipAttempts = new Map(); // logicalId -> { lastAttemptAt, count }
    this.timer = null;
  }

  getStatus(deviceId) {
    return this.status.get(deviceId) ?? null;
  }

  _setStatus(deviceId, state, note = null) {
    const next = { state, note, updatedAt: new Date().toISOString() };
    this.status.set(deviceId, next);
    this.onStatusChanged(deviceId, next);
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    let attached;
    try {
      attached = this.discoverIosDevices();
    } catch {
      return; // discovery hiccup — retried next tick, nothing to reconcile from
    }
    const candidateDevices = attached.filter(d => !this.manualUdids.has(d.udid));

    const records = loadUsbNetworkRecords(this.usbNetworkStorePath);
    const claimedIfaces = new Set(Object.values(records).map(r => r.usbIface).filter(Boolean));

    const pendingDevices = candidateDevices.filter(d => !records[discoveredDeviceId(d.udid)]?.usbIface);

    let members;
    try {
      members = await this.listBridgeMembers({ bridgeIface: this.bridgeIface });
    } catch (error) {
      for (const device of pendingDevices) this._setStatus(discoveredDeviceId(device.udid), "pending", `Waiting to read ${this.bridgeIface}: ${error.message}`);
      return;
    }
    const pendingMembers = members.filter(m => !claimedIfaces.has(m));

    if (pendingDevices.length === 1 && pendingMembers.length === 1) {
      const logicalId = discoveredDeviceId(pendingDevices[0].udid);
      try {
        setUsbIface(this.usbNetworkStorePath, logicalId, pendingMembers[0]);
        this._setStatus(logicalId, "discovering_ip", null);
      } catch (error) {
        this._setStatus(logicalId, "pending", `Could not record network enrollment: ${error.message}`);
      }
    } else {
      for (const device of pendingDevices) {
        const logicalId = discoveredDeviceId(device.udid);
        if (pendingDevices.length > 1 || pendingMembers.length > 1) {
          this._setStatus(logicalId, "ambiguous",
            `${pendingDevices.length} phone(s) and ${pendingMembers.length} new network interface(s) appeared at once — unplug and replug one at a time, or use manual enrollment.`);
        } else {
          // pendingMembers.length === 0: Internet Sharing hasn't picked this phone up on the bridge yet.
          this._setStatus(logicalId, "pending", "Waiting for this phone to appear on the shared USB network.");
        }
      }
    }

    await this._discoverPendingIps(candidateDevices, records);
  }

  async _discoverPendingIps(candidateDevices, records) {
    const now = Date.now();
    for (const device of candidateDevices) {
      const logicalId = discoveredDeviceId(device.udid);
      const record = records[logicalId] ?? getUsbNetworkRecord(this.usbNetworkStorePath, logicalId);
      if (!record?.usbIface || record.usbIp) continue; // not enrolled yet, or already has an IP

      const attempt = this.ipAttempts.get(logicalId) ?? { lastAttemptAt: 0, count: 0 };
      if (now - attempt.lastAttemptAt < IP_DISCOVERY_COOLDOWN_MS) continue;
      this.ipAttempts.set(logicalId, { lastAttemptAt: now, count: attempt.count + 1 });

      try {
        const ownIp = await this.discoverBridgeOwnIp({ bridgeIface: this.bridgeIface });
        const capture = await this.captureDeviceTraffic({ iface: record.usbIface });
        const result = discoverDeviceIp(capture, { excludeIps: [ownIp] });
        if (result.state !== "resolved") {
          const struggling = attempt.count + 1 >= IP_DISCOVERY_STRUGGLING_AFTER;
          this._setStatus(logicalId, "discovering_ip",
            struggling ? `Still waiting for network traffic from this phone (${result.reason}). Try opening an app on it.` : result.reason);
          continue;
        }
        setUsbIp(this.usbNetworkStorePath, logicalId, result.ip);
        this.ipAttempts.delete(logicalId);
        await this._maybeAutoRoute(logicalId, result.ip);
      } catch (error) {
        this._setStatus(logicalId, "discovering_ip", `IP discovery failed: ${error.message}`);
      }
    }
  }

  async _maybeAutoRoute(deviceId, usbIp) {
    if (!this.startRouting) {
      this._setStatus(deviceId, "ready", "Network identity resolved. Assign a proxy, then start routing.");
      return;
    }
    const proxy = proxyForDevice(this.proxyPoolStorePath, deviceId);
    if (!proxy) {
      this._setStatus(deviceId, "ready", "Network identity resolved. Assign a proxy to start routing automatically.");
      return;
    }
    try {
      await this.startRouting(deviceId, { usbIp });
      this._setStatus(deviceId, "routing", null);
    } catch (error) {
      this._setStatus(deviceId, "ready", `Automatic routing failed to start: ${error.message}`);
    }
  }
}
