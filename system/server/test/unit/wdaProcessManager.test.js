import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { WdaProcessManager } from "../../src/wdaProcessManager.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test("start() builds the argv xcodebuild expects, as an array (never a shell string)", () => {
  const calls = [];
  const spawn = (bin, args) => { calls.push({ bin, args }); return fakeChild(); };
  const manager = new WdaProcessManager({ spawn, wdaRepoPath: "/Users/va/WebDriverAgent" });
  manager.start({ udid: "00008110-ABCDEF1234567890", derivedDataPath: "/tmp/derived/ios-abc" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "xcodebuild");
  assert.deepEqual(calls[0].args, [
    "-project", "/Users/va/WebDriverAgent/WebDriverAgent.xcodeproj",
    "-scheme", "WebDriverAgentRunner",
    "-destination", "id=00008110-ABCDEF1234567890",
    "-derivedDataPath", "/tmp/derived/ios-abc",
    "test",
  ]);
});

// Production-readiness audit §5: WDA's own MJPEG server was never tuned,
// running its conservative defaults (full-resolution, high-quality frames at
// a modest fixed rate) every session — the likely actual cause of "the
// stream feels slow." These three env vars are WDA's own, documented knobs.
test("start() passes WDA's MJPEG tuning env vars to the spawned xcodebuild process, with sensible defaults", () => {
  const calls = [];
  const spawn = (bin, args, options) => { calls.push({ bin, args, options }); return fakeChild(); };
  const manager = new WdaProcessManager({ spawn, wdaRepoPath: "/repo" });
  manager.start({ udid: "00008110-ABCDEF1234567890", derivedDataPath: "/tmp/derived/ios-abc" });
  assert.equal(calls[0].options.env.MJPEG_SERVER_FRAMERATE, "20");
  assert.equal(calls[0].options.env.MJPEG_SERVER_SCREENSHOT_QUALITY, "30");
  assert.equal(calls[0].options.env.MJPEG_SCALING_FACTOR, "50");
  // The spawned process must still inherit the rest of the parent's real
  // environment (PATH, etc.) — these are additions, not a replacement.
  const inheritedPath = Object.entries(calls[0].options.env).find(([key]) => key.toLowerCase() === "path")?.[1];
  assert.equal(inheritedPath, process.env.PATH);
});

test("start() lets each MJPEG tuning value be overridden via this app's own env vars, independently", () => {
  const originalFramerate = process.env.WDA_MJPEG_SERVER_FRAMERATE;
  const originalQuality = process.env.WDA_MJPEG_SERVER_SCREENSHOT_QUALITY;
  process.env.WDA_MJPEG_SERVER_FRAMERATE = "15";
  delete process.env.WDA_MJPEG_SERVER_SCREENSHOT_QUALITY;
  try {
    const calls = [];
    const spawn = (bin, args, options) => { calls.push({ bin, args, options }); return fakeChild(); };
    const manager = new WdaProcessManager({ spawn, wdaRepoPath: "/repo" });
    manager.start({ udid: "00008110-ABCDEF1234567890", derivedDataPath: "/tmp/derived/ios-abc" });
    assert.equal(calls[0].options.env.MJPEG_SERVER_FRAMERATE, "15");
    assert.equal(calls[0].options.env.MJPEG_SERVER_SCREENSHOT_QUALITY, "30"); // default, since unset
  } finally {
    if (originalFramerate === undefined) delete process.env.WDA_MJPEG_SERVER_FRAMERATE;
    else process.env.WDA_MJPEG_SERVER_FRAMERATE = originalFramerate;
    if (originalQuality !== undefined) process.env.WDA_MJPEG_SERVER_SCREENSHOT_QUALITY = originalQuality;
  }
});

test("start() refuses to run without WDA_REPO_PATH configured", () => {
  const manager = new WdaProcessManager({ spawn: () => fakeChild() });
  assert.throws(
    () => manager.start({ udid: "00008110-ABCDEF1234567890", derivedDataPath: "/tmp/x" }),
    /WDA_REPO_PATH is not configured/
  );
});

