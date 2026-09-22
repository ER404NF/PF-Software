import { EventEmitter } from "events";

// Shared spawn/restart/log-ring bookkeeping for a group of long-running,
// per-device child processes (one xcodebuild per device, one iproxy per
// device — wdaProcessManager.js / iproxyManager.js). Each of those supplies
// its own binary/argv and validation; this owns only the supervision
// mechanics both need identically, so that logic exists exactly once.
export class SupervisedProcessGroup extends EventEmitter {
  constructor({ spawn, restartBackoffMs, logRingSize = 100, stableRunMs = 5 * 60_000,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    super();
    if (typeof spawn !== "function") throw new Error("a spawn function is required");
    this.spawn = spawn;
    this.restartBackoffMs = restartBackoffMs ?? [1000, 2000, 5000, 15000, 30000];
    this.logRingSize = logRingSize;
    this.stableRunMs = stableRunMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.entries = new Map(); // key -> { child, log, restartCount, restartTimer, stopped }
  }

  isRunning(key) {
    return this.entries.has(key) && !this.entries.get(key).stopped;
  }

  getLog(key) {
    return this.entries.get(key)?.log ?? [];
  }

  getStatus(key) {
    const entry = this.entries.get(key);
    if (!entry) return { state: "stopped", restartCount: 0 };
    return { state: entry.state, restartCount: entry.restartCount };
  }

  // `bin`/`args` describe the OS process; `key` is this group's identity
  // for the device (a UDID). Restarts reuse the same bin/args every time.
  start(key, bin, args) {
    if (this.isRunning(key)) return;
    const entry = { child: null, log: [], restartCount: 0, restartTimer: null,
      stableTimer: null, stopped: false, state: "starting", bin, args };
    this.entries.set(key, entry);
    this._spawnNow(key, bin, args);
  }

  _appendLog(entry, line) {
    entry.log.push(line);
    if (entry.log.length > this.logRingSize) entry.log.shift();
  }

  _spawnNow(key, bin, args) {
    const entry = this.entries.get(key);
    if (!entry || entry.stopped) return;
    let child;
    try {
      child = this.spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
    this.emit("exit", { key, code, signal, log: [...entry.log] });
    // An exit listener may classify the failure as requiring a human action
    // and deliberately stop/delete this entry. Respect that decision before
    // scheduling a retry or publishing a generic restart-limit failure.
    if (entry.stopped || this.entries.get(key) !== entry) return;
    if (entry.restartCount >= this.restartBackoffMs.length) {
      // Permanently dead, not merely between restarts — isRunning(key)
      // must reflect that (a caller like a health-check loop depends on
      // it to detect this exact case), while getLog(key) still works for
      // post-mortem diagnostics since the entry itself is kept.
      entry.stopped = true;
      entry.state = "failed";
      this.emit("restart-limit-exceeded", { key, restartCount: entry.restartCount, log: [...entry.log] });
      return;
    }
    const delay = this.restartBackoffMs[entry.restartCount];
    entry.restartCount += 1;
    entry.state = "restarting";
    entry.restartTimer = this.setTimeoutFn(() => this._spawnNow(key, entry.bin, entry.args), delay);
    entry.restartTimer.unref?.();
  }

  stop(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.stopped = true;
    entry.state = "stopped";
    if (entry.restartTimer) this.clearTimeoutFn(entry.restartTimer);
    if (entry.stableTimer) this.clearTimeoutFn(entry.stableTimer);
    entry.child?.kill?.();
    this.entries.delete(key);
  }

  stopAll() {
    for (const key of [...this.entries.keys()]) this.stop(key);
  }
}
