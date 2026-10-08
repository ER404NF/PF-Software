import { spawn as nodeSpawn } from "child_process";
import { SupervisedProcessGroup } from "./processSupervisor.js";

// One iproxy per device, always passing -u <udid> (Automation Architecture
// guide §11 E-IPROXY-002: omitting -u risks silently forwarding to a
// *different* attached phone when more than one is connected).
export class IProxyManager {
  constructor({ spawn = nodeSpawn, bin = process.env.IPROXY_BIN || "iproxy", restartBackoffMs, stableRunMs = 2000, ownershipStore = null } = {}) {
    this.bin = bin;
    this.group = new SupervisedProcessGroup({
      spawn, restartBackoffMs, stableRunMs, logRingSize: 100, retryIndefinitely: true,
      ownership: ownershipStore ? ownershipHooks(ownershipStore, "iproxy") : null,
    });
  }

  on(...args) { this.group.on(...args); return this; }
  isRunning(udid) { return this.group.isRunning(udid); }
  getStatus(udid) { return this.group.getStatus(udid); }
  getLog(udid) { return this.group.getLog(udid); }
  ownsMapping(udid, { localPort, devicePort = 8100, mjpegLocalPort = null, mjpegDevicePort = 9100 } = {}) {
    const definition = this.group.getDefinition?.(udid);
    const state = this.group.getStatus(udid)?.state;
    if (!definition || !["starting", "running"].includes(state)) return false;
    const expected = ["-u", udid, `${localPort}:${devicePort}`,
      ...(mjpegLocalPort !== null ? [`${mjpegLocalPort}:${mjpegDevicePort}`] : [])];
    return definition.bin === this.bin && JSON.stringify(definition.args) === JSON.stringify(expected);
  }
  stop(udid) { return this.group.stop(udid); }
  stopAll() { return this.group.stopAll(); }
  clearBlockedStop(udid, options) { return this.group.clearBlockedStop(udid, options); }

  // One iproxy process forwards both WDA's control port (8100) and, when
  // `mjpegLocalPort` is given, its MJPEG video port (9100): iproxy (libusbmuxd
  // 2.x) accepts several LOCAL:DEVICE pairs, so a phone still has exactly one
  // tunnel process to supervise.
  start({ udid, localPort, devicePort = 8100, mjpegLocalPort = null, mjpegDevicePort = 9100 }) {
    if (!udid) throw new Error("iproxy requires a UDID (never start unscoped)");
    const validPort = port => Number.isSafeInteger(port) && port >= 1 && port <= 65535;
    if (!validPort(localPort)) throw new Error("iproxy requires a valid localPort");
    if (mjpegLocalPort !== null && (!validPort(mjpegLocalPort) || mjpegLocalPort === localPort)) {
      throw new Error("iproxy requires a valid, distinct mjpegLocalPort");
    }
    // "started" | "queued" | "blocked" | "running" (see SupervisedProcessGroup.start)
    return this.group.start(udid, this.bin, [
      "-u", udid,
      `${localPort}:${devicePort}`,
      ...(mjpegLocalPort !== null ? [`${mjpegLocalPort}:${mjpegDevicePort}`] : []),
    ]);
  }
}

// Bridges the supervisor's neutral hooks to the durable ownership store: the
// supervisor only knows a key, a pid and an argv; this adds what the store needs
// (kind, phone UDID, the local ports taken from the `LOCAL:DEVICE` arguments).
export function ownershipHooks(store, kind) {
  return {
    onSpawn: ({ key, pid, bin, args }) => store.record({
      kind, udid: key, pid, bin, args,
      ports: args.filter(arg => /^\d+:\d+$/.test(arg)).map(arg => Number.parseInt(arg.split(":")[0], 10)),
    }),
    onRelease: ({ key, pid }) => store.release({ kind, udid: key, pid }),
    confirmGone: key => store.confirmGone({ kind, udid: key }),
  };
}
