const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  buildHostEnvironment,
  discoverWdaRepo,
  discoverWdaSource,
  resolveMacHostDependencies,
} = require("../hostEnvironment");

const UDID_TOOLS = ["idevice_id", "ideviceinfo", "iproxy"];

function fakeMac({ prefix, tunName = null, wdaPath = "/Users/operator/WebDriverAgent", omit = [] } = {}) {
  const files = new Set([
    "/usr/bin/xcodebuild",
    "/usr/bin/xcode-select",
    ...UDID_TOOLS.map(name => `${prefix}/${name}`),
    `${wdaPath}/WebDriverAgent.xcodeproj`,
  ]);
  if (tunName) files.add(`${prefix}/${tunName}`);
  for (const name of omit) {
    for (const file of [...files]) if (file.endsWith(`/${name}`)) files.delete(file);
  }
  return {
    env: { PATH: "" },
    platform: "darwin",
    homedir: "/Users/operator",
    existsSync: candidate => files.has(candidate),
    accessSync: () => {},
    execFile: (command, args) => {
      if (command === "/usr/bin/xcode-select") return "/Applications/Xcode.app/Contents/Developer\n";
      assert.deepEqual([command, args], ["/usr/bin/xcodebuild", ["-version"]]);
      return "Xcode 16.0\n";
    },
    pathImpl: path.posix,
  };
}

test("Apple Silicon Homebrew tools and ~/WebDriverAgent are discovered without Finder PATH", () => {
  const result = resolveMacHostDependencies(fakeMac({ prefix: "/opt/homebrew/bin", tunName: "tun2proxy-bin" }));
  assert.equal(result.ok, true);
  assert.equal(result.tools.ideviceId, "/opt/homebrew/bin/idevice_id");
  assert.equal(result.tools.iproxy, "/opt/homebrew/bin/iproxy");
  assert.equal(result.tools.tun2proxy, "/opt/homebrew/bin/tun2proxy-bin");
  assert.equal(result.wdaRepoPath, "/Users/operator/WebDriverAgent");
});

test("Intel Homebrew tools and tun2proxy are discovered under /usr/local/bin", () => {
  const result = resolveMacHostDependencies(fakeMac({ prefix: "/usr/local/bin", tunName: "tun2proxy" }));
  assert.equal(result.ok, true);
  assert.equal(result.tools.ideviceInfo, "/usr/local/bin/ideviceinfo");
  assert.equal(result.tools.tun2proxy, "/usr/local/bin/tun2proxy");
});

test("WDA discovery validates environment, persisted, and home candidates in order", () => {
  const existing = new Set([
    "/persisted/WebDriverAgent.xcodeproj",
    "/Users/test/WebDriverAgent/WebDriverAgent.xcodeproj",
  ]);
  assert.equal(discoverWdaRepo({
    env: { WDA_REPO_PATH: "/missing" },
    persistedPath: "/persisted",
    homedir: "/Users/test",
    existsSync: candidate => existing.has(candidate),
    pathImpl: path.posix,
  }), "/persisted");
});

test("missing WDA, idevice tools, and iproxy fail closed with actionable checks", () => {
  const result = resolveMacHostDependencies(fakeMac({
    prefix: "/opt/homebrew/bin",
    wdaPath: "/missing",
    omit: ["idevice_id", "iproxy", "WebDriverAgent.xcodeproj"],
  }));
  assert.equal(result.ok, false);
  assert.match(result.checks.find(check => check.id === "wda-repo").message, /WebDriverAgent was not found/);
  assert.match(result.checks.find(check => check.id === "ios-device-tools").message, /brew install libimobiledevice/);
  assert.match(result.checks.find(check => check.id === "iproxy").message, /brew install libusbmuxd/);
});

test("host environment enables automatic WDA with resolved absolute tools and leaves routing opt-in", () => {
  const resolved = resolveMacHostDependencies(fakeMac({ prefix: "/opt/homebrew/bin", tunName: "tun2proxy-bin" }));
  const env = buildHostEnvironment({ AUTO_ROUTE_PROXY_TUNNELS: "false" }, resolved);
  assert.equal(env.AUTO_PROVISION_WDA, "true");
  assert.equal(env.AUTO_DISCOVER_IOS_DEVICES, "true");
  assert.equal(env.DESKTOP_AUTO_DEVICE_MODE, "true");
  assert.equal(Object.hasOwn(env, "DEVICE_CONFIG_PATH"), false);
  assert.equal(env.WDA_REPO_PATH, "/Users/operator/WebDriverAgent");
  assert.equal(env.IPROXY_BIN, "/opt/homebrew/bin/iproxy");
  assert.equal(env.IDEVICE_ID_BIN, "/opt/homebrew/bin/idevice_id");
  assert.equal(env.XCODEBUILD_BIN, "/usr/bin/xcodebuild");
  assert.equal(env.TUN2PROXY_BIN, "/opt/homebrew/bin/tun2proxy-bin");
  assert.equal(env.AUTO_ROUTE_PROXY_TUNNELS, "false");
});

