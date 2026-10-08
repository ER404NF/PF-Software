import { EventEmitter } from "events";

// Shared spawn/restart/log-ring bookkeeping for a group of long-running,
// per-device child processes (one xcodebuild per device, one iproxy per
// device — wdaProcessManager.js / iproxyManager.js). Each of those supplies
// its own binary/argv and validation; this owns only the supervision
// mechanics both need identically, so that logic exists exactly once.
export class SupervisedProcessGroup extends EventEmitter {
  constructor({ spawn, restartBackoffMs, logRingSize = 100, stableRunMs = 5 * 60_000,
    retryIndefinitely = false, stopGraceMs = 2000, killWaitMs = 5000,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, ownership = null } = {}) {
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
    // Optional durable ownership hooks (processOwnershipStore.js, wired by the
    // managers): { onSpawn({key,pid,bin,args}), onRelease({key,pid}), confirmGone(key) }.
    // They only ever observe — a hook failure must never affect supervision.
    this.ownership = ownership;
  }

  _ownershipCall(name, payload) {
    try {
      const result = this.ownership?.[name]?.(payload);
      if (result && typeof result.catch === "function") result.catch(() => {});
      return result;
    } catch {
      return undefined;
    }
  }

  isRunning(key) {
    return this.entries.has(key) && !this.entries.get(key).stopped;
  }

  getLog(key) {
    return this.entries.get(key)?.log ?? [];
  }

  getCurrentRunLog(key) {
    return [...(this.entries.get(key)?.currentRunLog ?? [])];
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
  //
  // Returns what actually happened, so callers cannot mistake "nothing was
  // started" for success: "started", "queued" (a replacement waiting for a
  // pending stop), "blocked" (an earlier stop never confirmed exit) or
  // "running" (already running).
  start(key, bin, args, env) {
    if (this.blockedStops.has(key)) {
      this.emit("replacement-blocked", { key, reason: this.blockedStops.get(key) });
      return "blocked";
    }
    if (this.isRunning(key)) return "running";
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
      return "queued";
    }
    launch();
    return "started";
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
    if (Number.isSafeInteger(child.pid)) this._ownershipCall("onSpawn", { key, pid: child.pid, bin, args });
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
    // An 'exit' event is the confirmation that this process is gone (an 'error'
    // event is not: a failed kill also raises it), so only 'exit' releases ownership.
    child.on("exit", (code, signal) => {
      if (Number.isSafeInteger(child.pid)) this._ownershipCall("onRelease", { key, pid: child.pid });
      fail(code, signal);
    });
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
    if (!entry) {
      const pending = this.pendingStops.get(key);
      if (pending) return pending;
      // A second stop after a stop that never confirmed exit must not look like
      // success: the old process may still be alive.
      if (this.blockedStops.has(key)) return Promise.resolve({ ok: false, error: this.blockedStops.get(key) });
      return undefined;
    }
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
      child.off?.("exit", onExit);
      child.off?.("close", onExit);
      child.off?.("error", onKillError);
      if (this.pendingStops.get(key) === stopped) this.pendingStops.delete(key);
      if (result?.ok !== false && Number.isSafeInteger(child.pid)) this._ownershipCall("onRelease", { key, pid: child.pid });
      settle(result);
    };
    // 'exit'/'close' pass (code, signal); `finish` takes a result, so adapt.
    const onExit = () => finish();
    const onKillError = error => {
      // ESRCH proves the old process is already gone. Other kill errors (for
      // example EPERM) do not prove termination, so keep the replacement
      // queued until an exit/close event confirms that its ports are free.
      if (error?.code === "ESRCH") finish();
    };
    child.once?.("exit", onExit);
    child.once?.("close", onExit);
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
          const reason = "process did not confirm exit after SIGKILL; replacement is blocked until Bodun restarts";
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

  // A blocked stop is otherwise permanent until the server restarts. It may be
  // cleared only with proof that the old process is gone: either the kept
  // ownership record shows it (dead pid / different start time), or the caller
  // just reclaimed it itself (`verifiedGone`). Returns whether it was cleared.
  async clearBlockedStop(key, { verifiedGone = false } = {}) {
    if (!this.blockedStops.has(key)) return true;
    const proven = verifiedGone || (await this.ownership?.confirmGone?.(key)) === true;
    if (!proven) return false;
    this.blockedStops.delete(key);
    this._ownershipCall("onRelease", { key, pid: null });
    return true;
  }

  stopAll() {
    return Promise.allSettled([...new Set([...this.entries.keys(), ...this.pendingStops.keys()])].map(key => this.stop(key)));
  }
}
