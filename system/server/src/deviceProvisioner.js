import path from "path";
import { WdaDevice } from "./wdaDevice.js";
import { discoveredDeviceId } from "./deviceDiscovery.js";
import { allocatePort, resolveMjpegPortRange, resolvePortRange } from "./portAllocator.js";
import { upsertProvisioningRecord, loadProvisioningRecords } from "./deviceProvisioningStore.js";
import { diagnosticError } from "./errorCatalog.js";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_RECOVERY_COOLDOWN_MS = 15_000;
const MAX_ENDPOINT_RECOVERIES = 2;

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

const IPROXY_FAILURES = [
  { pattern: /address already in use|EADDRINUSE|bind(?:ing)?.{0,40}failed/i, code: "I205" },
  { pattern: /usage:\s*iproxy|unknown option|too many arguments|invalid.{0,30}(?:argument|port|mapping)/i, code: "I204" },
  { pattern: /no device found|device.{0,30}(?:not found|unavailable)|could not connect to device/i, code: "I206" },
  { pattern: /usbmuxd|usbmux.{0,30}(?:failed|error)|error connecting to socket/i, code: "I207" },
  { pattern: /\bENOENT\b|\bEACCES\b|permission denied|spawn error:.{0,80}not found/i, code: "I208" },
];

export function classifyIproxyFailure(logText) {
  const match = IPROXY_FAILURES.find(candidate => candidate.pattern.test(String(logText)));
  return match ? diagnosticError(match.code, { technical: { category: match.code } }) : null;
}

function diagnosticCheck(id, label, observed, expected, status, meaning, action) {
  return { id, label, observed: String(observed ?? "unknown"), expected, status, meaning, action };
}

function processDiagnostic(id, label, status) {
  const state = status?.state ?? "stopped";
  const restartCount = Number.isSafeInteger(status?.restartCount) ? status.restartCount : 0;
  const observed = `${state}; restart attempts: ${restartCount}`;
  if (state === "running") return diagnosticCheck(id, label, observed, "running", "pass",
    `${label} is running for this phone.`, "No process action is required.");
  if (state === "starting" || state === "restarting") return diagnosticCheck(id, label, observed, "running", "wait",
    `${label} is still ${state}; control remains unavailable until it stabilizes.`, "Keep the phone connected and unlocked while the bounded supervisor finishes.");
  if (state === "stop_failed") return diagnosticCheck(id, label, observed, "running", "fail",
    `${label} could not be stopped cleanly, so Bodun will not launch a conflicting replacement.`, "Quit Bodun completely, reopen it, then run this check again.");
  return diagnosticCheck(id, label, observed, "running", "fail",
    `${label} is not running, so the control path is incomplete.`, "Use Retry setup after reviewing the reported device prerequisite.");
}

