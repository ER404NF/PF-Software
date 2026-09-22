import { spawn as nodeSpawn } from "child_process";
import { SupervisedProcessGroup } from "./processSupervisor.js";

// One xcodebuild WebDriverAgentRunner per device, launched with an explicit
// argv array (never a shell string — Automation Architecture guide §11
// E-XCODEBUILD-003/004) and a derived-data path unique to this device (§4.2:
// "never share a derivedDataPath between simultaneous devices").
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/;

export class WdaProcessManager {
  // `developmentTeam` (an Apple Developer Team ID) is only supplied for a
  // WebDriverAgent checkout that ships unsigned — Phone Farm's bundled copy.
  // When set, xcodebuild is told to sign with that team via automatic
  // provisioning, under a bundle id unique to the team (Apple bundle ids are
  // global, so the upstream com.facebook.* id can never be registered by
  // another team). When unset the argv is exactly what it always was, so a
  // pre-signed operator checkout behaves as before.
  constructor({
    spawn = nodeSpawn,
    wdaRepoPath,
    xcodebuildBin = process.env.XCODEBUILD_BIN || "xcodebuild",
    restartBackoffMs,
    developmentTeam = process.env.WDA_DEVELOPMENT_TEAM || null,
    bundleId = process.env.WDA_BUNDLE_ID || null,
  } = {}) {
    if (developmentTeam !== null && !TEAM_ID_PATTERN.test(developmentTeam)) {
      throw new Error("WDA_DEVELOPMENT_TEAM must be a 10-character Apple Developer Team ID (letters and digits)");
    }
    if (bundleId !== null && !BUNDLE_ID_PATTERN.test(bundleId)) {
      throw new Error("WDA_BUNDLE_ID must be a reverse-DNS style bundle identifier");
    }
    this.wdaRepoPath = wdaRepoPath;
    this.xcodebuildBin = xcodebuildBin;
    this.developmentTeam = developmentTeam;
    this.bundleId = developmentTeam ? (bundleId || `com.phonefarm.wda.${developmentTeam.toLowerCase()}`) : null;
    this.group = new SupervisedProcessGroup({ spawn, restartBackoffMs, logRingSize: 200 });
  }

  on(...args) { this.group.on(...args); return this; }
  isRunning(udid) { return this.group.isRunning(udid); }
  getStatus(udid) { return this.group.getStatus(udid); }
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
    ];
    if (this.developmentTeam) {
      args.push("-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration");
    }
    args.push("test");
    if (this.developmentTeam) {
      args.push(
        `DEVELOPMENT_TEAM=${this.developmentTeam}`,
        "CODE_SIGN_STYLE=Automatic",
        `PRODUCT_BUNDLE_IDENTIFIER=${this.bundleId}`,
      );
    }
    this.group.start(udid, this.xcodebuildBin, args);
  }
}
