const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const MAC_SEARCH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function searchDirectories(env = process.env, platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  const inherited = String(env.PATH || env.Path || "").split(delimiter).filter(Boolean);
  return unique(platform === "darwin" ? [...inherited, ...MAC_SEARCH_DIRS] : inherited);
}

function executableExists(candidate, { existsSync = fs.existsSync, accessSync = fs.accessSync } = {}) {
  try {
    if (!existsSync(candidate)) return false;
    accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBinary(names, {
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  accessSync = fs.accessSync,
  pathImpl = platform === "darwin" ? path.posix : path,
} = {}) {
  const requestedNames = Array.isArray(names) ? names : [names];
  for (const directory of searchDirectories(env, platform)) {
    for (const name of requestedNames) {
      const candidate = pathImpl.isAbsolute(name) ? name : pathImpl.join(directory, name);
      if (executableExists(candidate, { existsSync, accessSync })) return candidate;
    }
  }
  return null;
}

function discoverWdaRepo({
  env = process.env,
  persistedPath,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  pathImpl = process.platform === "darwin" ? path.posix : path,
} = {}) {
  const candidates = unique([
    env.WDA_REPO_PATH,
    persistedPath,
    homedir ? pathImpl.join(homedir, "WebDriverAgent") : null,
  ]);
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const resolved = pathImpl.resolve(candidate.trim());
    if (existsSync(pathImpl.join(resolved, "WebDriverAgent.xcodeproj"))) return resolved;
  }
  return null;
}

function runXcodeSelect(xcodeSelectBin, execFile = execFileSync) {
  if (!xcodeSelectBin) return { ok: false, message: "Xcode command-line tools were not found. Install Xcode from the App Store." };
  try {
    const developerDir = String(execFile(xcodeSelectBin, ["-p"], {
      encoding: "utf8", timeout: 5000, windowsHide: true,
    })).trim();
    if (!developerDir || developerDir.includes("CommandLineTools")) {
      return {
        ok: false,
        message: "Full Xcode is not selected. Run sudo xcode-select -s /Applications/Xcode.app/Contents/Developer once.",
      };
    }
    return { ok: true, message: "Ready", detail: developerDir };
  } catch (error) {
    return {
      ok: false,
      message: `Xcode is not ready: ${error.message}. Install Xcode and select it once with xcode-select.`,
    };
  }
}

function runXcodebuild(xcodebuildBin, execFile = execFileSync) {
  if (!xcodebuildBin) return { ok: false, message: "xcodebuild was not found. Install full Xcode from the App Store." };
  try {
    execFile(xcodebuildBin, ["-version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return { ok: true, message: "Ready" };
  } catch (error) {
    return {
      ok: false,
      message: `xcodebuild is not ready: ${error.message}. Open Xcode once to finish installation and accept its license.`,
    };
  }
}

function resolveMacHostDependencies({
  env = process.env,
  platform = process.platform,
  persistedWdaPath,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  accessSync = fs.accessSync,
  execFile = execFileSync,
  routingEnabled = false,
  pathImpl = platform === "darwin" ? path.posix : path,
} = {}) {
  if (platform !== "darwin") {
    return {
      ok: true,
      autoProvision: false,
      tools: {},
      searchPath: searchDirectories(env, platform).join(platform === "win32" ? ";" : ":"),
      checks: [{ id: "platform", label: "Automatic iPhone setup", ok: false, optional: true, message: "Available on macOS hosts." }],
    };
  }

  const resolverOptions = { env, platform, existsSync, accessSync, pathImpl };
  const tools = {
    xcodebuild: resolveBinary("xcodebuild", resolverOptions),
    xcodeSelect: resolveBinary("xcode-select", resolverOptions),
    ideviceId: resolveBinary("idevice_id", resolverOptions),
    ideviceInfo: resolveBinary("ideviceinfo", resolverOptions),
    iproxy: resolveBinary("iproxy", resolverOptions),
    tun2proxy: resolveBinary(["tun2proxy", "tun2proxy-bin"], resolverOptions),
    git: resolveBinary("git", resolverOptions),
  };
  const wdaRepoPath = discoverWdaRepo({ env, persistedPath: persistedWdaPath, homedir, existsSync, pathImpl });
  const xcodeSelection = runXcodeSelect(tools.xcodeSelect, execFile);
  const xcodebuild = runXcodebuild(tools.xcodebuild, execFile);
  const checks = [
    {
      id: "xcode",
      label: "Xcode",
      ok: xcodeSelection.ok && xcodebuild.ok,
      message: !xcodeSelection.ok ? xcodeSelection.message : xcodebuild.message,
      detail: xcodeSelection.detail,
    },
    {
      id: "ios-device-tools",
      label: "iOS device tools",
      ok: Boolean(tools.ideviceId && tools.ideviceInfo),
      message: tools.ideviceId && tools.ideviceInfo ? "Ready" : "Install libimobiledevice: brew install libimobiledevice",
    },
    {
      id: "iproxy",
      label: "iproxy",
      ok: Boolean(tools.iproxy),
      message: tools.iproxy ? "Ready" : "Install libusbmuxd: brew install libusbmuxd",
    },
    {
      id: "wda-repo",
      label: "WebDriverAgent",
      ok: Boolean(wdaRepoPath),
      message: wdaRepoPath ? "Ready" : "WebDriverAgent was not found. Place a configured checkout at ~/WebDriverAgent or set WDA_REPO_PATH.",
    },
  ];
  if (routingEnabled) {
    checks.push({
      id: "tun2proxy",
      label: "tun2proxy",
      ok: Boolean(tools.tun2proxy),
      message: tools.tun2proxy ? "Ready" : "Proxy routing is enabled but neither tun2proxy nor tun2proxy-bin was found.",
    });
  }
  return {
    ok: checks.every(check => check.ok || check.optional),
    autoProvision: true,
    tools,
    wdaRepoPath,
    searchPath: searchDirectories(env, platform).join(":"),
    checks,
  };
}

function buildHostEnvironment(baseEnv, resolved) {
  const env = {
    ...baseEnv,
    PATH: resolved.searchPath || baseEnv.PATH || "",
    // Tells the source-tree and packaged server not to load the repository's
    // example devices.config.json unless an explicit DEVICE_CONFIG_PATH was
    // supplied. This is a mode flag, not a fake empty config file.
    DESKTOP_AUTO_DEVICE_MODE: "true",
  };
  if (!resolved.autoProvision) return env;
  env.AUTO_PROVISION_WDA = "true";
  env.AUTO_DISCOVER_IOS_DEVICES = "true";
  env.WDA_REPO_PATH = resolved.wdaRepoPath;
  env.XCODEBUILD_BIN = resolved.tools.xcodebuild;
  env.XCODE_SELECT_BIN = resolved.tools.xcodeSelect;
  env.IDEVICE_ID_BIN = resolved.tools.ideviceId;
  env.IDEVICEINFO_BIN = resolved.tools.ideviceInfo;
  env.IPROXY_BIN = resolved.tools.iproxy;
  if (resolved.tools.tun2proxy) env.TUN2PROXY_BIN = resolved.tools.tun2proxy;
  return env;
}

module.exports = {
  MAC_SEARCH_DIRS,
  buildHostEnvironment,
  discoverWdaRepo,
  resolveBinary,
  resolveMacHostDependencies,
  searchDirectories,
};
