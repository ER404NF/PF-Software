import path from "path";
import { WdaDevice } from "./wdaDevice.js";
import { discoveredDeviceId } from "./deviceDiscovery.js";
import { isLocalPortAvailable, reserveAvailablePortPair, resolveMjpegPortRange, resolvePortRange } from "./portAllocator.js";
import { upsertProvisioningRecord, loadProvisioningRecords } from "./deviceProvisioningStore.js";
import { diagnosticError } from "./errorCatalog.js";
import { LifecycleError, lifecycleSuccess } from "./provisioningResults.js";
import { ownerStatus } from "./portReclaimer.js";
import { buildSetupStatus } from "./setupStatus.js";
import { STORE_UNAVAILABLE } from "./processOwnershipStore.js";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_RECOVERY_COOLDOWN_MS = 15_000;
const MAX_ENDPOINT_RECOVERIES = 2;
// How many times a tunnel that died because a stale Bodun leftover held its port is brought back
// automatically before the phone is reported as blocked.
const MAX_PORT_RECLAIMS = 2;

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

function assertStartResult(result) {
  if (result === "blocked") throw new LifecycleError("old_process_would_not_stop");
  if (result === "queued") throw new LifecycleError("process_replacement_pending");
  if (result !== "started" && result !== "running") throw new LifecycleError("process_replacement_pending");
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
const defaultTimers = {
  setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  clearTimeout: handle => clearTimeout(handle),
};

// Which pause (if any) a sweep's counts call for. Counts a test or an older caller left out count as "could not check".
function setupCodeForSweep(summary) {
  const counts = summary ?? {};
  const skipped = counts.skipped ?? 0;
  const cannotLook = counts.cannotLook ?? 0;
  const earlier = (counts.ownerAlive ?? 0) + (counts.reclaimFailed ?? 0) + (counts.unverifiedAlive ?? 0);
  if (skipped === 0 && cannotLook === 0 && earlier === 0) return null;
  if (cannotLook > 0 || skipped > cannotLook + earlier) return "setup_paused_cannot_check";
  return "setup_paused_earlier_session";
}

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
    isPortAvailable,
    now = () => Date.now(),
    onDeviceListChanged = () => {},
    // Stale-leftover handling (portReclaimer.js / processOwnershipStore.js). Without them a busy
    // port is simply reported as held by an unidentified program and nothing is ever signalled.
    portReclaimer = null,
    ownershipStore = null,
    ownerServer = { pid: process.pid, startTime: null },
    iproxyBin = null,
    // Start-up check of Bodun's earlier phone connections (see start() and recheckNow()). Injectable so a test can drive
    // the waits and the re-check timer by hand.
    timers = defaultTimers,
    startupTries = 3,
    startupRetryDelayMs = 2000,
    recheckIntervalMs = 30_000,
    maxReclaimAttempts = 3,
    onSetupStatusChanged = () => {},
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
    this.isPortAvailable = isPortAvailable;
    this.now = now;
    this.onDeviceListChanged = onDeviceListChanged;
    this.portReclaimer = portReclaimer;
    this.ownershipStore = ownershipStore;
    this.ownerServer = ownerServer;
    this.iproxyBin = iproxyBin ?? iproxyManager?.bin ?? null;
    this.runtime = new Map(); // udid -> device runtime and bounded recovery bookkeeping
    this.udidByLogicalId = new Map(); // logicalId -> udid, so routes/clients only ever handle the logical id (never the raw UDID — CLAUDE.md §14.8)
    this.controlChecks = new Map(); // udid -> one coalesced end-to-end readiness probe
    this.lifecycleOperations = new Map(); // logicalId -> serialized start/stop mutation
    this.pollOperation = null;
    this.timer = null;
    this.stopping = false;
    this.generation = 0;
    this.stopOperation = null;
    this.startOperation = null;
    this.sweepOperation = null;
    this.startupSweepPending = false;
    this.startupFailure = false;
    this.timers = timers;
    this.startupTries = startupTries;
    this.startupRetryDelayMs = startupRetryDelayMs;
    this.recheckIntervalMs = recheckIntervalMs;
    this.maxReclaimAttempts = maxReclaimAttempts;
    this.onSetupStatusChanged = onSetupStatusChanged;
    this.setupStatus = buildSetupStatus("setup_running");
    this.recheckTimer = null;
    this.checkOperation = null;
    this.reclaimAttempts = new Map(); // "kind:udid" -> how many times a leftover was asked to stop this session
    this.waiters = new Set(); // functions that end a start-up wait early (shutdown)

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
    if (this.startOperation) return this.startOperation;
    if (this.stopping) return Promise.resolve();
    // Recover from a crash or force-quit first: leftovers recorded by an earlier run are stopped (or
    // their records dropped) before the first discovery pass looks at any port. The interval is
    // deliberately installed afterwards: a slow or failed inspection must never overlap discovery.
    this.startupSweepPending = true;
    this._setSetupStatus("setup_checking");
    this.startOperation = (async () => {
      let outcome;
      try {
        outcome = await this._runStartupChecks();
      } finally {
        this.startupSweepPending = false;
      }
      if (this.stopping) return;
      // A check that could not be completed means a leftover process might still be running, and starting discovery
      // could create the duplicate the record exists to prevent. Setup is PAUSED (and says why); a later check can lift it.
      if (!outcome.ok) { this._pause(outcome); return; }
      this._setSetupStatus("setup_running");
      await this._beginPolling();
    })();
    return this.startOperation;
  }

  // The current status of automatic phone setup: { state, code, message, changesByItself }.
  getSetupStatus() {
    return { ...this.setupStatus };
  }

  _setSetupStatus(code) {
    if (this.setupStatus.code === code) return false;
    this.setupStatus = buildSetupStatus(code);
    try { this.onSetupStatusChanged(this.getSetupStatus()); } catch { /* a listener must never break setup */ }
    try { this.onDeviceListChanged(); } catch { /* same */ }
    return true;
  }

  // One look at the earlier connections: re-read the record from disk, then sweep it. → { ok: true } or
  // { ok: false, code, retryable }. A damaged record needs a person; the other reasons may clear by themselves.
  async _checkOnce() {
    const fail = error => (error?.code === STORE_UNAVAILABLE && error.reason === "damaged"
      ? { ok: false, code: "setup_paused_record_damaged", retryable: false }
      : { ok: false, code: "setup_paused_cannot_check", retryable: true });
    let summary;
    try {
      await this.ownershipStore?.flush?.(); // nothing older than this look may be written back afterwards
      this.ownershipStore?.reload?.({ recover: true });
      this.sweepOperation = Promise.resolve().then(() => this.sweepStaleOwnership());
      summary = await this.sweepOperation;
    } catch (error) {
      return fail(error);
    }
    const code = setupCodeForSweep(summary);
    return code ? { ok: false, code, retryable: buildSetupStatus(code).changesByItself } : { ok: true };
  }

  // Up to `startupTries` looks, `startupRetryDelayMs` apart, but only while waiting can help.
  async _runStartupChecks() {
    let outcome = { ok: false, code: "setup_paused_cannot_check", retryable: true };
    for (let attempt = 1; attempt <= this.startupTries; attempt += 1) {
      outcome = await this._checkOnce();
      if (outcome.ok || this.stopping || !outcome.retryable) return outcome;
      if (attempt < this.startupTries) await this._wait(this.startupRetryDelayMs);
      if (this.stopping) return outcome;
    }
    return outcome;
  }

  _pause({ code, retryable }) {
    this.startupFailure = true;
    if (this._setSetupStatus(code)) console.error("Automatic device provisioning is blocked because process ownership could not be verified.");
    if (retryable) this._scheduleRecheck();
    else this._cancelRecheck();
  }

  _scheduleRecheck() {
    if (this.stopping) return;
    this._cancelRecheck();
    this.recheckTimer = this.timers.setTimeout(() => {
      this.recheckTimer = null;
      if (this.stopping) return;
      void this.recheckNow().catch(() => {});
    }, this.recheckIntervalMs);
  }

  _cancelRecheck() {
    if (this.recheckTimer) this.timers.clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }

  // A wait that shutdown can end at once.
  _wait(ms) {
    return new Promise(resolve => {
      let handle = null;
      const wake = () => {
        if (handle !== null) this.timers.clearTimeout(handle);
        this.waiters.delete(wake);
        resolve();
      };
      this.waiters.add(wake);
      if (this.stopping) { wake(); return; }
      handle = this.timers.setTimeout(wake, ms);
    });
  }

  // Look again at the earlier connections right now (the Check again button; also what the 30 second timer calls).
  // One check at a time: pressing twice shares the running one. It only looks and reclaims under the same exact-match
  // rules as at start-up, so it can never signal anything new. Throws "shutting_down" while Bodun is stopping.
  recheckNow() {
    if (this.stopping) return Promise.reject(new LifecycleError("shutting_down"));
    if (this.checkOperation) return this.checkOperation;
    if (!this.startupFailure) return Promise.resolve(this.getSetupStatus()); // running, or the first check is still going
    const operation = (async () => {
      try {
        const outcome = await this._checkOnce();
        if (this.stopping) return this.getSetupStatus();
        if (outcome.ok) {
          this._cancelRecheck();
          this.startupFailure = false;
          this._setSetupStatus("setup_running");
          await this._beginPolling();
        } else {
          this._pause(outcome);
        }
        return this.getSetupStatus();
      } finally {
        if (this.checkOperation === operation) this.checkOperation = null;
      }
    })();
    this.checkOperation = operation;
    return operation;
  }

  // Discovery and the periodic poll begin, exactly once, after the earlier connections have been checked.
  async _beginPolling() {
    if (this.stopping || this.startupFailure) return;
    await this.pollOnce();
    if (this.stopping || this.startupFailure || this.timer) return;
    this.timer = setInterval(() => { void this.pollOnce(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  // Looks only at Bodun's own ownership records, never at ports by number:
  //   process gone                         → drop the record
  //   pid reused (start time/command differ) → drop the record, signal nothing
  //   record without a start time          → drop the record (never usable to signal)
  //   same process, owner server dead/reused/this server → stop it (exit confirmed), then drop
  //   same process, owner server still alive (or unknown) → leave it and its record alone
  async sweepStaleOwnership() {
    const store = this.ownershipStore;
    const reclaimer = this.portReclaimer;
    const inspector = reclaimer?.inspector;
    if (!store?.list || !reclaimer || !inspector) return { dropped: 0, reclaimed: 0, skipped: 0 };
    if (this.ownerServer && !this.ownerServer.startTime) {
      const own = await inspector.describe(this.ownerServer.pid).catch(() => null);
      if (own?.startTime) this.ownerServer.startTime = own.startTime;
    }
    // The counts say WHY a record was left alone (the status shown to people depends on it): "cannotLook" the operating system
    // could not be asked, "ownerAlive" the Bodun session that started it is still running, "reclaimFailed" the leftover would
    // not stop (or was already asked enough times), "unverifiedAlive" a record without a start time whose process is alive.
    const summary = { dropped: 0, reclaimed: 0, skipped: 0, cannotLook: 0, ownerAlive: 0, reclaimFailed: 0, unverifiedAlive: 0 };
    for (const record of store.list()) {
      if (this.stopping) break;
      const attemptKey = `${record.kind}:${record.udid}`;
      const forget = async () => { await store.drop(record.kind, record.udid); this.reclaimAttempts.delete(attemptKey); summary.dropped += 1; };
      if (record.unverified || !record.startTime) {
        const unverified = await inspector.describe(record.pid).catch(() => undefined);
        if (unverified === null) await forget();
        else {
          summary.skipped += 1;
          if (unverified === undefined) summary.cannotLook += 1; else summary.unverifiedAlive += 1;
        }
        continue;
      }
      const description = await inspector.describe(record.pid).catch(() => undefined);
      if (description === undefined) { summary.skipped += 1; summary.cannotLook += 1; continue; } // could not look: leave it
      if (description === null || description.startTime !== record.startTime || description.command !== record.command) { await forget(); continue; }
      const owner = await ownerStatus(record, this.ownerServer, inspector);
      if (!["dead", "reused", "self"].includes(owner)) {
        summary.skipped += 1;
        if (owner === "unknown") summary.cannotLook += 1; else summary.ownerAlive += 1;
        continue;
      }
      // A leftover that did not stop is asked at most `maxReclaimAttempts` times in all; after that it is only looked at.
      const attempts = this.reclaimAttempts.get(attemptKey) ?? 0;
      if (attempts >= this.maxReclaimAttempts) { summary.skipped += 1; summary.reclaimFailed += 1; continue; }
      this.reclaimAttempts.set(attemptKey, attempts + 1);
      const result = await reclaimer.reclaim({
        description, classification: { kind: "owned_by_record", record, holder: { program: description.program, pid: description.pid } },
        deviceId: this.udidByLogicalId ? [...this.udidByLogicalId].find(([, udid]) => udid === record.udid)?.[0] ?? null : null,
        port: record.ports?.[0] ?? null, isStopping: () => this.stopping,
      });
      if (result.ok) { await forget(); summary.reclaimed += 1; } else { summary.skipped += 1; summary.reclaimFailed += 1; }
    }
    return summary;
  }

  async stop() {
    if (this.stopOperation) return this.stopOperation;
    this.stopping = true;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._cancelRecheck();
    for (const wake of [...this.waiters]) wake(); // a start-up wait must not hold shutdown back
    this.stopOperation = (async () => {
      // Terminate the managed processes straight away: waiting for a slow discovery pass or a restart's
      // readiness check first (both unbounded) could keep them alive past the shutdown deadline.
      const immediate = Promise.allSettled([this.wdaProcessManager.stopAll(), this.iproxyManager.stopAll()]);
      // A start-up check or a Check again that is still looking ends as soon as it notices that Bodun is stopping.
      await Promise.allSettled([this.startOperation, this.checkOperation].filter(Boolean));
      const activePoll = this.pollOperation;
      if (activePoll) await activePoll.catch(() => {});
      await Promise.allSettled([...this.lifecycleOperations.values()]);
      await immediate;
      // Second pass for anything a late operation managed to start in the meantime.
      await Promise.allSettled([this.wdaProcessManager.stopAll(), this.iproxyManager.stopAll()]);
    })();
    return this.stopOperation;
  }

  pollOnce() {
    if (this.stopping) return Promise.resolve();
    if (this.startupFailure) return Promise.resolve();
    if (this.startupSweepPending) return this.startOperation ?? Promise.resolve();
    if (this.pollOperation) return this.pollOperation;
    const operation = this._pollOnce().finally(() => {
      if (this.pollOperation === operation) this.pollOperation = null;
    });
    this.pollOperation = operation;
    return operation;
  }

  async _pollOnce() {
    const generation = this.generation;
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
      if (this.stopping || generation !== this.generation) return;
      if (this.manualUdids.has(discovered.udid)) continue;
      if (!this.runtime.has(discovered.udid)) await this._onAttach(discovered, generation);
    }
    for (const udid of this.runtime.keys()) {
      if (!attachedUdids.has(udid) && !this.manualUdids.has(udid)) await this._onDetach(udid);
    }
    await this._reconcileReadiness();
  }

  async _onAttach(discovered, generation = this.generation) {
    if (this.stopping || generation !== this.generation) return;
    const { udid } = discovered;
    const logicalId = discoveredDeviceId(udid);
    const derivedDataPath = path.join(this.derivedDataRoot, logicalId);
    const usedPorts = new Set([...this.runtime.values()].flatMap(entry => [entry.port, entry.mjpegPort]).filter(Boolean));
    const existingRecord = this._loadRecord(udid);
    let reservation;
    let adoptOwnedTunnel = false;
    let blockedForeignTunnel = false;
    let portConflict = null;
    const availability = this.isPortAvailable ?? isLocalPortAvailable;
    if (Number.isSafeInteger(existingRecord?.wdaLocalPort) && Number.isSafeInteger(existingRecord?.mjpegLocalPort)) {
      const [controlFree, mjpegFree] = await Promise.all([
        availability(existingRecord.wdaLocalPort), availability(existingRecord.mjpegLocalPort),
      ]);
      if (!controlFree || !mjpegFree) {
        adoptOwnedTunnel = this.iproxyManager.ownsMapping?.(udid, {
          localPort: existingRecord.wdaLocalPort, mjpegLocalPort: existingRecord.mjpegLocalPort,
        }) === true;
        if (!adoptOwnedTunnel) {
          // A leftover from an earlier run is stopped if (and only if) it is provably Bodun's own;
          // anything else keeps the phone blocked, with a plain message naming who holds the port.
          const result = await this._serializeLifecycle(logicalId, () => this._resolvePortConflict({
            logicalId, port: existingRecord.wdaLocalPort, mjpegPort: existingRecord.mjpegLocalPort,
          }));
          if (result.status !== "free") portConflict = this._conflictError(result);
          blockedForeignTunnel = portConflict !== null;
        }
        if (this.stopping || generation !== this.generation) return;
      }
    }
    try {
      reservation = (adoptOwnedTunnel || blockedForeignTunnel) ? {
        controlPort: existingRecord.wdaLocalPort, mjpegPort: existingRecord.mjpegLocalPort, release() {},
      } : await reserveAvailablePortPair({
        controlRange: this.portRange, mjpegRange: this.mjpegPortRange, used: usedPorts,
        preferredControl: existingRecord?.wdaLocalPort ?? null,
        preferredMjpeg: existingRecord?.mjpegLocalPort ?? null,
        ...(this.isPortAvailable ? { isAvailable: this.isPortAvailable } : {}),
      });
    } catch (error) {
      console.error(`no free WDA port for ${logicalId}:`, error.message);
      return;
    }
    const { controlPort: port, mjpegPort } = reservation;
    if (this.stopping || generation !== this.generation) {
      reservation.release();
      return;
    }
    try {
      this._saveRecord(udid, { logicalId, displayName: discovered.label, wdaLocalPort: port, mjpegLocalPort: mjpegPort, derivedDataPath });
    } catch (error) {
      reservation.release();
      console.error(`WDA port reservation could not be persisted for ${logicalId}.`);
      return;
    }

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

    let wdaStartAttempted = false;
    let iproxyStartAttempted = false;
    try {
      if (wdaEnabled && blockedForeignTunnel) {
        this._applyConflictBanner(wdaDevice, portConflict);
      } else if (wdaEnabled) {
        if (this.stopping || generation !== this.generation) return;
        wdaStartAttempted = true;
        assertStartResult(this.wdaProcessManager.start({ udid, derivedDataPath }));
        if (this.stopping || generation !== this.generation) {
          await this.wdaProcessManager.stop(udid);
          return;
        }
        if (!adoptOwnedTunnel) {
          iproxyStartAttempted = true;
          assertStartResult(this.iproxyManager.start({ udid, localPort: port, mjpegLocalPort: mjpegPort }));
        }
      }
    } catch (error) {
      // A queued start is still future work. Stop invalidates the supervisor's
      // generation so it cannot launch after this attach has been reported as
      // failed. If iproxy failed after WDA started, stop both halves of the
      // control path instead of leaving a partially usable phone behind.
      await Promise.allSettled([
        ...(wdaStartAttempted ? [this.wdaProcessManager.stop(udid)] : []),
        ...(iproxyStartAttempted ? [this.iproxyManager.stop(udid)] : []),
      ]);
      if (error instanceof LifecycleError) {
        this._markStartResultFailure(this.runtime.get(udid), udid, error);
      } else {
        wdaDevice.discoveryState = "provisioning_error";
        wdaDevice.discoveryStateMessage = "Automatic WDA setup could not start. An admin can review the host logs and retry.";
        wdaDevice.setComponentHealth({
          wdaProcess: processHealthState(this._managerState(this.wdaProcessManager, udid)),
          iproxy: processHealthState(this._managerState(this.iproxyManager, udid)),
          wdaEndpoint: "UNKNOWN", control: "UNAVAILABLE", recovery: "FAILED",
        });
        wdaDevice.recordDiagnosticEvent("AUTOMATIC_CONTROL_START_FAILED");
      }
    }
    finally {
      reservation.release();
    }
    this.onDeviceListChanged();
  }

  _onDetach(udid) {
    const logicalId = this.runtime.get(udid)?.logicalId;
    if (!logicalId) return Promise.resolve();
    return this._serializeLifecycle(logicalId, async () => {
    const entry = this.runtime.get(udid);
    await Promise.allSettled([this.wdaProcessManager.stop(udid), this.iproxyManager.stop(udid)]);
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
    });
  }

  async _reconcileReadiness() {
    let changed = false;
    for (const [udid, entry] of this.runtime) {
      const { wdaDevice } = entry;
      if (!entry.wdaEnabled) continue;
      const wdaState = this._managerState(this.wdaProcessManager, udid);
      const iproxyState = this._managerState(this.iproxyManager, udid);
      const currentIproxyHealth = wdaDevice.componentHealth.iproxy;
      // A port conflict or an unconfirmed stop is a latched cause: until a retry/start/restart (or an
      // unplug) changes something, the process states must not be rewritten from the managers — they
      // read "stopped" precisely because Bodun refused to start into the conflict, and writing that
      // back made the chip flip between FAILED and STOPPED for the same underlying problem.
      const latched = ["BLOCKED_PORT", "STOP_FAILED"].includes(wdaDevice.componentHealth.recovery);
      wdaDevice.setComponentHealth({
        deviceAttachment: "CONNECTED",
        ...(latched ? {} : {
          wdaProcess: processHealthState(wdaState),
          iproxy: iproxyState === "running" && currentIproxyHealth === "STARTING"
            ? "STARTING" : processHealthState(iproxyState),
        }),
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
    if (kind !== "WDA") entry.portReclaims = 0;
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
    if (kind === "iproxy" && detail.code === "I205") {
      void this._recoverOccupiedIproxyPorts(udid, entry).catch(() => {});
      return;
    }
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

  // The tunnel died because its port was busy. Stop the supervisor's retry loop, find out who
  // holds the port, and either bring the tunnel back (the holder was a provable leftover of
  // Bodun's own and is now gone) or report exactly who is in the way. Serialized per phone so a
  // Retry/Start/Restart queues behind it instead of racing it.
  _recoverOccupiedIproxyPorts(udid, entry) {
    return this._serializeLifecycle(entry.logicalId, async () => {
      if (this.runtime.get(udid) !== entry || !entry.wdaEnabled || this.stopping) return;
      try {
        let stopped;
        try {
          stopped = await this.iproxyManager.stop(udid);
        } catch (error) {
          throw Object.assign(new Error("iproxy stop failed"), { code: "IPROXY_STOP_FAILED", cause: error });
        }
        if (stopped?.ok === false) throw Object.assign(new Error("iproxy did not confirm exit"), { code: "IPROXY_STOP_FAILED" });
        if (this.stopping || this.runtime.get(udid) !== entry || !entry.wdaEnabled) return;
        const result = await this._resolvePortConflict(entry);
        if (this.stopping || this.runtime.get(udid) !== entry || !entry.wdaEnabled) return;
        if (result.status === "free" && (entry.portReclaims ?? 0) < MAX_PORT_RECLAIMS) {
          entry.portReclaims = (entry.portReclaims ?? 0) + 1;
          entry.wdaDevice.recordDiagnosticEvent("IPROXY_STALE_TUNNEL_RECLAIMED");
          this.iproxyManager.start({ udid, localPort: entry.port, mjpegLocalPort: entry.mjpegPort });
        } else {
          // A holder that is not provably Bodun's own, or a port that keeps being taken again.
          const blocking = result.status === "free" ? { status: "unidentified", port: entry.port } : result;
          this._markPortConflict(entry, this._conflictError(blocking));
        }
      } catch (cause) {
        const code = cause?.code === "IPROXY_STOP_FAILED" ? "I210"
          : classifyIproxyFailure(cause?.message || "")?.code ?? "I203";
        const error = diagnosticError(code);
        entry.wdaDevice.discoveryState = "provisioning_error";
        entry.wdaDevice.discoveryStateMessage = `${error.name}. ${error.operatorAction}`;
        entry.wdaDevice.setComponentError("iproxy", error);
        entry.wdaDevice.setComponentHealth({
          iproxy: "FAILED", control: "UNAVAILABLE",
          recovery: code === "I205" ? "BLOCKED_PORT" : code === "I210" ? "STOP_FAILED" : "FAILED",
        });
        entry.wdaDevice.recordDiagnosticEvent("IPROXY_PORT_REALLOCATION_FAILED", { error });
      }
      this.onDeviceListChanged();
    });
  }

  _ownsIproxyMapping(udid, entry) {
    return this.iproxyManager.ownsMapping?.(udid, {
      localPort: entry.port, mjpegLocalPort: entry.mjpegPort,
    }) === true;
  }

  _reserveDevicePorts(entry) {
    return reserveAvailablePortPair({
      controlRange: { start: entry.port, end: entry.port },
      mjpegRange: { start: entry.mjpegPort, end: entry.mjpegPort },
      preferredControl: entry.port,
      preferredMjpeg: entry.mjpegPort,
      ...(this.isPortAvailable ? { isAvailable: this.isPortAvailable } : {}),
    });
  }

  // Ports Bodun has persisted for its phones (used to recognise a leftover of Bodun's own).
  _persistedPortPairs() {
    try {
      return Object.entries(loadProvisioningRecords(this.provisioningStorePath))
        .filter(([, record]) => Number.isSafeInteger(record?.wdaLocalPort))
        .map(([udid, record]) => ({ udid, wdaPort: record.wdaLocalPort, mjpegPort: Number.isSafeInteger(record.mjpegLocalPort) ? record.mjpegLocalPort : null }));
    } catch {
      return [];
    }
  }

  _portIsFree(port) {
    return (this.isPortAvailable ?? isLocalPortAvailable)(port);
  }

  // Looks at a phone's control and video ports. Free ports cost nothing. A busy port is handed to the
  // reclaimer, which stops the holder only if it is provably a leftover of this Bodun; the port is then
  // probed again. Returns { status: "free" } or the blocking result (foreign | unidentified | unknown |
  // would_not_stop | shutting_down) for _conflictError().
  async _resolvePortConflict(target) {
    for (const port of [target.port, target.mjpegPort].filter(Number.isSafeInteger)) {
      if (this.stopping) return { status: "shutting_down", port };
      if (await this._portIsFree(port)) continue;
      if (!this.portReclaimer) return { status: "unidentified", port };
      const result = await this.portReclaimer.resolvePort({
        port,
        deviceId: target.logicalId,
        records: this.ownershipStore?.list?.() ?? [],
        persisted: this._persistedPortPairs(),
        iproxyBin: this.iproxyBin,
        ownerServer: this.ownerServer,
        isStopping: () => this.stopping,
      });
      if (result.status === "free" || result.status === "reclaimed") {
        if (await this._portIsFree(port)) continue;
        return { status: "unidentified", port };
      }
      return result;
    }
    return { status: "free" };
  }

  _conflictError(result) {
    const details = { port: result.port, program: result.holder?.program ?? null, pid: result.holder?.pid ?? null };
    switch (result.status) {
      case "foreign": return new LifecycleError("port_held_by_other_program", details);
      case "would_not_stop": return new LifecycleError("old_process_would_not_stop", details);
      case "shutting_down": return new LifecycleError("shutting_down", details);
      default: return new LifecycleError("port_held_by_unidentified_program", details);
    }
  }

  // The banner on the phone's card: the plain sentence naming who holds the port (program, process
  // number, port) — never the holder's command line.
  _applyConflictBanner(wdaDevice, error) {
    const stopFailed = error.code === "old_process_would_not_stop";
    const detail = diagnosticError(stopFailed ? "I210" : "I205", {
      why: error.message,
      operatorAction: stopFailed
        ? "Restart Bodun, then use Retry setup."
        : "Close that program, then use Retry setup. Bodun will not stop other programs.",
      technical: error.details?.program ? { program: error.details.program, pid: error.details.pid, port: error.details.port } : { port: error.details?.port ?? null },
    });
    wdaDevice.discoveryState = "provisioning_error";
    wdaDevice.discoveryStateMessage = error.message;
    wdaDevice.setComponentError("iproxy", detail);
    wdaDevice.setComponentHealth({
      wdaProcess: "STOPPED", iproxy: "FAILED", control: "UNAVAILABLE", recovery: stopFailed ? "STOP_FAILED" : "BLOCKED_PORT",
    });
    wdaDevice.recordDiagnosticEvent(stopFailed ? "IPROXY_STOP_FAILED" : "IPROXY_FOREIGN_OWNER_BLOCKED", { error: detail });
  }

  _markPortConflict(entry, error) {
    this._applyConflictBanner(entry.wdaDevice, error);
    this.onDeviceListChanged();
    return error;
  }

  _markIproxyStopFailed(entry) {
    const error = diagnosticError("I210");
    entry.wdaDevice.discoveryState = "provisioning_error";
    entry.wdaDevice.discoveryStateMessage = `${error.name}. ${error.operatorAction}`;
    entry.wdaDevice.setComponentError("iproxy", error);
    entry.wdaDevice.setComponentHealth({
      wdaProcess: "STOPPED", iproxy: "FAILED", control: "UNAVAILABLE", recovery: "STOP_FAILED",
    });
    entry.wdaDevice.recordDiagnosticEvent("IPROXY_STOP_FAILED", { error });
    this.onDeviceListChanged();
  }

  _markStartResultFailure(entry, udid, error) {
    if (error?.code === "old_process_would_not_stop") {
      this._markIproxyStopFailed(entry);
      return;
    }
    if (error?.code !== "process_replacement_pending") return;
    entry.wdaDevice.discoveryState = "provisioning_error";
    entry.wdaDevice.discoveryStateMessage = error.message;
    if (entry.wdaDevice.status !== "in-use") entry.wdaDevice.status = "offline";
    entry.wdaDevice.setComponentHealth({
      wdaProcess: processHealthState(this._managerState(this.wdaProcessManager, udid)),
      iproxy: processHealthState(this._managerState(this.iproxyManager, udid)),
      wdaEndpoint: "UNKNOWN", control: "UNAVAILABLE", recovery: "FAILED",
    });
    entry.wdaDevice.recordDiagnosticEvent("PROCESS_REPLACEMENT_PENDING");
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
    return this._serializeLifecycle(logicalId, async () => {
      if (this.stopping) throw new LifecycleError("shutting_down");
      const udid = this.udidByLogicalId.get(logicalId);
      if (!udid) throw new LifecycleError("device_unknown");
      return this.retry(udid);
    });
  }

  // Internal — keyed by UDID because that's what the runtime map and the
  // process managers use as their identity. Every failure is a thrown LifecycleError (a distinct,
  // plain-language reason); only success returns a value: { ok: true, code: "started" }.
  async retry(udid) {
    const entry = this.runtime.get(udid);
    if (!entry) throw new LifecycleError("device_not_attached");
    if (this.stopping) throw new LifecycleError("shutting_down");
    const adoptOwnedTunnel = this._ownsIproxyMapping(udid, entry);
    const stopped = await Promise.all([
      this.wdaProcessManager.stop(udid),
      ...(adoptOwnedTunnel ? [] : [this.iproxyManager.stop(udid)]),
    ]);
    if (stopped.some(result => result?.ok === false)
      || this.wdaProcessManager.getStatus?.(udid)?.state === "stop_failed"
      || this.iproxyManager.getStatus?.(udid)?.state === "stop_failed") {
      this._markIproxyStopFailed(entry);
      throw new LifecycleError("old_process_would_not_stop");
    }
    if (this.stopping) throw new LifecycleError("shutting_down");
    if (this.runtime.get(udid) !== entry) throw new LifecycleError("device_not_attached");
    let reservation = null;
    if (!adoptOwnedTunnel) {
      const conflict = await this._resolvePortConflict(entry);
      if (conflict.status !== "free") throw this._markPortConflict(entry, this._conflictError(conflict));
      try {
        reservation = await this._reserveDevicePorts(entry);
      } catch {
        throw this._markPortConflict(entry, this._conflictError({ status: "unidentified", port: entry.port }));
      }
    }
    if (this.stopping || this.runtime.get(udid) !== entry) {
      reservation?.release();
      throw new LifecycleError(this.stopping ? "shutting_down" : "device_not_attached");
    }
    try {
      entry.wdaEnabled = true;
      this._saveRecord(udid, { wdaEnabled: true });
      entry.wdaDevice.discoveryState = "provisioning";
      entry.wdaDevice.discoveryStateMessage = "Retrying automatic setup.";
      entry.wdaDevice.status = "offline";
      entry.wdaDevice.setComponentError("wdaProcess", null);
      entry.wdaDevice.setComponentError("iproxy", null);
      entry.recovery = { stage: null, attempts: 0, lastAttemptAt: 0 };
      entry.wdaDevice.setComponentHealth({
        deviceAttachment: "CONNECTED", wdaProcess: "STARTING",
        iproxy: adoptOwnedTunnel ? processHealthState(this._managerState(this.iproxyManager, udid)) : "STARTING",
        wdaEndpoint: "UNKNOWN", control: "UNAVAILABLE", recovery: "MANUAL_RETRY",
      });
      entry.wdaDevice.recordDiagnosticEvent("WDA_RETRY_REQUESTED");
      assertStartResult(this.wdaProcessManager.start({ udid, derivedDataPath: entry.derivedDataPath }));
      if (!adoptOwnedTunnel) {
        assertStartResult(this.iproxyManager.start({ udid, localPort: entry.port, mjpegLocalPort: entry.mjpegPort }));
      }
      this.onDeviceListChanged();
      return lifecycleSuccess();
    } catch (error) {
      await Promise.allSettled([this.wdaProcessManager.stop(udid), this.iproxyManager.stop(udid)]);
      entry.wdaEnabled = false;
      try { this._saveRecord(udid, { wdaEnabled: false }); } catch { /* keep the start failure */ }
      entry.wdaDevice.discoveryState = "provisioning_error";
      entry.wdaDevice.discoveryStateMessage = error instanceof LifecycleError
        ? error.message : "WDA control could not start safely. Review diagnostics before retrying.";
      entry.wdaDevice.setComponentHealth({ wdaProcess: "FAILED", control: "UNAVAILABLE", recovery: "FAILED" });
      this.onDeviceListChanged();
      throw error;
    } finally {
      reservation?.release();
    }
  }

  getLifecycleState(logicalId, { inUse: authoritativeInUse = null } = {}) {
    const udid = this.udidByLogicalId.get(logicalId);
    if (!udid) return null;
    const entry = this.runtime.get(udid);
    if (!entry) {
      // Unplugged within this session: no processes, but the operator's choice (enabled or stopped) is
      // still on record, and Stop must keep working so it can be changed.
      let enabled = true;
      try { enabled = this._loadRecord(udid)?.wdaEnabled !== false; } catch { /* keep the default */ }
      const inUse = typeof authoritativeInUse === "boolean"
        ? authoritativeInUse : this.devices.get(logicalId)?.status === "in-use";
      return {
        managed: true, attached: false, enabled, state: "detached", wdaProcess: "stopped", iproxyProcess: "stopped",
        endpointReady: false, controlReady: false, inUse,
        ...lifecycleGuidance({ state: "detached", attached: false, inUse }),
        canStop: enabled, stopReason: enabled ? null : "Already stopped.",
      };
    }
    const wdaProcess = this._managerState(this.wdaProcessManager, udid);
    const iproxyProcess = this._managerState(this.iproxyManager, udid);
    const endpointReady = entry.wdaDevice.readiness?.ready === true;
    const controlReady = entry.wdaDevice.componentHealth.control === "READY";
    const state = ["BLOCKED_PORT", "STOP_FAILED"].includes(entry.wdaDevice.componentHealth.recovery)
      || [wdaProcess, iproxyProcess].includes("stop_failed")
      ? "failed" : !entry.wdaEnabled
      ? (wdaProcess === "stopped" && iproxyProcess === "stopped" ? "stopped" : "failed")
      : entry.wdaDevice.componentHealth.recovery === "FAILED" || [wdaProcess, iproxyProcess].includes("failed") ? "failed"
        : [wdaProcess, iproxyProcess].includes("restarting") ? "restarting"
          : wdaProcess !== "running" || iproxyProcess !== "running" ? "starting"
            : controlReady ? "ready" : "enabled";
    const inUse = typeof authoritativeInUse === "boolean"
      ? authoritativeInUse : entry.wdaDevice.status === "in-use";
    return {
      managed: true,
      attached: true,
      enabled: entry.wdaEnabled,
      state,
      wdaProcess,
      iproxyProcess,
      endpointReady,
      controlReady,
      inUse,
      ...lifecycleGuidance({
        state, inUse, attached: true,
        anyRunning: ["running", "starting", "restarting"].includes(wdaProcess) || ["running", "starting", "restarting"].includes(iproxyProcess),
        // A short instruction, not a repeat of the explanation that the card already shows above its buttons.
        blockedMessage: entry.wdaDevice.componentHealth.recovery === "BLOCKED_PORT" ? "Close the other program first, then use Retry setup."
          : entry.wdaDevice.componentHealth.recovery === "STOP_FAILED" ? "Restart this Mac first, then try again."
            : null,
      }),
    };
  }

  // A process Bodun tried to stop but could not confirm gone leaves its supervisor "blocked" for good.
  // The block is lifted only on proof that the old process no longer exists: the kept ownership record
  // shows it (dead pid / different start time), or Bodun just stopped it itself because it is provably
  // its own leftover. Returns whether every blocked manager was cleared.
  async _clearStopFailures(udid) {
    for (const [manager, kind] of [[this.wdaProcessManager, "wda"], [this.iproxyManager, "iproxy"]]) {
      if (manager.getStatus?.(udid)?.state !== "stop_failed") continue;
      let cleared = await manager.clearBlockedStop?.(udid);
      if (!cleared && await this._reclaimOwnProcess(kind, udid)) cleared = await manager.clearBlockedStop?.(udid, { verifiedGone: true });
      if (!cleared) return false;
    }
    return true;
  }

  async _reclaimOwnProcess(kind, udid) {
    const record = this.ownershipStore?.get?.(kind, udid);
    const inspector = this.portReclaimer?.inspector;
    if (!record || record.unverified || !record.startTime || !inspector) return false;
    const description = await inspector.describe(record.pid).catch(() => undefined);
    if (description === undefined) return false;
    if (description === null || description.startTime !== record.startTime || description.command !== record.command) return true; // already gone (or the pid was reused)
    const owner = await ownerStatus(record, this.ownerServer, inspector);
    if (!["self", "dead", "reused"].includes(owner)) return false;
    const result = await this.portReclaimer.reclaim({
      description, classification: { kind: "owned_by_record", record, holder: { program: description.program, pid: description.pid } },
      deviceId: null, port: record.ports?.[0] ?? null, isStopping: () => this.stopping,
    });
    return result.ok === true;
  }

  // The phone a Start/Stop/Restart is about. Unknown or manually configured phones are "not managed";
  // an unplugged phone has no running processes to act on (Stop for it is handled separately).
  _lifecycleEntry(logicalId, { allowDetached = false } = {}) {
    if (this.stopping) throw new LifecycleError("shutting_down");
    const udid = this.udidByLogicalId.get(logicalId);
    if (!udid) throw new LifecycleError("device_not_managed");
    const entry = this.runtime.get(udid) ?? null;
    if (!entry && !allowDetached) throw new LifecycleError("device_not_attached");
    return { udid, entry };
  }

  _assertStillCurrent(udid, entry) {
    if (this.stopping) throw new LifecycleError("shutting_down");
    if (this.runtime.get(udid) !== entry) throw new LifecycleError("device_not_attached");
  }

  restartDevice(logicalId, { authorize = null } = {}) {
    return this._serializeLifecycle(logicalId, async () => {
      const { udid, entry } = this._lifecycleEntry(logicalId);
      if (authorize) await authorize();
      if (!entry.wdaEnabled) throw new LifecycleError("wda_not_running");
      if ([this.wdaProcessManager, this.iproxyManager].some(manager => manager.getStatus?.(udid)?.state === "stop_failed")
        && !(await this._clearStopFailures(udid))) {
        this._markIproxyStopFailed(entry);
        throw new LifecycleError("old_process_would_not_stop");
      }
      entry.wdaEnabled = true;
      this._saveRecord(udid, { wdaEnabled: true });
      entry.wdaDevice.invalidateReadiness("OPERATOR_RESTART");
      entry.wdaDevice.discoveryState = "provisioning";
      entry.wdaDevice.discoveryStateMessage = "Restarting WDA and the USB tunnel. Control remains unavailable until a fresh readiness check passes.";
      entry.wdaDevice.setComponentHealth({
        wdaProcess: "RESTARTING", iproxy: "RESTARTING", wdaEndpoint: "UNKNOWN",
        control: "UNAVAILABLE", recovery: "OPERATOR_RESTART",
      });
      this.onDeviceListChanged();
      try {
        const stopped = await Promise.all([
          this.wdaProcessManager.stop(udid), this.iproxyManager.stop(udid),
        ]);
        if (stopped.some(result => result?.ok === false)) throw new LifecycleError("wda_stop_unconfirmed");
        this._assertStillCurrent(udid, entry);
        const conflict = await this._resolvePortConflict(entry);
        if (conflict.status !== "free") throw this._markPortConflict(entry, this._conflictError(conflict));
        let reservation;
        try {
          reservation = await this._reserveDevicePorts(entry);
        } catch {
          throw this._markPortConflict(entry, this._conflictError({ status: "unidentified", port: entry.port }));
        }
        try {
          if (authorize) await authorize();
          this._assertStillCurrent(udid, entry);
          assertStartResult(this.wdaProcessManager.start({ udid, derivedDataPath: entry.derivedDataPath }));
          assertStartResult(this.iproxyManager.start({ udid, localPort: entry.port, mjpegLocalPort: entry.mjpegPort }));
        } finally {
          reservation.release();
        }
        const ready = await this._checkControlReadiness(udid, entry);
        if (!ready) {
          entry.wdaDevice.discoveryState = "provisioning";
          entry.wdaDevice.discoveryStateMessage = "WDA restarted, but control is not ready yet. Use Check control for the failing layer.";
        }
        entry.wdaDevice.recordDiagnosticEvent("WDA_OPERATOR_RESTARTED");
        this.onDeviceListChanged();
        return this.getLifecycleState(logicalId);
      } catch (error) {
        await Promise.allSettled([this.wdaProcessManager.stop(udid), this.iproxyManager.stop(udid)]);
        // A port conflict is not a reason to forget that the operator wants WDA running: the banner
        // is already set and the phone stays enabled, so Start/Restart can be tried again.
        if (error instanceof LifecycleError) {
          this._markStartResultFailure(entry, udid, error);
          throw error;
        }
        entry.wdaEnabled = false;
        try { this._saveRecord(udid, { wdaEnabled: false }); } catch { /* preserve the original failure */ }
        entry.wdaDevice.discoveryState = "provisioning_error";
        entry.wdaDevice.discoveryStateMessage = "WDA restart failed safely. Both managed processes were stopped; use Check control before trying again.";
        entry.wdaDevice.setComponentHealth({
          wdaProcess: processHealthState(this._managerState(this.wdaProcessManager, udid)),
          iproxy: processHealthState(this._managerState(this.iproxyManager, udid)),
          wdaEndpoint: "UNKNOWN", control: "UNAVAILABLE", recovery: "FAILED",
        });
        entry.wdaDevice.recordDiagnosticEvent("WDA_OPERATOR_RESTART_FAILED");
        this.onDeviceListChanged();
        throw error;
      }
    });
  }

  stopDevice(logicalId, { authorize = null } = {}) {
    return this._serializeLifecycle(logicalId, async () => {
      const { udid, entry } = this._lifecycleEntry(logicalId, { allowDetached: true });
      if (authorize) await authorize();
      if (!entry) {
        // Unplugged in this session: there is no running process to stop, but the operator's choice
        // is still recorded, so the phone comes back stopped when it is plugged in again.
        try { this._saveRecord(udid, { wdaEnabled: false }); } catch { /* the in-memory state below still reports it */ }
        await Promise.allSettled([this.wdaProcessManager.stop(udid), this.iproxyManager.stop(udid)]);
        const wdaDevice = this.devices.get(logicalId);
        if (wdaDevice) {
          wdaDevice.discoveryStateMessage = "Unplugged. WDA control will stay stopped when the cable is reconnected.";
          wdaDevice.recordDiagnosticEvent?.("WDA_OPERATOR_STOPPED");
        }
        this.onDeviceListChanged();
        return this.getLifecycleState(logicalId);
      }
      if (!entry.wdaEnabled) {
        // Already off. If an earlier stop was never confirmed, try to settle it now instead of
        // pretending everything is stopped.
        if (![this.wdaProcessManager, this.iproxyManager].some(manager => manager.getStatus?.(udid)?.state === "stop_failed")) {
          return this.getLifecycleState(logicalId);
        }
        if (!(await this._clearStopFailures(udid))) throw new LifecycleError("wda_stop_unconfirmed");
        entry.wdaDevice.setComponentHealth({ wdaProcess: "STOPPED", iproxy: "STOPPED", control: "UNAVAILABLE", recovery: "OPERATOR_STOPPED" });
        entry.wdaDevice.clearErrors();
        entry.wdaDevice.discoveryState = "wda_stopped";
        entry.wdaDevice.discoveryStateMessage = "WDA control is stopped by an authorized operator.";
        this.onDeviceListChanged();
        return this.getLifecycleState(logicalId);
      }
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
        throw new LifecycleError("wda_stop_unconfirmed");
      }
      entry.wdaDevice.discoveryState = "wda_stopped";
      entry.wdaDevice.discoveryStateMessage = "WDA control is stopped by an authorized operator.";
      if (entry.wdaDevice.status !== "in-use") entry.wdaDevice.status = "offline";
      entry.wdaDevice.setComponentHealth({
        wdaProcess: "STOPPED", iproxy: "STOPPED", wdaEndpoint: "UNKNOWN",
        control: "UNAVAILABLE", recovery: "OPERATOR_STOPPED",
      });
      // Stopped on purpose is not a failure: an old "endpoint unavailable" or "port in use" error must not stay on the card.
      entry.wdaDevice.clearErrors();
      entry.wdaDevice.recordDiagnosticEvent("WDA_OPERATOR_STOPPED");
      this.onDeviceListChanged();
      return this.getLifecycleState(logicalId);
    });
  }

  startDevice(logicalId, { authorize = null } = {}) {
    return this._serializeLifecycle(logicalId, async () => {
      const { udid, entry } = this._lifecycleEntry(logicalId);
      if (authorize) await authorize();
      if (entry.wdaEnabled) {
        const current = this.getLifecycleState(logicalId);
        // Already on and working (or still coming up): nothing to do.
        if (current.state !== "failed") return current;
        // Failed but still enabled: Start is allowed only when nothing is running any more.
        if (current.startReason === "Control is running but not responding. Use Restart WDA.") {
          throw new LifecycleError("running_not_responding");
        }
      }
      if ([this.wdaProcessManager, this.iproxyManager].some(manager => manager.getStatus?.(udid)?.state === "stop_failed")) {
        if (!(await this._clearStopFailures(udid))) {
          this._markIproxyStopFailed(entry);
          throw new LifecycleError("old_process_would_not_stop");
        }
      }
      const adoptOwnedTunnel = this._ownsIproxyMapping(udid, entry);
      let reservation = null;
      if (!adoptOwnedTunnel) {
        const conflict = await this._resolvePortConflict(entry);
        if (conflict.status !== "free") throw this._markPortConflict(entry, this._conflictError(conflict));
        try {
          reservation = await this._reserveDevicePorts(entry);
        } catch {
          throw this._markPortConflict(entry, this._conflictError({ status: "unidentified", port: entry.port }));
        }
      }
      try {
        if (authorize) await authorize();
        if (this.stopping || this.runtime.get(udid) !== entry) {
          reservation?.release();
          this._assertStillCurrent(udid, entry);
        }
        entry.wdaEnabled = true;
        this._saveRecord(udid, { wdaEnabled: true });
      } catch (error) {
        reservation?.release();
        throw error;
      }
      entry.wdaDevice.discoveryState = "provisioning";
      entry.wdaDevice.discoveryStateMessage = "Starting WDA and the USB tunnel. Verifying end-to-end control.";
      entry.wdaDevice.setComponentError("wdaProcess", null);
      entry.wdaDevice.setComponentError("iproxy", null);
      entry.wdaDevice.invalidateReadiness("OPERATOR_START");
      entry.wdaDevice.setComponentHealth({
        deviceAttachment: "CONNECTED", wdaProcess: "STARTING",
        iproxy: adoptOwnedTunnel ? processHealthState(this._managerState(this.iproxyManager, udid)) : "STARTING",
        wdaEndpoint: "UNKNOWN", control: "UNAVAILABLE", recovery: "IDLE",
      });
      try {
        assertStartResult(this.wdaProcessManager.start({ udid, derivedDataPath: entry.derivedDataPath }));
        if (!adoptOwnedTunnel) {
          assertStartResult(this.iproxyManager.start({ udid, localPort: entry.port, mjpegLocalPort: entry.mjpegPort }));
        }
      } catch (error) {
        await Promise.allSettled([this.wdaProcessManager.stop(udid), this.iproxyManager.stop(udid)]);
        if (error instanceof LifecycleError) {
          this._markStartResultFailure(entry, udid, error);
          throw error;
        }
        entry.wdaEnabled = false;
        try { this._saveRecord(udid, { wdaEnabled: false }); } catch { /* preserve the start error */ }
        entry.wdaDevice.discoveryState = "provisioning_error";
        entry.wdaDevice.discoveryStateMessage = "WDA control could not start. Review diagnostics and retry.";
        entry.wdaDevice.setComponentHealth({ control: "UNAVAILABLE", recovery: "FAILED" });
        this.onDeviceListChanged();
        throw error;
      } finally {
        reservation?.release();
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

// Which of Start / Stop / Restart is allowed, and — for each one that is not — the plain sentence
// that says why. The server decides; the UI only shows it (and the routes enforce the same rules).
//   state: stopped | starting | restarting | ready | enabled | failed | detached
// `blockedMessage`: why the phone is blocked (another program holds its port), so a disabled Start says that
// instead of "running but not responding".
export function lifecycleGuidance({ state, anyRunning = false, inUse = false, attached = true, managed = true, blockedMessage = null, unmanagedReason = null }) {
  if (!managed) {
    const reason = unmanagedReason || "Bodun is not managing this phone's control service.";
    return { canStart: false, canStop: false, canRestart: false, startReason: reason, stopReason: reason, restartReason: reason };
  }
  const busyWithPhone = inUse && attached;
  const running = ["starting", "restarting", "ready", "enabled"].includes(state);

  let canStart = false;
  let startReason = null;
  if (state === "detached") startReason = "Plug the phone in first.";
  else if (state === "stopped" || (state === "failed" && !anyRunning)) canStart = true;
  else if (state === "failed") startReason = blockedMessage || "Control is running but not responding. Use Restart WDA.";
  else startReason = "Already running.";

  let canStop = false;
  let stopReason = null;
  if (state === "stopped") stopReason = "Already stopped.";
  else if (state === "detached") canStop = true;
  else if (busyWithPhone) stopReason = "Release the phone first.";
  else canStop = running || state === "failed";

  let canRestart = false;
  let restartReason = null;
  if (state === "detached") restartReason = "Plug the phone in first.";
  else if (state === "stopped") restartReason = "Start it first.";
  else if (state === "starting" || state === "restarting") restartReason = "Wait for it to finish starting.";
  else if (busyWithPhone) restartReason = "Release the phone first.";
  else canRestart = ["ready", "enabled", "failed"].includes(state);

  return { canStart, canStop, canRestart, startReason, stopReason, restartReason };
}

function processHealthState(state) {
  if (state === "running") return "RUNNING";
  if (state === "starting") return "STARTING";
  if (state === "restarting") return "RESTARTING";
  if (state === "failed") return "FAILED";
  if (state === "stopped") return "STOPPED";
  return "UNKNOWN";
}