test("two devices never share a derivedDataPath argument", () => {
  const calls = [];
  const spawn = (bin, args) => { calls.push(args); return fakeChild(); };
  const manager = new WdaProcessManager({ spawn, wdaRepoPath: "/repo" });
  manager.start({ udid: "udid-a", derivedDataPath: "/tmp/derived/a" });
  manager.start({ udid: "udid-b", derivedDataPath: "/tmp/derived/b" });
  const derivedPaths = calls.map(args => args[args.indexOf("-derivedDataPath") + 1]);
  assert.deepEqual(new Set(derivedPaths), new Set(["/tmp/derived/a", "/tmp/derived/b"]));
  assert.notEqual(derivedPaths[0], derivedPaths[1]);
});

test("start() uses the absolute xcodebuild path resolved by the desktop host", () => {
  const calls = [];
  const manager = new WdaProcessManager({
    spawn: (bin, args) => { calls.push({ bin, args }); return fakeChild(); },
    wdaRepoPath: "/repo",
    xcodebuildBin: "/usr/bin/xcodebuild",
  });
  manager.start({ udid: "udid-a", derivedDataPath: "/tmp/derived/a" });
  assert.equal(calls[0].bin, "/usr/bin/xcodebuild");
});

test("with a development team, xcodebuild signs via automatic provisioning under a team-unique bundle id", () => {
  const calls = [];
  const manager = new WdaProcessManager({
    spawn: (bin, args) => { calls.push({ bin, args }); return fakeChild(); },
    wdaRepoPath: "/repo",
    developmentTeam: "ABCDE12345",
  });
  manager.start({ udid: "udid-a", derivedDataPath: "/tmp/derived/a" });
  assert.deepEqual(calls[0].args, [
    "-project", "/repo/WebDriverAgent.xcodeproj",
    "-scheme", "WebDriverAgentRunner",
    "-destination", "id=udid-a",
    "-derivedDataPath", "/tmp/derived/a",
    "-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration",
    "test",
    "DEVELOPMENT_TEAM=ABCDE12345",
    "CODE_SIGN_STYLE=Automatic",
    "PRODUCT_BUNDLE_IDENTIFIER=com.phonefarm.wda.abcde12345",
  ]);
});

test("an explicit bundle id overrides the team-derived default", () => {
  const calls = [];
  const manager = new WdaProcessManager({
    spawn: (bin, args) => { calls.push(args); return fakeChild(); },
    wdaRepoPath: "/repo",
    developmentTeam: "ABCDE12345",
    bundleId: "com.example.wda",
  });
  manager.start({ udid: "udid-a", derivedDataPath: "/tmp/derived/a" });
  assert.ok(calls[0].includes("PRODUCT_BUNDLE_IDENTIFIER=com.example.wda"));
});

test("without a development team the argv carries no signing overrides at all", () => {
  const calls = [];
  const manager = new WdaProcessManager({
    spawn: (bin, args) => { calls.push(args); return fakeChild(); },
    wdaRepoPath: "/repo",
    developmentTeam: null,
    bundleId: "com.ignored.without.team",
  });
  manager.start({ udid: "udid-a", derivedDataPath: "/tmp/derived/a" });
  assert.equal(calls[0].some(arg => /DEVELOPMENT_TEAM|PRODUCT_BUNDLE_IDENTIFIER|allowProvisioning|CODE_SIGN/.test(arg)), false);
});

test("a malformed team id or bundle id is rejected instead of being passed to xcodebuild", () => {
  for (const developmentTeam of ["abc", "ABCDE1234", "ABCDE123456", "ABCDE 2345", "ABCDE1234;"]) {
    assert.throws(() => new WdaProcessManager({ spawn: () => fakeChild(), wdaRepoPath: "/r", developmentTeam }), /WDA_DEVELOPMENT_TEAM/);
  }
  assert.throws(() => new WdaProcessManager({
    spawn: () => fakeChild(), wdaRepoPath: "/r", developmentTeam: "ABCDE12345", bundleId: "bad id;rm",
  }), /WDA_BUNDLE_ID/);
});
