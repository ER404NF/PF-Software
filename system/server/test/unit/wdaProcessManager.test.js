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
