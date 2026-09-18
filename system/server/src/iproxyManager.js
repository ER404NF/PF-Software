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
  getLog(udid) { return this.group.getLog(udid); }
  stop(udid) { this.group.stop(udid); }
  stopAll() { this.group.stopAll(); }

  start({ udid, localPort, devicePort = 8100 }) {
    if (!udid) throw new Error("iproxy requires a UDID (never start unscoped)");
    if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65535) {
      throw new Error("iproxy requires a valid localPort");
    }
    this.group.start(udid, this.bin, ["-u", udid, `${localPort}:${devicePort}`]);
  }
}
