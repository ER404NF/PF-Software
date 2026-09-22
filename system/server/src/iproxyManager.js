import { spawn as nodeSpawn } from "child_process";
import { SupervisedProcessGroup } from "./processSupervisor.js";

// One iproxy per device, always passing -u <udid> (Automation Architecture
// guide §11 E-IPROXY-002: omitting -u risks silently forwarding to a
// *different* attached phone when more than one is connected).
export class IProxyManager {
  constructor({ spawn = nodeSpawn, bin = process.env.IPROXY_BIN || "iproxy", restartBackoffMs } = {}) {
    this.bin = bin;
    this.group = new SupervisedProcessGroup({ spawn, restartBackoffMs, logRingSize: 100 });
  }

  on(...args) { this.group.on(...args); return this; }
  isRunning(udid) { return this.group.isRunning(udid); }
  getStatus(udid) { return this.group.getStatus(udid); }
  getLog(udid) { return this.group.getLog(udid); }
  stop(udid) { this.group.stop(udid); }
  stopAll() { this.group.stopAll(); }

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
    this.group.start(udid, this.bin, [
      "-u", udid,
      `${localPort}:${devicePort}`,
      ...(mjpegLocalPort !== null ? [`${mjpegLocalPort}:${mjpegDevicePort}`] : []),
    ]);
  }
}
