import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

// Fails fast with actionable messages instead of looping WDA launches
// against a broken toolchain (Automation Architecture guide §11
// E-WDA-001/E-XCODEBUILD-001: wrong active developer directory; §1.6: "the
// app should detect and guide these states, not pretend they can always be
// bypassed"). Every OS call is injectable so this runs fully off a Mac too.

function binaryAvailable(execFile, bin, args) {
  try {
    execFile(bin, args, { encoding: "utf8", timeout: 3000, windowsHide: true });
    return true;
  } catch (error) {
    // A non-ENOENT failure (nonzero exit, usage text on stderr) still means
    // the binary exists and ran — only "not found" should fail this check.
    return error.code !== "ENOENT";
  }
}

function commandReady(execFile, bin, args) {
  try {
    execFile(bin, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function runHostPreflight({
  platform = process.platform,
  execFile = execFileSync,
  existsSync = fs.existsSync,
  wdaRepoPath = process.env.WDA_REPO_PATH,
  iproxyBin = process.env.IPROXY_BIN || "iproxy",
  xcodeSelectBin = process.env.XCODE_SELECT_BIN || "xcode-select",
  xcodebuildBin = process.env.XCODEBUILD_BIN || "xcodebuild",
  ideviceIdBin = process.env.IDEVICE_ID_BIN || "idevice_id",
  ideviceInfoBin = process.env.IDEVICEINFO_BIN || "ideviceinfo",
} = {}) {
  if (platform !== "darwin") {
    return {
      ok: false,
      fatal: false,
      checks: [{ id: "platform", ok: false, message: "automatic WDA provisioning requires macOS; skipped on this host" }],
    };
  }

  const checks = [];
  const record = (id, ok, message) => checks.push({ id, ok, message });

  let developerDir = "";
  try {
    developerDir = execFile(xcodeSelectBin, ["-p"], { encoding: "utf8", timeout: 3000, windowsHide: true }).trim();
    if (!developerDir || developerDir.includes("CommandLineTools")) {
      record("xcode-select", false,
        `active developer directory is "${developerDir}", not full Xcode. Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`);
    } else {
      record("xcode-select", true, developerDir);
    }
  } catch (error) {
    record("xcode-select", false, `xcode-select failed: ${error.message}. Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`);
  }

  record("xcodebuild", commandReady(execFile, xcodebuildBin, ["-version"]),
    "xcodebuild is not ready. Install/open full Xcode once and accept its license.");

  record("idevice_id", binaryAvailable(execFile, ideviceIdBin, ["-l"]),
    "idevice_id not found. Install libimobiledevice: brew install libimobiledevice");

  record("ideviceinfo", binaryAvailable(execFile, ideviceInfoBin, ["--version"]),
    "ideviceinfo not found. Install libimobiledevice: brew install libimobiledevice");

  record("iproxy", binaryAvailable(execFile, iproxyBin, []),
    `${iproxyBin} not found. Install libusbmuxd: brew install libusbmuxd`);

  if (typeof wdaRepoPath !== "string" || !wdaRepoPath) {
    record("wda-repo", false, "WDA_REPO_PATH is not set. Point it at a local WebDriverAgent checkout (https://github.com/appium/WebDriverAgent)");
  } else if (!existsSync(path.join(wdaRepoPath, "WebDriverAgent.xcodeproj"))) {
    record("wda-repo", false, `WebDriverAgent.xcodeproj not found under ${wdaRepoPath}`);
  } else {
    record("wda-repo", true, wdaRepoPath);
  }

  const fatal = checks.some(c => !c.ok);
  return { ok: !fatal, fatal, checks };
}