export function buildControlDiagnosticReport({ enabled, attachment, wdaStatus, iproxyStatus,
  readinessChecked, readinessPassed, readiness, control, localPort, timeoutMs, recovery,
  sessionProbe = null, windowProbe = null, screenshotProbe = null, recentEvents = [] } = {}) {
  const checks = [];
  checks.push(diagnosticCheck("lifecycle", "WDA lifecycle", enabled ? "enabled" : "stopped", "enabled",
    enabled ? "pass" : "fail",
    enabled ? "Bodun is permitted to run WDA for this phone." : "WDA was intentionally stopped in Bodun.",
    enabled ? "No lifecycle action is required." : "Select Start WDA when you want control available again."));
  checks.push(diagnosticCheck("attachment", "Physical attachment", attachment, "CONNECTED",
    attachment === "CONNECTED" ? "pass" : attachment === "UNKNOWN" ? "wait" : "fail",
    attachment === "CONNECTED" ? "The iPhone is present in the latest discovery result."
      : attachment === "UNKNOWN" ? "Bodun could not complete the latest attachment scan."
        : "The iPhone is not present in physical-device discovery.",
    attachment === "CONNECTED" ? "No attachment action is required."
      : "Reconnect and unlock the iPhone, accept Trust if shown, then run the check again."));
  checks.push(processDiagnostic("wda_process", "WDA process", wdaStatus));
  checks.push(processDiagnostic("iproxy_process", "USB tunnel (iproxy)", iproxyStatus));

  const endpointObserved = !enabled ? "not checked: lifecycle stopped"
    : !readinessChecked ? "not checked: prerequisite process unavailable"
      : readinessPassed ? `ready on local forwarding port ${localPort}`
        : `${readiness?.state ?? "unavailable"}; failures: ${readiness?.consecutiveFailures ?? 0}`;
  checks.push(diagnosticCheck("wda_endpoint", "WDA /status endpoint", endpointObserved,
    `ready within ${timeoutMs} ms`, readinessPassed ? "pass" : readinessChecked ? "fail" : "blocked",
    readinessPassed ? "The forwarded WDA endpoint returned a valid ready response."
      : readinessChecked ? (readiness?.lastError?.why || "The endpoint did not return a valid ready response.")
        : "The endpoint probe cannot run until lifecycle, attachment, WDA, and iproxy prerequisites are available.",
    readinessPassed ? "No endpoint action is required."
      : readiness?.lastError?.operatorAction || "Resolve the first failed prerequisite above, then run Check control again."));
  for (const probe of [sessionProbe, windowProbe, screenshotProbe].filter(Boolean)) {
    checks.push(diagnosticCheck(probe.id, probe.label, probe.observed, probe.expected,
      probe.status, probe.meaning, probe.action));
  }
  const probeFailure = checks.find(check => ["wda_session", "window_geometry", "screenshot"].includes(check.id) && check.status !== "pass");
  const effectiveReady = control === "READY" && !probeFailure;
  checks.push(diagnosticCheck("control", "Control result", effectiveReady ? "READY" : "UNAVAILABLE", "READY", effectiveReady ? "pass" : "fail",
    effectiveReady ? "Status, session, input geometry, and screenshot capture all succeeded."
      : "Bodun fails closed and will not describe control as ready while a required layer or functional probe fails.",
    effectiveReady ? "The phone can be opened and controlled." : "Follow the first failed or waiting check above."));

  const blocker = checks.find(check => check.id !== "control" && check.status !== "pass") || checks.at(-1);
  return {
    outcome: effectiveReady ? "ready" : "unavailable",
    summary: effectiveReady ? "Control is ready end to end."
      : `Control is unavailable because: ${blocker.meaning}`,
    checkedAt: readiness?.checkedAt ?? new Date().toISOString(),
    parameters: {
      localForwardingPort: localPort,
      readinessTimeoutMs: timeoutMs,
      consecutiveReadinessFailures: readiness?.consecutiveFailures ?? 0,
      recoveryState: recovery ?? "IDLE",
    },
    checks,
    timeline: recentEvents.slice(-8).map(event => ({ type: event.type, at: event.at })),
  };
}

function successfulProbe(id, label, observed, elapsedMs) {
  return { id, label, observed: `${observed}; ${elapsedMs} ms`, expected: "successful within readiness timeout",
    status: "pass", meaning: `${label} completed successfully.`, action: "No action is required." };
}

