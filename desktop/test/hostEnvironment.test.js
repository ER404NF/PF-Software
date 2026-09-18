const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  buildHostEnvironment,
  discoverWdaRepo,
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
