"use strict";

// At launch, before any new server or site agent starts: deal with a previous run's child that is
// still alive (the app crashed or was force-quit, so nobody stopped it). Two Bodun servers fighting
// over the same phones must never happen.
//
// Shared-Mac rule: only a PROVABLY Bodun process is ever signalled. It must still be the very
// process that was recorded — same pid, same start time, same full command line, and it must lead its
// own process group (pgid === pid, how this app starts it). The process is described again right
// before the group SIGKILL. Anything else is just forgotten, never signalled.

const STILL_CLOSING = "Bodun is still closing its previous session. Wait a minute, then open Bodun again. If this keeps happening, restart this Mac.";

async function recoverOrphans({
  store,
  describe,
  kill = (pid, signal) => process.kill(pid, signal),
  killGroup = (pid, signal) => process.kill(-pid, signal),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 10_000,
  pollMs = 250,
  log = () => {},
} = {}) {
  const summary = { terminated: 0, dropped: 0 };
  for (const record of store.list()) {
    const forget = () => { store.remove({ kind: record.kind, pid: record.pid }); summary.dropped += 1; };
    if (record.unverified || !record.startTime || !record.command) {
      // This can mean inspection failed immediately after spawn. Forget it
      // only after ps confirms the pid is gone; otherwise block replacement.
      const now = await Promise.resolve(describe(record.pid)).catch(() => undefined);
      if (now === null) {
        log(`dropping a confirmed-stale unverified record for the ${record.kind}`);
        forget();
        continue;
      }
      throw new Error(STILL_CLOSING);
    }
    const look = async () => {
      const now = await Promise.resolve(describe(record.pid)).catch(() => undefined);
      if (now === undefined) return "unknown";
      if (now === null) return "gone";
      return now.startTime === record.startTime && now.command === record.command && now.pgid === record.pid ? "same" : "different";
    };
    const first = await look();
    if (first === "gone" || first === "different") { forget(); continue; }
    if (first === "unknown") throw new Error(STILL_CLOSING);

    log(`the previous ${record.kind} is still running; asking it to stop`);
    try {
      kill(record.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw new Error(STILL_CLOSING);
    }
    const rounds = Math.max(1, Math.ceil(timeoutMs / pollMs));
    let state = "same";
    for (let round = 0; round < rounds && state === "same"; round += 1) {
      await sleep(pollMs);
      state = await look();
    }
    if (state === "same") {
      // Still there after the grace period: look once more, and only if it is still exactly that
      // process force its whole group.
      if ((await look()) === "same") {
        try { killGroup(record.pid, "SIGKILL"); } catch { /* verified below */ }
        for (let round = 0; round < 8 && (await look()) === "same"; round += 1) await sleep(pollMs);
      }
      state = await look();
    }
    if (state === "same" || state === "unknown") throw new Error(STILL_CLOSING);
    forget();
    summary.terminated += 1;
  }
  return summary;
}

module.exports = { recoverOrphans, STILL_CLOSING };