test("tun2proxy is required only when routing was explicitly enabled", () => {
  const options = fakeMac({ prefix: "/opt/homebrew/bin" });
  assert.equal(resolveMacHostDependencies(options).ok, true);
  const routing = resolveMacHostDependencies({ ...options, routingEnabled: true });
  assert.equal(routing.ok, false);
  assert.equal(routing.checks.find(check => check.id === "tun2proxy").ok, false);
});

// ---- bundled (managed) WebDriverAgent + signing -------------------------

function managedMac(options = {}) {
  const mac = fakeMac({ prefix: "/opt/homebrew/bin", wdaPath: "/missing-home-wda", omit: ["WebDriverAgent.xcodeproj"], ...options });
  const files = new Set([
    "/usr/bin/xcodebuild", "/usr/bin/xcode-select",
    ...UDID_TOOLS.map(name => `/opt/homebrew/bin/${name}`),
    "/Users/operator/Library/Application Support/Phone Farm/wda-source/16.12.1-6e2b5c026f72/WebDriverAgent/WebDriverAgent.xcodeproj",
  ]);
  return { ...mac, existsSync: candidate => files.has(candidate) };
}
const MANAGED = "/Users/operator/Library/Application Support/Phone Farm/wda-source/16.12.1-6e2b5c026f72/WebDriverAgent";

test("the operator's own ~/WebDriverAgent (already signed) outranks the bundled copy; the bundle is the fallback", () => {
  const files = new Set([`${MANAGED}/WebDriverAgent.xcodeproj`, "/Users/operator/WebDriverAgent/WebDriverAgent.xcodeproj"]);
  const both = discoverWdaSource({ env: {}, managedPath: MANAGED, homedir: "/Users/operator", existsSync: candidate => files.has(candidate), pathImpl: path.posix });
  assert.deepEqual(both, { path: "/Users/operator/WebDriverAgent", source: "home" });
  files.delete("/Users/operator/WebDriverAgent/WebDriverAgent.xcodeproj");
  const bundledOnly = discoverWdaSource({ env: {}, managedPath: MANAGED, homedir: "/Users/operator", existsSync: candidate => files.has(candidate), pathImpl: path.posix });
  assert.deepEqual(bundledOnly, { path: MANAGED, source: "managed" });
});

test("Phone Farm's bundled WebDriverAgent is used when the operator supplied none", () => {
  const result = resolveMacHostDependencies({ ...managedMac(), managedWdaPath: MANAGED });
  assert.equal(result.wdaRepoPath, MANAGED);
  assert.equal(result.wdaSource, "managed");
});

test("an operator-supplied WDA (environment, saved, or home) wins over the bundled copy", () => {
  const env = { PATH: "", WDA_REPO_PATH: "/opt/my-wda" };
  const files = new Set(["/opt/my-wda/WebDriverAgent.xcodeproj", `${MANAGED}/WebDriverAgent.xcodeproj`]);
  const found = discoverWdaRepo({ env, managedPath: MANAGED, homedir: "/Users/x", existsSync: candidate => files.has(candidate), pathImpl: path.posix });
  assert.equal(found, "/opt/my-wda");
  const saved = discoverWdaRepo({ env: {}, persistedPath: "/opt/saved", managedPath: MANAGED, homedir: "/Users/x",
    existsSync: candidate => candidate === "/opt/saved/WebDriverAgent.xcodeproj" || candidate === `${MANAGED}/WebDriverAgent.xcodeproj`, pathImpl: path.posix });
  assert.equal(saved, "/opt/saved");
});

test("the unsigned bundled WDA needs a development team; host setup asks for it instead of failing silently", () => {
  const result = resolveMacHostDependencies({ ...managedMac(), managedWdaPath: MANAGED });
  assert.equal(result.ok, false);
  const signing = result.checks.find(check => check.id === "wda-signing");
  assert.equal(signing.ok, false);
  assert.equal(signing.needsInput, "wdaDevelopmentTeam");
  assert.match(signing.message, /Team ID/);
});

test("several detected teams are listed, never guessed", () => {
  const result = resolveMacHostDependencies({ ...managedMac(), managedWdaPath: MANAGED, signingCandidates: ["TEAMONE111", "TEAMTWO222"] });
  const signing = result.checks.find(check => check.id === "wda-signing");
  assert.equal(signing.ok, false);
  assert.match(signing.message, /TEAMONE111, TEAMTWO222/);
});

