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
