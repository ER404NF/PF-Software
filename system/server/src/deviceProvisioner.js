import path from "path";
import { WdaDevice } from "./wdaDevice.js";
import { discoveredDeviceId } from "./deviceDiscovery.js";
import { allocatePort, resolveMjpegPortRange, resolvePortRange } from "./portAllocator.js";
import { upsertProvisioningRecord, loadProvisioningRecords } from "./deviceProvisioningStore.js";

const DEFAULT_POLL_INTERVAL_MS = 5000;

// Matches the specific, previously-observed failure modes from the
// Automation Architecture guide §11 that need a human action on the phone
// itself (trust/developer-mode/certificate), not another process restart —
// "the app should not loop WDA launches while a known manual prerequisite
// is unresolved" (guide §13).
const KNOWN_FAILURES = [
  { pattern: /trust this computer/i, message: "Trust this computer on the phone (USB prompt), then click Retry." },
  { pattern: /developer mode/i, message: "Enable Developer Mode on the phone (Settings > Privacy & Security), then click Retry." },
  { pattern: /untrusted developer|verify.{0,20}app|trust.{0,20}certificate/i, message: "Trust the developer certificate on the phone (Settings > General > VPN & Device Management), then click Retry." },
  { pattern: /maximum app id limit/i, message: "Apple's App ID creation limit was hit for this signing account. Reuse an existing bundle id instead of generating a new one." },
  { pattern: /requires a provisioning profile|no profiles for|provisioning profile .* (?:doesn't include|not found)|signing for .* requires a development team|code signing is required/i, message: "WDA signing needs to be configured once in Xcode. With Phone Farm's bundled WebDriverAgent, enter your Apple Developer Team ID in host setup (and stay signed in to Xcode); with your own WebDriverAgent checkout, open WebDriverAgent.xcodeproj, select a development team for WebDriverAgentRunner, run it once. Then click Retry." },
];

export function classifyWdaFailure(logText) {
  for (const { pattern, message } of KNOWN_FAILURES) {
    if (pattern.test(logText)) return message;
  }
  return null;
}

// Drives "plug in a phone, it comes online with no manual xcodebuild/iproxy
// typing" (Automation Architecture guide §5-6, trimmed to what Phase A
// covers — no proxy/TUN/PF yet; "online" here just means "controllable via
// WDA"). Per-UDID banner state lives on the shared WdaDevice instance as
// `discoveryState`/`discoveryStateMessage`, the same convention
// DiscoveredIosDevice (deviceDiscovery.js) already uses and that
// index.js's summary()/deviceOpenDecision() already forward to clients.
//
// Readiness itself is NOT polled here: once a WdaDevice is registered into
// the live `devices` map, index.js's existing 10s refreshWdaReadiness()
// loop already calls checkReadiness() on every WdaDevice and flips status
// offline -> idle. This loop only observes that side effect (via `status`)
// to know when to clear the "provisioning" banner — it never duplicates
// the HTTP polling.
export class DeviceProvisioner {
  constructor({
    devices,
    discoverIosDevices,
    manualUdids = new Set(),
    wdaProcessManager,
    iproxyManager,
    provisioningStorePath,
    derivedDataRoot,
    portRange = resolvePortRange(),
    mjpegPortRange = resolveMjpegPortRange(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onDeviceListChanged = () => {},
  }) {
    this.devices = devices;
    this.discoverIosDevices = discoverIosDevices;
    this.manualUdids = manualUdids;
    this.wdaProcessManager = wdaProcessManager;
    this.iproxyManager = iproxyManager;
    this.provisioningStorePath = provisioningStorePath;
    this.derivedDataRoot = derivedDataRoot;
    this.portRange = portRange;
    this.mjpegPortRange = mjpegPortRange;
    this.pollIntervalMs = pollIntervalMs;
    this.onDeviceListChanged = onDeviceListChanged;
    this.runtime = new Map(); // udid -> { logicalId, wdaDevice, port, mjpegPort, derivedDataPath }
    this.udidByLogicalId = new Map(); // logicalId -> udid, so routes/clients only ever handle the logical id (never the raw UDID — CLAUDE.md §14.8)
    this.timer = null;

    this.wdaProcessManager.on("exit", ({ key, log }) => this._onProcessExit("WDA", key, log));
    this.wdaProcessManager.on("restart-limit-exceeded", ({ key, log }) => this._onRestartLimitExceeded("WDA", key, log));
    this.iproxyManager.on("exit", ({ key, log }) => this._onProcessExit("iproxy", key, log));
    this.iproxyManager.on("restart-limit-exceeded", ({ key, log }) => this._onRestartLimitExceeded("iproxy", key, log));
  }

  start() {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => { void this.pollOnce(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.wdaProcessManager.stopAll();
    this.iproxyManager.stopAll();
  }

  async pollOnce() {
    let attached;
    try {
      attached = this.discoverIosDevices();
    } catch (error) {
      console.error("device discovery poll failed:", error?.message || error);
      return;
    }
    const attachedUdids = new Set(attached.map(d => d.udid));

    for (const discovered of attached) {
      if (this.manualUdids.has(discovered.udid)) continue;
      if (!this.runtime.has(discovered.udid)) this._onAttach(discovered);
    }
    for (const udid of this.runtime.keys()) {
      if (!attachedUdids.has(udid) && !this.manualUdids.has(udid)) this._onDetach(udid);
    }
    this._reconcileReadiness();
  }

  _onAttach(discovered) {
    const { udid } = discovered;
    const logicalId = discoveredDeviceId(udid);
    const derivedDataPath = path.join(this.derivedDataRoot, logicalId);
    const usedPorts = new Set([...this.runtime.values()].map(entry => entry.port).filter(Boolean));
    const existingRecord = this._loadRecord(udid);
    let port;
    let mjpegPort;
    try {
      port = allocatePort({ range: this.portRange, used: usedPorts, preferred: existingRecord?.wdaLocalPort ?? null });
      const usedMjpegPorts = new Set([...this.runtime.values()].map(entry => entry.mjpegPort).filter(Boolean));
      mjpegPort = allocatePort({ range: this.mjpegPortRange, used: usedMjpegPorts, preferred: existingRecord?.mjpegLocalPort ?? null });
    } catch (error) {
      console.error(`no free WDA port for ${logicalId}:`, error.message);
      return;
    }
    this._saveRecord(udid, { logicalId, displayName: discovered.label, wdaLocalPort: port, mjpegLocalPort: mjpegPort, derivedDataPath });

    let wdaDevice = this.devices.get(logicalId);
    if (!(wdaDevice instanceof WdaDevice)) {
      wdaDevice = new WdaDevice(logicalId, discovered.label, { host: "127.0.0.1", port, mjpegPort });
      this.devices.set(logicalId, wdaDevice);
    } else {
      wdaDevice.mjpegPort = mjpegPort;
    }
    wdaDevice.discoveryState = "provisioning";
    wdaDevice.discoveryStateMessage = "Starting WDA. Starting the USB tunnel. Waiting for device readiness. This can take a minute.";
    wdaDevice.status = "offline";
    this.runtime.set(udid, { logicalId, wdaDevice, port, mjpegPort, derivedDataPath });
    this.udidByLogicalId.set(logicalId, udid);

    try {
      this.wdaProcessManager.start({ udid, derivedDataPath });
      this.iproxyManager.start({ udid, localPort: port, mjpegLocalPort: mjpegPort });
    } catch (error) {
      wdaDevice.discoveryState = "provisioning_error";
      wdaDevice.discoveryStateMessage = "Automatic WDA setup could not start. An admin can review the host logs and retry.";
    }
    this.onDeviceListChanged();
  }

  _onDetach(udid) {
    const entry = this.runtime.get(udid);
    this.wdaProcessManager.stop(udid);
    this.iproxyManager.stop(udid);
    if (entry?.wdaDevice && entry.wdaDevice.status !== "in-use") {
      entry.wdaDevice.status = "offline";
      entry.wdaDevice.discoveryState = "disconnected";
      entry.wdaDevice.discoveryStateMessage = "Unplugged. Reconnect the cable to resume automatic setup.";
    }
    // Drop the runtime entry (not the WdaDevice itself, which stays in the
    // live `devices` map and in the persisted provisioning store) so a
    // later replug is detected as a fresh attach in pollOnce()'s
    // `!this.runtime.has(udid)` check and actually restarts the processes,
    // rather than being silently ignored because the UDID "was already
    // known". _onAttach reuses the existing WdaDevice/port when it finds
    // them still in `devices`/the store.
    this.runtime.delete(udid);
    this.onDeviceListChanged();
  }

  _reconcileReadiness() {
    let changed = false;
    for (const entry of this.runtime.values()) {
      const { wdaDevice } = entry;
      if (wdaDevice.discoveryState === "provisioning" && wdaDevice.status !== "offline") {
        wdaDevice.discoveryState = null;
        wdaDevice.discoveryStateMessage = null;
        changed = true;
      }
    }
    if (changed) this.onDeviceListChanged();
  }

  _onProcessExit(kind, udid, log) {
    const entry = this.runtime.get(udid);
    if (!entry) return;
    // classifyWdaFailure's patterns (untrusted cert, Developer Mode, App ID
    // limit) are all about Xcode/WDA app installation and don't apply to
    // iproxy (a USB port-forwarder) — misapplying them to an iproxy exit
    // whose log happens to match one could send the operator to fix the
    // wrong thing. iproxy failures are left to the ordinary restart/backoff
    // path (_onRestartLimitExceeded already labels those with `kind`).
    if (kind !== "WDA") return;
    const known = classifyWdaFailure(log.join(""));
    if (!known) return;
    entry.wdaDevice.discoveryState = "user_action_required";
    entry.wdaDevice.discoveryStateMessage = known;
    entry.wdaDevice.status = "offline";
    // A known manual prerequisite shouldn't loop retries at the user —
    // stop trying until a human resolves it and retries explicitly.
    this.wdaProcessManager.stop(udid);
    this.iproxyManager.stop(udid);
    this.onDeviceListChanged();
  }

  _onRestartLimitExceeded(kind, udid, _log) {
    const entry = this.runtime.get(udid);
    if (!entry) return;
    entry.wdaDevice.discoveryState = "provisioning_error";
    // Process output can contain a raw UDID, host username, checkout path,
    // signing identity, or command arguments. Device summaries are visible
    // to operators, so keep diagnostics in the host log and expose only a
    // stable recovery instruction here.
    entry.wdaDevice.discoveryStateMessage = `${kind} failed to start after repeated attempts. An admin can review the host logs and retry.`;
    entry.wdaDevice.status = "offline";
    this.onDeviceListChanged();
  }

  // Public entry point for the admin route/fleet UI, which only ever knows
  // a device's logical id (never its raw UDID — CLAUDE.md §14.8, and the
  // Automation Architecture guide's own "redact UDIDs" logging rule).
  retryDevice(logicalId) {
    const udid = this.udidByLogicalId.get(logicalId);
    if (!udid) return false;
    return this.retry(udid);
  }

  // Internal — keyed by UDID because that's what the runtime map and the
  // process managers use as their identity.
  retry(udid) {
    const entry = this.runtime.get(udid);
    if (!entry) return false;
    this.wdaProcessManager.stop(udid);
    this.iproxyManager.stop(udid);
    entry.wdaDevice.discoveryState = "provisioning";
    entry.wdaDevice.discoveryStateMessage = "Retrying automatic setup.";
    entry.wdaDevice.status = "offline";
    this.wdaProcessManager.start({ udid, derivedDataPath: entry.derivedDataPath });
    this.iproxyManager.start({ udid, localPort: entry.port, mjpegLocalPort: entry.mjpegPort });
    this.onDeviceListChanged();
    return true;
  }

  _loadRecord(udid) {
    return loadProvisioningRecords(this.provisioningStorePath)[udid] ?? null;
  }

  _saveRecord(udid, patch) {
    return upsertProvisioningRecord(this.provisioningStorePath, udid, patch);
  }
}