test("with a team the bundled WDA is ready and the server is told to sign with it", () => {
  const resolved = resolveMacHostDependencies({ ...managedMac(), managedWdaPath: MANAGED, developmentTeam: "TEAMONE111" });
  assert.equal(resolved.ok, true);
  const env = buildHostEnvironment({ WDA_BUNDLE_ID: "inherited.should.go" }, resolved);
  assert.equal(env.WDA_REPO_PATH, MANAGED);
  assert.equal(env.WDA_DEVELOPMENT_TEAM, "TEAMONE111");
  assert.equal(Object.hasOwn(env, "WDA_BUNDLE_ID"), false);
});

test("an operator's own WDA checkout never receives signing overrides", () => {
  const resolved = resolveMacHostDependencies(fakeMac({ prefix: "/opt/homebrew/bin" }));
  assert.equal(resolved.wdaSource, "home");
  const env = buildHostEnvironment({ WDA_DEVELOPMENT_TEAM: "INHERITED12", WDA_BUNDLE_ID: "x.y" }, resolved);
  assert.equal(Object.hasOwn(env, "WDA_DEVELOPMENT_TEAM"), false);
  assert.equal(Object.hasOwn(env, "WDA_BUNDLE_ID"), false);
  assert.equal(resolved.checks.some(check => check.id === "wda-signing"), false);
});

test("a missing WDA message points at reinstalling the app, which bundles it", () => {
  const result = resolveMacHostDependencies(fakeMac({ prefix: "/opt/homebrew/bin", wdaPath: "/missing", omit: ["WebDriverAgent.xcodeproj"] }));
  assert.match(result.checks.find(check => check.id === "wda-repo").message, /Reinstall Phone Farm/);
});

// ---- one-click fixes are offered only when they can work ----------------------------------------

test("Xcode that is installed but not selected gets a Fix it, in plain words", () => {
  const mac = fakeMac({ prefix: "/opt/homebrew/bin" });
  const files = new Set(["/usr/bin/xcodebuild", "/usr/bin/xcode-select", "/Applications/Xcode.app/Contents/Developer",
    ...UDID_TOOLS.map(name => `/opt/homebrew/bin/${name}`), "/Users/operator/WebDriverAgent/WebDriverAgent.xcodeproj"]);
  const result = resolveMacHostDependencies({
    ...mac,
    existsSync: candidate => files.has(candidate),
    readdirSync: () => ["Safari.app", "Xcode.app"],
    execFile: (command) => { if (command === "/usr/bin/xcode-select") return "/Library/Developer/CommandLineTools\n"; throw new Error("not reached"); },
  });
  const xcode = result.checks.find(check => check.id === "xcode");
  assert.equal(xcode.ok, false);
  assert.equal(xcode.fixable, "xcode");
  assert.match(xcode.message, /Click Fix it/);
  assert.doesNotMatch(xcode.message, /sudo/, "nobody is asked to type sudo");
});

test("with no Xcode on the disk there is nothing to fix, and the message says to install it", () => {
  const mac = fakeMac({ prefix: "/opt/homebrew/bin" });
  const result = resolveMacHostDependencies({
    ...mac,
    readdirSync: () => ["Safari.app"],
    execFile: (command) => { if (command === "/usr/bin/xcode-select") return "/Library/Developer/CommandLineTools\n"; throw new Error("not reached"); },
  });
  const xcode = result.checks.find(check => check.id === "xcode");
  assert.equal(xcode.fixable, undefined);
  assert.match(xcode.message, /Full Xcode is not selected/);
});

test("missing iPhone tools get a Fix it only when Homebrew is there to install them", () => {
  const withBrew = fakeMac({ prefix: "/opt/homebrew/bin", omit: ["iproxy", "idevice_id", "ideviceinfo"] });
  const brewFiles = new Set(["/usr/bin/xcodebuild", "/usr/bin/xcode-select", "/opt/homebrew/bin/brew", "/Users/operator/WebDriverAgent/WebDriverAgent.xcodeproj"]);
  const fixable = resolveMacHostDependencies({ ...withBrew, existsSync: candidate => brewFiles.has(candidate) });
  for (const id of ["ios-device-tools", "iproxy"]) {
    const check = fixable.checks.find(entry => entry.id === id);
    assert.equal(check.fixable, "ios-tools", id);
    assert.match(check.message, /Click Fix it/, id);
  }

  const noBrew = resolveMacHostDependencies(fakeMac({ prefix: "/opt/homebrew/bin", omit: ["iproxy", "idevice_id", "ideviceinfo"] }));
  for (const id of ["ios-device-tools", "iproxy"]) {
    const check = noBrew.checks.find(entry => entry.id === id);
    assert.equal(check.fixable, undefined, id);
    assert.match(check.message, /brew\.sh/, id);
  }
});

test("a row that is already fine never shows a Fix it", () => {
  const result = resolveMacHostDependencies(fakeMac({ prefix: "/opt/homebrew/bin" }));
  assert.ok(result.checks.every(check => check.fixable === undefined));
});
