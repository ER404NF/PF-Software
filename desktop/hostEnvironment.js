const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { findHomebrew, findXcodeDeveloperDir } = require("./hostFixes");

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

// Where the WebDriverAgent checkout comes from, in precedence order:
//   1. WDA_REPO_PATH    - explicit operator override
//   2. persistedPath    - a checkout the operator chose earlier
//   3. ~/WebDriverAgent - the operator's own checkout. A host that is already
//                         logged in to Apple Developer with WDA set up in Xcode
//                         keeps using it; nothing to configure.
//   4. managedPath      - Phone Farm's own bundled, unmodified WDA, copied to a
//                         writable folder outside the signed app (wdaSource.js)
//                         and used only when the host has none of its own.
// A checkout from 1-3 is the operator's own and is assumed to be signed
// already; only "managed" (unsigned) needs a development team.
function discoverWdaSource({
  env = process.env,
  persistedPath,
  managedPath,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  pathImpl = process.platform === "darwin" ? path.posix : path,
} = {}) {
  const candidates = [
    { source: "environment", value: env.WDA_REPO_PATH },
    { source: "saved", value: persistedPath },
    { source: "home", value: homedir ? pathImpl.join(homedir, "WebDriverAgent") : null },
    { source: "managed", value: managedPath },
  ];
  for (const { source, value } of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    const resolved = pathImpl.resolve(value.trim());
    if (existsSync(pathImpl.join(resolved, "WebDriverAgent.xcodeproj"))) return { path: resolved, source };
  }
  return null;
}

function discoverWdaRepo(options = {}) {
  return discoverWdaSource(options)?.path ?? null;
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
  managedWdaPath,
  developmentTeam = null,
  signingCandidates = [],
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  accessSync = fs.accessSync,
  readdirSync = fs.readdirSync,
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
  const wda = discoverWdaSource({ env, persistedPath: persistedWdaPath, managedPath: managedWdaPath, homedir, existsSync, pathImpl });
  const wdaRepoPath = wda?.path ?? null;
  const xcodeSelection = runXcodeSelect(tools.xcodeSelect, execFile);
  const xcodebuild = runXcodebuild(tools.xcodebuild, execFile);
  // "Fix it" is offered only when the fix can actually work: Xcode is on disk (it just is not selected or finished
  // its first-time setup), or Homebrew is available to install the iPhone tools.
  const xcodeReady = xcodeSelection.ok && xcodebuild.ok;
  const xcodeFixable = !xcodeReady && Boolean(findXcodeDeveloperDir({ readdirSync, existsSync }));
  const brew = findHomebrew({ existsSync });
  const toolsFix = brew ? "ios-tools" : undefined;
  const checks = [
    {
      id: "xcode",
      label: "Xcode",
      ok: xcodeReady,
      ...(xcodeFixable ? { fixable: "xcode" } : {}),
      message: xcodeReady ? "Ready"
        : xcodeFixable ? "Xcode is installed but not set up for Phone Farm yet. Click Fix it; macOS will ask for your Mac password once."
          : !xcodeSelection.ok ? xcodeSelection.message : xcodebuild.message,
      detail: xcodeSelection.detail,
    },
    {
      id: "ios-device-tools",
      label: "iOS device tools",
      ok: Boolean(tools.ideviceId && tools.ideviceInfo),
      ...(toolsFix ? { fixable: toolsFix } : {}),
      message: tools.ideviceId && tools.ideviceInfo ? "Ready"
        : brew ? "The iPhone tools are not installed yet. Click Fix it to install them automatically (a few minutes)."
          : "Install libimobiledevice: brew install libimobiledevice (Homebrew is needed first: https://brew.sh)",
    },
    {
      id: "iproxy",
      label: "iproxy",
      ok: Boolean(tools.iproxy),
      ...(toolsFix ? { fixable: toolsFix } : {}),
      message: tools.iproxy ? "Ready"
        : brew ? "The USB connection tool is not installed yet. Click Fix it to install it automatically (a few minutes)."
          : "Install libusbmuxd: brew install libusbmuxd (Homebrew is needed first: https://brew.sh)",
    },
    {
      id: "wda-repo",
      label: "WebDriverAgent",
      ok: Boolean(wdaRepoPath),
      message: wdaRepoPath
        ? "Ready"
        : "WebDriverAgent was not found. Reinstall Phone Farm (it bundles WebDriverAgent), or place a configured checkout at ~/WebDriverAgent / set WDA_REPO_PATH.",
    },
  ];
  // Phone Farm's bundled WebDriverAgent ships unsigned, so it needs the
  // operator's Apple development team. A checkout the operator supplied
  // themselves is assumed to be signed already and is left alone.
  if (wda?.source === "managed") {
    const detectedList = signingCandidates.join(", ");
    checks.push({
      id: "wda-signing",
      label: "WebDriverAgent signing",
      ok: Boolean(developmentTeam),
      needsInput: developmentTeam ? undefined : "wdaDevelopmentTeam",
      message: developmentTeam
        ? `Apple development team ${developmentTeam}`
        : signingCandidates.length > 1
          ? `Several Apple development teams were found (${detectedList}). Enter the Team ID to use for signing WebDriverAgent.`
          : "Enter your Apple Developer Team ID (10 characters, shown at developer.apple.com under Membership) so Phone Farm can sign its bundled WebDriverAgent. Xcode must be signed in to the same Apple ID.",
    });
  }
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
    wdaSource: wda?.source ?? null,
    wdaDevelopmentTeam: wda?.source === "managed" ? developmentTeam : null,
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
  // Signing overrides only for the bundled (unsigned) WDA; never inherited
  // from the parent environment for an operator-supplied checkout.
  delete env.WDA_DEVELOPMENT_TEAM;
  delete env.WDA_BUNDLE_ID;
  if (resolved.wdaSource === "managed" && resolved.wdaDevelopmentTeam) env.WDA_DEVELOPMENT_TEAM = resolved.wdaDevelopmentTeam;
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
  discoverWdaSource,
  resolveBinary,
  resolveMacHostDependencies,
  searchDirectories,
};