function failedProbe(id, label, error) {
  const reason = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timed out"
    : /HTTP (\d{3})/.exec(String(error?.message))?.[0] || "request failed";
  return { id, label, observed: reason, expected: "successful within readiness timeout", status: "fail",
    meaning: `${label} failed even though the basic WDA readiness endpoint was available.`,
    action: "Keep the phone unlocked. Retry once; if it persists, stop and start WDA from Bodun." };
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
    recoveryCooldownMs = DEFAULT_RECOVERY_COOLDOWN_MS,
    now = () => Date.now(),
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
    this.recoveryCooldownMs = recoveryCooldownMs;
    this.now = now;
    this.onDeviceListChanged = onDeviceListChanged;
    this.runtime = new Map(); // udid -> device runtime and bounded recovery bookkeeping
    this.udidByLogicalId = new Map(); // logicalId -> udid, so routes/clients only ever handle the logical id (never the raw UDID — CLAUDE.md §14.8)
    this.controlChecks = new Map(); // udid -> one coalesced end-to-end readiness probe
    this.lifecycleOperations = new Map(); // logicalId -> serialized start/stop mutation
    this.timer = null;

    this.wdaProcessManager.on("exit", ({ key, log }) => this._onProcessExit("WDA", key, log));
    this.wdaProcessManager.on("starting", ({ key }) => this._onProcessStarting("WDA", key));
    this.wdaProcessManager.on("stable", ({ key }) => this._onProcessStable("WDA", key));
    this.wdaProcessManager.on("restart-limit-exceeded", ({ key, log }) => this._onRestartLimitExceeded("WDA", key, log));
    this.iproxyManager.on("exit", ({ key, log }) => this._onProcessExit("iproxy", key, log));
    this.iproxyManager.on("starting", ({ key }) => this._onProcessStarting("iproxy", key));
    this.iproxyManager.on("stable", ({ key }) => this._onProcessStable("iproxy", key));
    this.iproxyManager.on("persistent-failure", ({ key, log }) => this._onPersistentFailure("iproxy", key, log));
    this.wdaProcessManager.on("persistent-failure", ({ key, log }) => this._onPersistentFailure("WDA", key, log));
    this.iproxyManager.on("restart-limit-exceeded", ({ key, log }) => this._onRestartLimitExceeded("iproxy", key, log));
    this.wdaProcessManager.on("replacement-blocked", ({ key }) => this._onReplacementBlocked("WDA", key));
    this.iproxyManager.on("replacement-blocked", ({ key }) => this._onReplacementBlocked("iproxy", key));
  }

  start() {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => { void this.pollOnce(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([this.wdaProcessManager.stopAll(), this.iproxyManager.stopAll()]);
  }

  async pollOnce() {
    let attached;
    try {
      attached = this.discoverIosDevices();
    } catch (error) {
      this._onDiscoveryFailure(error);
      return;
    }
    if (attached && !Array.isArray(attached) && typeof attached === "object") {
      if (attached.ok !== true) {
        this._onDiscoveryFailure(attached.error);
        return;
      }
      attached = attached.devices;
    }
    if (!Array.isArray(attached)) {
      this._onDiscoveryFailure(new Error("device discovery returned an invalid result"));
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
    await this._reconcileReadiness();
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
    const wdaEnabled = existingRecord?.wdaEnabled !== false;
    wdaDevice.discoveryState = wdaEnabled ? "provisioning" : "wda_stopped";
    wdaDevice.discoveryStateMessage = wdaEnabled
      ? "Starting WDA. Starting the USB tunnel. Waiting for device readiness. This can take a minute."
      : "WDA control is stopped by an authorized operator.";
    wdaDevice.status = "offline";
    wdaDevice.setComponentError("wdaProcess", null);
    wdaDevice.setComponentError("iproxy", null);
    wdaDevice.setComponentHealth({
      deviceAttachment: "CONNECTED",
      wdaProcess: wdaEnabled ? "STARTING" : "STOPPED",
      iproxy: wdaEnabled ? "STARTING" : "STOPPED",
      wdaEndpoint: "UNKNOWN",
      control: "UNAVAILABLE",
      recovery: "IDLE",
    });
    wdaDevice.recordDiagnosticEvent("DEVICE_DISCOVERED", { deviceId: logicalId });
    this.runtime.set(udid, {
      logicalId, wdaDevice, port, mjpegPort, derivedDataPath,
      wdaEnabled,
      recovery: { stage: null, attempts: 0, lastAttemptAt: 0 },
    });
    this.udidByLogicalId.set(logicalId, udid);

    try {
      if (wdaEnabled) {
        this.wdaProcessManager.start({ udid, derivedDataPath });
        this.iproxyManager.start({ udid, localPort: port, mjpegLocalPort: mjpegPort });
      }
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
    if (entry?.wdaDevice) {
      // Keep an in-flight ownership/action lock intact until the action path
      // settles, while still reporting the physical truth immediately.
      // Component health must never claim an unplugged phone is attached.
      if (entry.wdaDevice.status !== "in-use") entry.wdaDevice.status = "offline";
      entry.wdaDevice.setComponentError("wdaProcess", null);
      entry.wdaDevice.setComponentError("iproxy", null);
      entry.wdaDevice.discoveryState = "disconnected";
      entry.wdaDevice.discoveryStateMessage = "Unplugged. Reconnect the cable to resume automatic setup.";
      entry.wdaDevice.setComponentHealth({
        deviceAttachment: "DISCONNECTED",
        wdaProcess: "UNKNOWN",
        iproxy: "UNKNOWN",
        wdaEndpoint: "UNKNOWN",
        control: "UNAVAILABLE",
        recovery: "WAITING_FOR_DEVICE",
      });
      entry.wdaDevice.readiness.lastError = diagnosticError("D101");
      entry.wdaDevice.recordDiagnosticEvent("DEVICE_DETACHED", { error: entry.wdaDevice.readiness.lastError });
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

  async _reconcileReadiness() {
    let changed = false;
    for (const [udid, entry] of this.runtime) {
      const { wdaDevice } = entry;
      if (!entry.wdaEnabled) continue;
      const wdaState = this._managerState(this.wdaProcessManager, udid);
      const iproxyState = this._managerState(this.iproxyManager, udid);
      const currentIproxyHealth = wdaDevice.componentHealth.iproxy;
      wdaDevice.setComponentHealth({
        deviceAttachment: "CONNECTED",
        wdaProcess: processHealthState(wdaState),
        iproxy: iproxyState === "running" && currentIproxyHealth === "STARTING"
          ? "STARTING" : processHealthState(iproxyState),
      });
      if (wdaDevice.discoveryState === "provisioning"
        && wdaDevice.status !== "offline"
        && wdaDevice.readiness?.state === "HEALTHY"
        && wdaDevice.componentHealth.control === "READY"
        && wdaState === "running"
        && iproxyState === "running"
        && wdaDevice.componentHealth.iproxy === "RUNNING") {
        wdaDevice.discoveryState = null;
        wdaDevice.discoveryStateMessage = null;
        entry.recovery = { stage: null, attempts: 0, lastAttemptAt: 0 };
        changed = true;
      }
      if (wdaDevice.readiness?.state === "HEALTHY" && entry.recovery.attempts > 0) {
        wdaDevice.recordDiagnosticEvent("WDA_RECOVERED", { component: entry.recovery.stage });
        entry.recovery = { stage: null, attempts: 0, lastAttemptAt: 0 };
        wdaDevice.setComponentHealth({ recovery: "IDLE" });
        changed = true;
      } else if (wdaDevice.readiness?.state === "FAILED"
        && wdaState === "running" && iproxyState === "running") {
        changed = await this._recoverEndpoint(udid, entry) || changed;
      }
    }
    if (changed) this.onDeviceListChanged();
  }

  _managerState(manager, udid) {
    if (typeof manager.getStatus === "function") return manager.getStatus(udid)?.state ?? "unknown";
    return manager.isRunning?.(udid) ? "running" : "stopped";
  }

  async _recoverEndpoint(udid, entry) {
    const recovery = entry.recovery;
    if (this.now() - recovery.lastAttemptAt < this.recoveryCooldownMs) return false;
    if (recovery.attempts >= MAX_ENDPOINT_RECOVERIES) {
      const error = diagnosticError("R201", { technical: { attempts: recovery.attempts } });
      entry.wdaDevice.discoveryState = "provisioning_error";
      entry.wdaDevice.discoveryStateMessage = `${error.name}. ${error.operatorAction}`;
      entry.wdaDevice.readiness.lastError = error;
      entry.wdaDevice.setComponentHealth({ recovery: "EXHAUSTED", control: "UNAVAILABLE" });
      entry.wdaDevice.recordDiagnosticEvent("WDA_RECOVERY_FAILED", { error });
      return true;
    }
    recovery.lastAttemptAt = this.now();
    recovery.attempts += 1;
    if (recovery.stage !== "IPROXY") {
      recovery.stage = "IPROXY";
      const error = diagnosticError("I202", { technical: { attempt: recovery.attempts } });
      entry.wdaDevice.readiness.lastError = error;
      entry.wdaDevice.beginRecovery("IPROXY");
      this.iproxyManager.stop(udid);
      this.iproxyManager.start({ udid, localPort: entry.port, mjpegLocalPort: entry.mjpegPort });
    } else {
      recovery.stage = "WDA";
      entry.wdaDevice.beginRecovery("WDA");
      this.wdaProcessManager.stop(udid);
      this.wdaProcessManager.start({ udid, derivedDataPath: entry.derivedDataPath });
    }
    return true;
  }

  _onDiscoveryFailure(error) {
    console.error("device discovery poll failed:", error?.reason || error?.code || error?.message || "unknown error");
    for (const entry of this.runtime.values()) {
      const detail = diagnosticError("D102", { technical: { reason: error?.reason || error?.code || error?.name } });
      entry.wdaDevice.setComponentHealth({ deviceAttachment: "UNKNOWN" });
      entry.wdaDevice.readiness.lastError = detail;
      entry.wdaDevice.recordDiagnosticEvent("DEVICE_DISCOVERY_FAILED", { error: detail });
    }
    this.onDeviceListChanged();
  }

  _onProcessStarting(kind, udid) {
    const entry = this.runtime.get(udid);
    if (!entry) return;
    if (entry.wdaDevice.discoveryState === "provisioning_error") {
      entry.wdaDevice.discoveryState = "provisioning";
      entry.wdaDevice.discoveryStateMessage = `Recovering ${kind === "WDA" ? "WebDriverAgent" : "the device tunnel"}. The phone will be available after a fresh readiness check.`;
    }
    // Keep component identifiers consistent with the public health model.
    // Process-manager events use lowercase `iproxy`, while recovery states
    // and diagnostics intentionally expose `IPROXY`/`WDA`.
    entry.wdaDevice.invalidateReadiness(kind === "WDA" ? "WDA" : "IPROXY");
    entry.wdaDevice.setComponentHealth(kind === "WDA" ? { wdaProcess: "STARTING" } : { iproxy: "STARTING" });
    entry.wdaDevice.refreshControlHealth();
    entry.wdaDevice.recordDiagnosticEvent(`${kind === "WDA" ? "WDA" : "IPROXY"}_STARTING`);
    this.onDeviceListChanged();
  }

  _onProcessStable(kind, udid) {
    const entry = this.runtime.get(udid);
    if (!entry) return;
    const component = kind === "WDA" ? "wdaProcess" : "iproxy";
    entry.wdaDevice.setComponentHealth({ [component]: "RUNNING" });
    entry.wdaDevice.setComponentError(component, null);
    entry.wdaDevice.refreshControlHealth();
    entry.wdaDevice.recordDiagnosticEvent(`${kind === "WDA" ? "WDA" : "IPROXY"}_STABLE`);
    this.onDeviceListChanged();
    // A recovered tunnel used to remain unavailable until the unrelated
    // ten-second global readiness sweep happened to run. Probe immediately
    // once both supervised processes are running; coalescing prevents a
    // simultaneous global/diagnostic probe from overlapping this request.
    if (this._managerState(this.wdaProcessManager, udid) === "running"
      && this._managerState(this.iproxyManager, udid) === "running") {
      void this._checkControlReadiness(udid, entry);
    }
  }

  _onProcessExit(kind, udid, log) {
    const entry = this.runtime.get(udid);
    if (!entry) return;
    const code = kind === "WDA" ? "W202" : "I201";
    const detail = kind === "WDA" ? diagnosticError(code) : (classifyIproxyFailure(log.join("")) ?? diagnosticError(code));
    entry.wdaDevice.invalidateReadiness(kind);
    entry.wdaDevice.readiness.lastError = detail;
    entry.wdaDevice.setComponentError(kind === "WDA" ? "wdaProcess" : "iproxy", detail);
    entry.wdaDevice.setComponentHealth(kind === "WDA"
      ? { wdaProcess: "RESTARTING", control: "DEGRADED" }
      : { iproxy: "RESTARTING", control: "UNAVAILABLE" });
    entry.wdaDevice.recordDiagnosticEvent(`${kind === "WDA" ? "WDA" : "IPROXY"}_FAILED`, { error: detail });
    this.onDeviceListChanged();
    // classifyWdaFailure's patterns (untrusted cert, Developer Mode, App ID
    // limit) are all about Xcode/WDA app installation and don't apply to
    // iproxy (a USB port-forwarder) — misapplying them to an iproxy exit
    // whose log happens to match one could send the operator to fix the
    // wrong thing. iproxy failures are left to the ordinary restart/backoff
    // path (_onRestartLimitExceeded already labels those with `kind`).
    if (kind !== "WDA") return;
    const known = classifyWdaFailure(log.join(""));
    if (!known) return;
    const manualError = diagnosticError("W205", { why: known, operatorAction: known });
    entry.wdaDevice.discoveryState = "user_action_required";
    entry.wdaDevice.discoveryStateMessage = known;
    entry.wdaDevice.status = "offline";
    entry.wdaDevice.setComponentError("wdaProcess", manualError);
    entry.wdaDevice.setComponentError("iproxy", null);
    entry.wdaDevice.readiness.lastError = manualError;
    entry.wdaDevice.setComponentHealth({
      wdaProcess: "FAILED", iproxy: "UNKNOWN", wdaEndpoint: "UNKNOWN",
      control: "UNAVAILABLE", recovery: "USER_ACTION_REQUIRED",
    });
    entry.wdaDevice.recordDiagnosticEvent("WDA_USER_ACTION_REQUIRED", { error: manualError });
    // A known manual prerequisite shouldn't loop retries at the user —
    // stop trying until a human resolves it and retries explicitly.
    this.wdaProcessManager.stop(udid);
    this.iproxyManager.stop(udid);
    this.onDeviceListChanged();
  }

  _onPersistentFailure(kind, udid, log) {
    const entry = this.runtime.get(udid);
    if (!entry) return;
    const detail = kind === "iproxy"
      ? (classifyIproxyFailure(log.join("")) ?? diagnosticError("I203"))
      : diagnosticError("W202", { technical: { retriesExhausted: true } });
    entry.wdaDevice.discoveryState = "provisioning_error";
    entry.wdaDevice.discoveryStateMessage = `${detail.name}. ${detail.operatorAction} Automatic retry continues.`;
    if (entry.wdaDevice.status !== "in-use") entry.wdaDevice.status = "offline";
    entry.wdaDevice.readiness.lastError = detail;
    const component = kind === "WDA" ? "wdaProcess" : "iproxy";
    entry.wdaDevice.setComponentError(component, detail);
    entry.wdaDevice.setComponentHealth(kind === "WDA"
      ? { wdaProcess: "RESTARTING", control: "UNAVAILABLE", recovery: "RETRYING" }
      : { iproxy: "RESTARTING", control: "UNAVAILABLE", recovery: "RETRYING_CAPPED" });
    entry.wdaDevice.recordDiagnosticEvent(`${kind === "WDA" ? "WDA" : "IPROXY"}_PERSISTENT_FAILURE`, { error: detail });
    this.onDeviceListChanged();
  }

  _onReplacementBlocked(kind, udid) {
    const entry = this.runtime.get(udid);
    if (!entry) return;
    const component = kind === "WDA" ? "wdaProcess" : "iproxy";
    const detail = diagnosticError(kind === "WDA" ? "W202" : "I203", {
      why: "The previous process did not confirm that it exited, so a replacement was blocked to prevent a port conflict.",
    });
    entry.wdaDevice.discoveryState = "provisioning_error";
    entry.wdaDevice.discoveryStateMessage = `${detail.name}. ${detail.operatorAction}`;
    if (entry.wdaDevice.status !== "in-use") entry.wdaDevice.status = "offline";
    entry.wdaDevice.readiness.lastError = detail;
    entry.wdaDevice.setComponentError(component, detail);
    entry.wdaDevice.setComponentHealth({ [component]: "FAILED", control: "UNAVAILABLE", recovery: "FAILED" });
    entry.wdaDevice.recordDiagnosticEvent(`${kind === "WDA" ? "WDA" : "IPROXY"}_REPLACEMENT_BLOCKED`, { error: detail });
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
    const detail = diagnosticError(kind === "WDA" ? "W203" : "I203");
    entry.wdaDevice.discoveryStateMessage = `${detail.name}. ${detail.operatorAction}`;
    entry.wdaDevice.status = "offline";
    entry.wdaDevice.readiness.lastError = detail;
    entry.wdaDevice.setComponentHealth(kind === "WDA"
      ? { wdaProcess: "FAILED", control: "UNAVAILABLE", recovery: "EXHAUSTED" }
      : { iproxy: "FAILED", control: "UNAVAILABLE", recovery: "EXHAUSTED" });
    entry.wdaDevice.recordDiagnosticEvent(`${kind === "WDA" ? "WDA" : "IPROXY"}_RECOVERY_FAILED`, { error: detail });
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
    entry.wdaEnabled = true;
    this._saveRecord(udid, { wdaEnabled: true });
    this.wdaProcessManager.stop(udid);
    this.iproxyManager.stop(udid);
    entry.wdaDevice.discoveryState = "provisioning";
    entry.wdaDevice.discoveryStateMessage = "Retrying automatic setup.";
    entry.wdaDevice.status = "offline";
    entry.wdaDevice.setComponentError("wdaProcess", null);
    entry.wdaDevice.setComponentError("iproxy", null);
    entry.recovery = { stage: null, attempts: 0, lastAttemptAt: 0 };
    entry.wdaDevice.setComponentHealth({
      deviceAttachment: "CONNECTED", wdaProcess: "STARTING", iproxy: "STARTING",
      wdaEndpoint: "UNKNOWN", control: "UNAVAILABLE", recovery: "MANUAL_RETRY",
    });
    entry.wdaDevice.recordDiagnosticEvent("WDA_RETRY_REQUESTED");
    this.wdaProcessManager.start({ udid, derivedDataPath: entry.derivedDataPath });
    this.iproxyManager.start({ udid, localPort: entry.port, mjpegLocalPort: entry.mjpegPort });
    this.onDeviceListChanged();
    return true;
  }

  getLifecycleState(logicalId) {
    const udid = this.udidByLogicalId.get(logicalId);
    const entry = udid ? this.runtime.get(udid) : null;
    if (!entry) return null;
    return {
      enabled: entry.wdaEnabled,
      state: entry.wdaEnabled ? "running" : "stopped",
      controlReady: entry.wdaDevice.componentHealth.control === "READY",
    };
  }

  stopDevice(logicalId, { authorize = null } = {}) {
    return this._serializeLifecycle(logicalId, async () => {
      const udid = this.udidByLogicalId.get(logicalId);
      const entry = udid ? this.runtime.get(udid) : null;
      if (!entry) return null;
      if (authorize) await authorize();
      if (!entry.wdaEnabled) return this.getLifecycleState(logicalId);
      entry.wdaEnabled = false;
      this._saveRecord(udid, { wdaEnabled: false });
      entry.wdaDevice.invalidateReadiness("OPERATOR_STOP");
      const results = await Promise.allSettled([
        this.wdaProcessManager.stop(udid),
        this.iproxyManager.stop(udid),
      ]);
      if (results.some(result => result.status === "rejected" || result.value?.ok === false)) {
        entry.wdaDevice.discoveryState = "provisioning_error";
        entry.wdaDevice.discoveryStateMessage = "WDA control could not be stopped cleanly. Restart the host before trying to start it again.";
        entry.wdaDevice.setComponentHealth({ control: "UNAVAILABLE", recovery: "FAILED" });
        this.onDeviceListChanged();
        throw new Error("WDA control processes did not stop cleanly");
      }
      entry.wdaDevice.discoveryState = "wda_stopped";
      entry.wdaDevice.discoveryStateMessage = "WDA control is stopped by an authorized operator.";
      if (entry.wdaDevice.status !== "in-use") entry.wdaDevice.status = "offline";
      entry.wdaDevice.setComponentHealth({
        wdaProcess: "STOPPED", iproxy: "STOPPED", wdaEndpoint: "UNKNOWN",
        control: "UNAVAILABLE", recovery: "OPERATOR_STOPPED",
      });
      entry.wdaDevice.recordDiagnosticEvent("WDA_OPERATOR_STOPPED");
      this.onDeviceListChanged();
      return this.getLifecycleState(logicalId);
    });
  }

  startDevice(logicalId, { authorize = null } = {}) {
    return this._serializeLifecycle(logicalId, async () => {
      const udid = this.udidByLogicalId.get(logicalId);
      const entry = udid ? this.runtime.get(udid) : null;
      if (!entry) return null;
      if (authorize) await authorize();
      if (entry.wdaEnabled) return this.getLifecycleState(logicalId);
      entry.wdaEnabled = true;
      this._saveRecord(udid, { wdaEnabled: true });
      entry.wdaDevice.discoveryState = "provisioning";
      entry.wdaDevice.discoveryStateMessage = "Starting WDA and the USB tunnel. Verifying end-to-end control.";
      entry.wdaDevice.setComponentError("wdaProcess", null);
      entry.wdaDevice.setComponentError("iproxy", null);
      entry.wdaDevice.invalidateReadiness("OPERATOR_START");
      try {
        this.wdaProcessManager.start({ udid, derivedDataPath: entry.derivedDataPath });
        this.iproxyManager.start({ udid, localPort: entry.port, mjpegLocalPort: entry.mjpegPort });
      } catch (error) {
        entry.wdaDevice.discoveryState = "provisioning_error";
        entry.wdaDevice.discoveryStateMessage = "WDA control could not start. Review diagnostics and retry.";
        entry.wdaDevice.setComponentHealth({ control: "UNAVAILABLE", recovery: "FAILED" });
        this.onDeviceListChanged();
        throw error;
      }
      this.onDeviceListChanged();
      return this.getLifecycleState(logicalId);
    });
  }

  async diagnoseDevice(logicalId, { authorize = null } = {}) {
    const udid = this.udidByLogicalId.get(logicalId);
    const entry = udid ? this.runtime.get(udid) : null;
    if (!entry) return null;
    const wdaStatus = this.wdaProcessManager.getStatus?.(udid) ?? { state: this._managerState(this.wdaProcessManager, udid) };
    const iproxyStatus = this.iproxyManager.getStatus?.(udid) ?? { state: this._managerState(this.iproxyManager, udid) };
    const before = { wdaProcess: wdaStatus.state, iproxy: iproxyStatus.state };
    const readinessChecked = entry.wdaEnabled && before.wdaProcess === "running" && before.iproxy === "running";
    const checked = readinessChecked
      ? await this._checkControlReadiness(udid, entry)
      : false;
    const probes = { sessionProbe: null, windowProbe: null, screenshotProbe: null };
    if (checked) {
      const runProbe = async (key, id, label, work, describe) => {
        if (authorize) await authorize();
        const startedAt = this.now();
        try {
          const value = await work();
          if (authorize) await authorize();
          probes[key] = successfulProbe(id, label, describe(value), Math.max(0, this.now() - startedAt));
          return true;
        } catch (error) {
          probes[key] = failedProbe(id, label, error);
          return false;
        }
      };
      const sessionReady = await runProbe("sessionProbe", "wda_session", "WDA automation session",
        () => entry.wdaDevice.ensureSession(), () => "session created or reused");
      const windowReady = sessionReady && await runProbe("windowProbe", "window_geometry", "Input geometry",
        () => entry.wdaDevice.ensureWindowSize(), size => `${size.width} x ${size.height} points`);
      if (windowReady) await runProbe("screenshotProbe", "screenshot", "Screenshot capture",
        () => entry.wdaDevice.render(), frame => `${Math.ceil((frame.data?.length ?? 0) * 0.75 / 1024)} KiB image received and discarded`);
    }
    const health = entry.wdaDevice.healthSnapshot();
    return {
      lifecycle: this.getLifecycleState(logicalId),
      processes: before,
      readinessChecked,
      readinessPassed: checked,
      health,
      report: buildControlDiagnosticReport({
        enabled: entry.wdaEnabled,
        attachment: health.deviceAttachment,
        wdaStatus,
        iproxyStatus,
        readinessChecked,
        readinessPassed: checked,
        readiness: health.readiness,
        control: health.control,
        localPort: entry.port,
        timeoutMs: entry.wdaDevice.timeoutMs,
        recovery: health.recovery,
        ...probes,
        recentEvents: health.recentEvents,
      }),
    };
  }

  _checkControlReadiness(udid, entry) {
    if (this.controlChecks.has(udid)) return this.controlChecks.get(udid);
    const operation = (async () => {
      const healthy = await entry.wdaDevice.checkReadiness();
      if (this.runtime.get(udid) !== entry || !entry.wdaEnabled) return false;
      if (healthy) {
        entry.wdaDevice.discoveryState = null;
        entry.wdaDevice.discoveryStateMessage = null;
        entry.recovery = { stage: null, attempts: 0, lastAttemptAt: 0 };
        entry.wdaDevice.setComponentHealth({ recovery: "IDLE" });
        entry.wdaDevice.recordDiagnosticEvent("CONTROL_PATH_VERIFIED");
        this.onDeviceListChanged();
      }
      return healthy;
    })().finally(() => {
      if (this.controlChecks.get(udid) === operation) this.controlChecks.delete(udid);
    });
    this.controlChecks.set(udid, operation);
    return operation;
  }

  _serializeLifecycle(logicalId, action) {
    const previous = this.lifecycleOperations.get(logicalId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    this.lifecycleOperations.set(logicalId, operation);
    return operation.finally(() => {
      if (this.lifecycleOperations.get(logicalId) === operation) this.lifecycleOperations.delete(logicalId);
    });
  }

  _loadRecord(udid) {
    return loadProvisioningRecords(this.provisioningStorePath)[udid] ?? null;
  }

  _saveRecord(udid, patch) {
    return upsertProvisioningRecord(this.provisioningStorePath, udid, patch);
  }
}

function processHealthState(state) {
  if (state === "running") return "RUNNING";
  if (state === "starting") return "STARTING";
  if (state === "restarting") return "RESTARTING";
  if (state === "failed") return "FAILED";
  if (state === "stopped") return "STOPPED";
  return "UNKNOWN";
}
