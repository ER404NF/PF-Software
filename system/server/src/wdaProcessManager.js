import { spawn as nodeSpawn } from "child_process";
import { SupervisedProcessGroup } from "./processSupervisor.js";

// One xcodebuild WebDriverAgentRunner per device, launched with an explicit
// argv array (never a shell string — Automation Architecture guide §11
// E-XCODEBUILD-003/004) and a derived-data path unique to this device (§4.2:
// "never share a derivedDataPath between simultaneous devices").
export class WdaProcessManager {
  constructor({ spawn = nodeSpawn, wdaRepoPath, xcodebuildBin = process.env.XCODEBUILD_BIN || "xcodebuild", restartBackoffMs } = {}) {
    this.wdaRepoPath = wdaRepoPath;
    this.xcodebuildBin = xcodebuildBin;
    this.group = new SupervisedProcessGroup({ spawn, restartBackoffMs, logRingSize: 200 });
  }

  on(...args) { this.group.on(...args); return this; }
  isRunning(udid) { return this.group.isRunning(udid); }
  getLog(udid) { return this.group.getLog(udid); }
  stop(udid) { this.group.stop(udid); }
  stopAll() { this.group.stopAll(); }

  start({ udid, derivedDataPath }) {
    if (!this.wdaRepoPath) throw new Error("WDA_REPO_PATH is not configured");
    if (!udid || !derivedDataPath) throw new Error("WDA process requires udid and derivedDataPath");
    const args = [
      "-project", `${this.wdaRepoPath}/WebDriverAgent.xcodeproj`,
      "-scheme", "WebDriverAgentRunner",
      "-destination", `id=${udid}`,
      "-derivedDataPath", derivedDataPath,
      "test",
    ];
    this.group.start(udid, this.xcodebuildBin, args);
  }
}
