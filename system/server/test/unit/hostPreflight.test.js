import { test } from "node:test";
import assert from "node:assert/strict";
import { runHostPreflight } from "../../src/hostPreflight.js";

function fakeExecFile(responses) {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`.trim();
    if (key in responses) {
      const result = responses[key];
      if (result instanceof Error) throw result;
      return result;
    }
    if (key === "xcodebuild -version") return "Xcode 16.0\n";
    if (key === "ideviceinfo --version") return "1.3.0\n";
    throw Object.assign(new Error(`unexpected command: ${key}`), { code: "ENOENT" });
  };
}

test("preflight is a non-fatal skip away from macOS", () => {
  const result = runHostPreflight({ platform: "win32" });
  assert.equal(result.ok, false);
  assert.equal(result.fatal, false);
  assert.equal(result.checks[0].id, "platform");
});

test("preflight passes when every check succeeds", () => {
  const result = runHostPreflight({
    platform: "darwin",
    execFile: fakeExecFile({
      "xcode-select -p": "/Applications/Xcode.app/Contents/Developer\n",
      "idevice_id -l": "",
      "iproxy": "usage: iproxy ...",
    }),
    existsSync: () => true,
    wdaRepoPath: "/Users/va/WebDriverAgent",
    iproxyBin: "iproxy",
  });
  assert.equal(result.ok, true);
  assert.equal(result.fatal, false);
  assert.ok(result.checks.every(c => c.ok));
});

test("preflight flags CommandLineTools as not full Xcode", () => {
  const result = runHostPreflight({
    platform: "darwin",
    execFile: fakeExecFile({
      "xcode-select -p": "/Library/Developer/CommandLineTools\n",
      "idevice_id -l": "",
      "iproxy": "",
    }),
    existsSync: () => true,
    wdaRepoPath: "/Users/va/WebDriverAgent",
  });
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  const xcode = result.checks.find(c => c.id === "xcode-select");
  assert.equal(xcode.ok, false);
  assert.match(xcode.message, /not full Xcode/);
});

test("preflight distinguishes a missing binary (ENOENT) from one that just exited non-zero", () => {
  const result = runHostPreflight({
    platform: "darwin",
    execFile: fakeExecFile({
      "xcode-select -p": "/Applications/Xcode.app/Contents/Developer\n",
      // idevice_id -l intentionally not stubbed -> ENOENT via fakeExecFile's default throw
      "iproxy": new Error("usage error"), // present, but exits non-zero — still "available"
    }),
    existsSync: () => true,
    wdaRepoPath: "/Users/va/WebDriverAgent",
  });
  const idevice = result.checks.find(c => c.id === "idevice_id");
  const iproxy = result.checks.find(c => c.id === "iproxy");
  assert.equal(idevice.ok, false);
  assert.equal(iproxy.ok, true);
});

test("preflight requires WDA_REPO_PATH to point at an actual WebDriverAgent checkout", () => {
  const result = runHostPreflight({
    platform: "darwin",
    execFile: fakeExecFile({
      "xcode-select -p": "/Applications/Xcode.app/Contents/Developer\n",
      "idevice_id -l": "",
      "iproxy": "",
    }),
    existsSync: () => false,
    wdaRepoPath: "/Users/va/WebDriverAgent",
  });
  const wdaRepo = result.checks.find(c => c.id === "wda-repo");
  assert.equal(wdaRepo.ok, false);
  assert.match(wdaRepo.message, /WebDriverAgent.xcodeproj not found/);
});

test("preflight reports a clear message when WDA_REPO_PATH is unset", () => {
  const result = runHostPreflight({
    platform: "darwin",
    execFile: fakeExecFile({
      "xcode-select -p": "/Applications/Xcode.app/Contents/Developer\n",
      "idevice_id -l": "",
      "iproxy": "",
    }),
    existsSync: () => true,
    wdaRepoPath: undefined,
  });
  const wdaRepo = result.checks.find(c => c.id === "wda-repo");
  assert.equal(wdaRepo.ok, false);
  assert.match(wdaRepo.message, /WDA_REPO_PATH is not set/);
});

test("preflight uses resolved absolute binary paths supplied by the desktop host", () => {
  const calls = [];
  const execFile = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "/usr/bin/xcode-select") return "/Applications/Xcode.app/Contents/Developer\n";
    return "available\n";
  };
  const result = runHostPreflight({
    platform: "darwin",
    execFile,
    existsSync: () => true,
    wdaRepoPath: "/Users/va/WebDriverAgent",
    xcodeSelectBin: "/usr/bin/xcode-select",
    xcodebuildBin: "/usr/bin/xcodebuild",
    ideviceIdBin: "/opt/homebrew/bin/idevice_id",
    ideviceInfoBin: "/opt/homebrew/bin/ideviceinfo",
    iproxyBin: "/opt/homebrew/bin/iproxy",
  });
  assert.equal(result.ok, true);
  assert.ok(calls.includes("/usr/bin/xcodebuild -version"));
  assert.ok(calls.includes("/opt/homebrew/bin/idevice_id -l"));
  assert.ok(calls.includes("/opt/homebrew/bin/ideviceinfo --version"));
  assert.ok(calls.includes("/opt/homebrew/bin/iproxy "));
});

test("preflight fails when ideviceinfo or xcodebuild is missing", () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const result = runHostPreflight({
    platform: "darwin",
    execFile: fakeExecFile({
      "xcode-select -p": "/Applications/Xcode.app/Contents/Developer\n",
      "xcodebuild -version": missing,
      "idevice_id -l": "",
      "ideviceinfo --version": missing,
      "iproxy": "",
    }),
    existsSync: () => true,
    wdaRepoPath: "/Users/va/WebDriverAgent",
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === "xcodebuild").ok, false);
  assert.equal(result.checks.find(check => check.id === "ideviceinfo").ok, false);
});
