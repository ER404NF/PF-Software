"use strict";

// Stops the processes this app started (the Bodun server, the site agent) and WAITS for them.
//
// The old quit handler sent a termination signal and let Electron exit at once, so the server's own
// cleanup (which stops every iproxy and WebDriverAgent it runs) could be cut short, and a quick relaunch
// could race an old server that was still cleaning up. Here: ask politely (SIGTERM), wait up to
// `timeoutMs`, and only then force the stragglers.
//
// Safety: a signal is only ever sent through a child handle this process spawned and that has not
// exited. The one process-group signal is sent in the timeout branch, while that handle is live and
// un-reaped, so the group (the child plus its own iproxy/xcodebuild children) is certainly ours.

function hasExited(child) {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (hasExited(child)) return resolve();
    child.once("exit", () => resolve());
  });
}

function safely(action) {
  try { action(); return true; } catch { return false; }
}

async function shutdownChildren({
  children,
  timeoutMs = 10_000,
  forcedWaitMs = 2_000,
  platform = process.platform,
  killGroup = (pid, signal) => process.kill(-pid, signal),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const live = (children ?? []).filter(child => child && !hasExited(child));
  const result = { exited: 0, forced: [] };
  if (live.length === 0) return result;

  for (const child of live) safely(() => child.kill("SIGTERM"));

  const race = (promise, ms) => new Promise(resolve => {
    const timer = setTimeoutFn(() => resolve(false), ms);
    timer.unref?.();
    promise.then(() => { clearTimeoutFn(timer); resolve(true); });
  });

  const graceful = await race(Promise.all(live.map(waitForExit)), timeoutMs);
  if (!graceful) {
    for (const child of live) {
      if (hasExited(child)) continue;
      const groupKill = child.isGroupLeader === true && platform !== "win32" && Number.isSafeInteger(child.pid);
      if (groupKill && safely(() => killGroup(child.pid, "SIGKILL"))) { result.forced.push(child.pid); continue; }
      if (safely(() => child.kill("SIGKILL"))) result.forced.push(child.pid);
    }
    await race(Promise.all(live.map(waitForExit)), forcedWaitMs);
  }
  result.exited = live.filter(hasExited).length;
  return result;
}

module.exports = { shutdownChildren, hasExited };
