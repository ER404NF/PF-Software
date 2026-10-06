import { EventEmitter } from "events";

// Shared spawn/restart/log-ring bookkeeping for a group of long-running,
// per-device child processes (one xcodebuild per device, one iproxy per
// device — wdaProcessManager.js / iproxyManager.js). Each of those supplies
// its own binary/argv and validation; this owns only the supervision
// mechanics both need identically, so that logic exists exactly once.
export class SupervisedProcessGroup extends EventEmitter {
  constructor({ spawn, restartBackoffMs, logRingSize = 100, stableRunMs = 5 * 60_000,
    retryIndefinitely = false, stopGraceMs = 2000, killWaitMs = 5000,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    super();
    if (typeof spawn !== "function") throw new Error("a spawn function is required");
    this.spawn = spawn;
    this.restartBackoffMs = restartBackoffMs ?? [1000, 2000, 5000, 15000, 30000];
    this.logRingSize = logRingSize;
    this.stableRunMs = stableRunMs;
    this.retryIndefinitely = retryIndefinitely;
    this.stopGraceMs = stopGraceMs;
    this.killWaitMs = killWaitMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.entries = new Map(); // key -> { child, log, restartCount, restartTimer, stopped }
    this.pendingStops = new Map();
    this.generations = new Map();
    this.blockedStops = new Map();
  }

  isRunning(key) {
    return this.entries.has(key) && !this.entries.get(key).stopped;
  }

  getLog(key) {
    return this.entries.get(key)?.log ?? [];
  }

  getStatus(key) {
    if (this.blockedStops.has(key)) return { state: "stop_failed", restartCount: 0, error: this.blockedStops.get(key) };
    const entry = this.entries.get(key);
    if (!entry) return { state: "stopped", restartCount: 0 };
    return { state: entry.state, restartCount: entry.restartCount };
  }

  getDefinition(key) {
    const entry = this.entries.get(key);
    return entry ? { bin: entry.bin, args: [...entry.args] } : null;
  }

  // `bin`/`args` describe the OS process; `key` is this group's identity
  // for the device (a UDID). Restarts reuse the same bin/args/env every
  // time. `env` is optional extra environment merged over process.env (e.g.
  // WDA's MJPEG tuning vars) — omitting it keeps the previous, unchanged
  // behavior of simply inheriting the parent process's environment.
  start(key, bin, args, env) {
    if (this.blockedStops.has(key)) {
      this.emit("replacement-blocked", { key, reason: this.blockedStops.get(key) });
      return false;
    }
    if (this.isRunning(key)) return;
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const launch = () => {
      if (this.generations.get(key) !== generation || this.isRunning(key)) return;
      const entry = { child: null, log: [], currentRunLog: [], restartCount: 0, restartTimer: null,
        stableTimer: null, stopped: false, state: "starting", persistentFailureReported: false, bin, args, env };
      this.entries.set(key, entry);
      this._spawnNow(key, bin, args, env);
    };
    const pendingStop = this.pendingStops.get(key);
    if (pendingStop) {
      // A replacement must not bind the same local ports until the old
      // process has actually exited. A later stop invalidates this generation
      // so a detach cannot leave a deferred orphan behind.
      pendingStop.then(result => {
        if (result?.ok === false || this.blockedStops.has(key)) {
          this.emit("replacement-blocked", { key, reason: result?.error || this.blockedStops.get(key) });
          return;
        }
        launch();
      });
    } else {
      launch();
    }
  }

  _appendLog(entry, line) {
    entry.log.push(line);
    entry.currentRunLog.push(line);
    if (entry.log.length > this.logRingSize) entry.log.shift();
    if (entry.currentRunLog.length > this.logRingSize) entry.currentRunLog.shift();
  }

  _spawnNow(key, bin, args, env) {
    const entry = this.entries.get(key);
    if (!entry || entry.stopped) return;
    // Failure classification must only inspect this launch. Keeping output
    // from an old signing failure here could misclassify a later USB blip as
    // a still-unresolved manual prerequisite and stop automatic recovery.
    entry.currentRunLog = [];
    let child;
    try {
      child = this.spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
    } catch (error) {
      this._appendLog(entry, `spawn error: ${error.message}`);
      this.emit("log", { key, stream: "stderr", line: `spawn error: ${error.message}` });
      this._processFailed(key, entry, null, null);
      return;
    }
    entry.child = child;
    entry.state = "running";
    this.emit("starting", { key });
    // A missing executable emits `error` without `exit`. Some other child
    // failures can emit both, so settle this spawn exactly once.
    let settled = false;
    if (Number.isFinite(this.stableRunMs) && this.stableRunMs > 0) {
      entry.stableTimer = this.setTimeoutFn(() => {
        if (settled || entry.stopped || this.entries.get(key) !== entry || entry.child !== child) return;
        entry.restartCount = 0;
        entry.persistentFailureReported = false;
        entry.stableTimer = null;
        this.emit("stable", { key });
      }, this.stableRunMs);
      entry.stableTimer.unref?.();
    }
    const fail = (code, signal) => {
      if (settled) return;
      settled = true;
      if (entry.stableTimer) this.clearTimeoutFn(entry.stableTimer);
      entry.stableTimer = null;
      this._processFailed(key, entry, code, signal);
    };
    child.stdout?.on("data", (chunk) => this._appendLog(entry, chunk.toString()));
    child.stderr?.on("data", (chunk) => {
      const line = chunk.toString();
      this._appendLog(entry, line);
      this.emit("log", { key, stream: "stderr", line });
    });
    child.on("error", (error) => {
      this._appendLog(entry, `spawn error: ${error.message}`);
      this.emit("log", { key, stream: "stderr", line: `spawn error: ${error.message}` });
      fail(null, null);
    });
    child.on("exit", fail);
  }

  _processFailed(key, entry, code, signal) {
    if (entry.stopped || this.entries.get(key) !== entry) return;
    entry.child = null;
    this.emit("exit", { key, code, signal, log: [...entry.currentRunLog] });
    // An exit listener may classify the failure as requiring a human action
    // and deliberately stop/delete this entry. Respect that decision before
    // scheduling a retry or publishing a generic restart-limit failure.
    if (entry.stopped || this.entries.get(key) !== entry) return;
    if (entry.restartCount >= this.restartBackoffMs.length) {
      if (this.retryIndefinitely) {
        if (!entry.persistentFailureReported) {
          entry.persistentFailureReported = true;
          this.emit("persistent-failure", {
            key,
            restartCount: entry.restartCount,
            log: [...entry.currentRunLog],
          });
          if (entry.stopped || this.entries.get(key) !== entry) return;
        }
        const delay = this.restartBackoffMs.at(-1) ?? 30_000;
        entry.state = "restarting";
        entry.restartTimer = this.setTimeoutFn(() => this._spawnNow(key, entry.bin, entry.args, entry.env), delay);
        entry.restartTimer.unref?.();
        return;
      }
      // Permanently dead, not merely between restarts — isRunning(key)
      // must reflect that (a caller like a health-check loop depends on
      // it to detect this exact case), while getLog(key) still works for
      // post-mortem diagnostics since the entry itself is kept.
      entry.stopped = true;
      entry.state = "failed";
      this.emit("restart-limit-exceeded", { key, restartCount: entry.restartCount, log: [...entry.currentRunLog] });
      return;
    }
    const delay = this.restartBackoffMs[entry.restartCount];
    entry.restartCount += 1;
    entry.state = "restarting";
    entry.restartTimer = this.setTimeoutFn(() => this._spawnNow(key, entry.bin, entry.args, entry.env), delay);
    entry.restartTimer.unref?.();
  }

  stop(key) {
    const entry = this.entries.get(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    if (!entry) return this.pendingStops.get(key);
    entry.stopped = true;
    entry.state = "stopped";
    if (entry.restartTimer) this.clearTimeoutFn(entry.restartTimer);
    if (entry.stableTimer) this.clearTimeoutFn(entry.stableTimer);
    this.entries.delete(key);
    const child = entry.child;
    if (!child) return;

    let settle;
    const stopped = new Promise(resolve => { settle = resolve; });
    this.pendingStops.set(key, stopped);
    let forceTimer = null;
    let killWaitTimer = null;
    let done = false;
    const finish = (result = { ok: true }) => {
      if (done) return;
      done = true;
      if (forceTimer) this.clearTimeoutFn(forceTimer);
      if (killWaitTimer) this.clearTimeoutFn(killWaitTimer);
      child.off?.("exit", finish);
      child.off?.("close", finish);
      child.off?.("error", onKillError);
      if (this.pendingStops.get(key) === stopped) this.pendingStops.delete(key);
      settle(result);
    };
    const onKillError = error => {
      // ESRCH proves the old process is already gone. Other kill errors (for
      // example EPERM) do not prove termination, so keep the replacement
      // queued until an exit/close event confirms that its ports are free.
      if (error?.code === "ESRCH") finish();
    };
    child.once?.("exit", finish);
    child.once?.("close", finish);
    child.on?.("error", onKillError);
    try {
      child.kill?.();
    } catch (error) {
      onKillError(error);
    }
    if (done) return stopped;
    if (child.exitCode !== null && child.exitCode !== undefined) {
      finish();
      return stopped;
    }
    forceTimer = this.setTimeoutFn(() => {
      try { child.kill?.("SIGKILL"); } catch (error) { onKillError(error); }
      if (!done) {
        killWaitTimer = this.setTimeoutFn(() => {
          const reason = "process did not confirm exit after SIGKILL; replacement is blocked until relay restart";
          this.blockedStops.set(key, reason);
          this.emit("stop-timeout", { key, reason });
          finish({ ok: false, error: reason });
        }, this.killWaitMs);
        killWaitTimer.unref?.();
      }
    }, this.stopGraceMs);
    forceTimer.unref?.();
    return stopped;
  }

  stopAll() {
    return Promise.allSettled([...new Set([...this.entries.keys(), ...this.pendingStops.keys()])].map(key => this.stop(key)));
  }
}
