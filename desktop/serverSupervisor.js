// Restart policy for the local Phone Farm server. A farm host has to survive a crash without anyone
// noticing: the server is restarted with a growing delay, but a server that keeps dying is left alone and
// reported, because restarting it forever would hide a real problem and burn the phones' Apple app-ID quota.

function createRestartPolicy({ maxRestarts = 5, windowMs = 10 * 60_000, baseDelayMs = 1000, maxDelayMs = 30_000, now = Date.now } = {}) {
  const restarts = [];
  const prune = () => {
    const cutoff = now() - windowMs;
    while (restarts.length && restarts[0] < cutoff) restarts.shift();
  };
  return {
    // The delay before the next restart, or null when the server has crashed too often to keep trying.
    next() {
      prune();
      if (restarts.length >= maxRestarts) return null;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** restarts.length);
      restarts.push(now());
      return delay;
    },
    recentRestarts() {
      prune();
      return restarts.length;
    },
    reset() {
      restarts.length = 0;
    },
  };
}

// The server binds 127.0.0.1. If something else already holds the usual port (another Phone Farm, a development
// server, another tool on a shared Mac) the app moves to the next free one instead of failing with no explanation.
const net = require("net");

function isPortFree(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

async function findFreePort(preferred, { host = "127.0.0.1", tries = 30, isFree = isPortFree } = {}) {
  for (let offset = 0; offset < tries; offset += 1) {
    const port = preferred + offset;
    if (port > 65535) break;
    if (await isFree(port, host)) return port;
  }
  throw new Error(`No free port was found between ${preferred} and ${preferred + tries - 1}. Close whatever is using them and try again.`);
}

module.exports = { createRestartPolicy, findFreePort, isPortFree };
