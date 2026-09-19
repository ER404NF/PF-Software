const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  applyFix, buildXcodeAdminScript, findHomebrew, findXcodeDeveloperDir, friendlyAdminError,
} = require("../hostFixes");

const fsWith = (apps, present = apps.map(name => `/Applications/${name}/Contents/Developer`)) => ({
  readdirSync: () => apps,
  existsSync: candidate => present.includes(candidate),
});

test("Xcode.app is preferred; a beta is used only when nothing else is installed", () => {
  assert.equal(findXcodeDeveloperDir(fsWith(["Safari.app", "Xcode-beta.app", "Xcode.app"])), "/Applications/Xcode.app/Contents/Developer");
  assert.equal(findXcodeDeveloperDir(fsWith(["Xcode-beta.app", "Xcode 16.app"])), "/Applications/Xcode 16.app/Contents/Developer");
  assert.equal(findXcodeDeveloperDir(fsWith(["Xcode-beta.app"])), "/Applications/Xcode-beta.app/Contents/Developer");
  assert.equal(findXcodeDeveloperDir(fsWith(["Safari.app", "Pages.app"])), null);
  assert.equal(findXcodeDeveloperDir({ readdirSync: () => { throw new Error("no Applications folder"); }, existsSync: () => true }), null);
});

test("a folder that is not really an Xcode app is never used", () => {
  assert.equal(findXcodeDeveloperDir(fsWith(["Xcode.app"], [])), null, "the Developer folder must exist");
  assert.equal(findXcodeDeveloperDir(fsWith(["Xcode$(reboot).app", "Xcode;rm.app"], ["/Applications/Xcode$(reboot).app/Contents/Developer"])), null);
});

test("the administrator script selects Xcode, accepts the licence and tolerates a first-launch hiccup", () => {
  const script = buildXcodeAdminScript("/Applications/Xcode.app/Contents/Developer");
  assert.match(script, /^do shell script ".*" with administrator privileges$/);
  assert.match(script, /\/usr\/bin\/xcode-select -s '\/Applications\/Xcode\.app\/Contents\/Developer'/);
  assert.match(script, /\/usr\/bin\/xcodebuild -license accept/);
  assert.match(script, /\(\/usr\/bin\/xcodebuild -runFirstLaunch \|\| true\)/);
  assert.match(buildXcodeAdminScript("/Applications/Xcode 16.app/Contents/Developer"), /'\/Applications\/Xcode 16\.app\/Contents\/Developer'/);
});

test("the administrator script refuses anything outside /Applications and cannot be injected into", () => {
  for (const bad of ["/tmp/Xcode.app/Contents/Developer", "/Applications/Xcode.app/Contents/Developer; rm -rf ~", "/Applications/X'.app/Contents/Developer",
    "/Applications/X\".app/Contents/Developer", "../Applications/Xcode.app/Contents/Developer", "/Applications/Xcode.app/Contents/Developer\n"]) {
    assert.throws(() => buildXcodeAdminScript(bad), /unexpected Xcode location/, JSON.stringify(bad));
  }
});

test("Homebrew is found under either Apple silicon or Intel prefix", () => {
  assert.equal(findHomebrew({ existsSync: p => p === "/opt/homebrew/bin/brew" }), "/opt/homebrew/bin/brew");
  assert.equal(findHomebrew({ existsSync: p => p === "/usr/local/bin/brew" }), "/usr/local/bin/brew");
  assert.equal(findHomebrew({ existsSync: () => false }), null);
});

test("cancelling the password prompt gets a calm message, other failures show macOS's own last line", () => {
  assert.match(friendlyAdminError({ stderr: "execution error: User canceled. (-128)" }), /cancelled/);
  assert.match(friendlyAdminError({ message: "boom", stderr: "line one\nxcode-select: error: invalid developer directory\n" }), /invalid developer directory/);
  assert.match(friendlyAdminError({}), /could not finish/);
});

test("an unknown fix, or any fix off a Mac, is refused before anything runs", async () => {
  const boom = () => { throw new Error("must not run"); };
  assert.deepEqual(await applyFix("rm-rf", { platform: "darwin", execFileImpl: boom, spawnImpl: boom }), { ok: false, message: "That fix is not available." });
  assert.equal((await applyFix("xcode", { platform: "win32", execFileImpl: boom })).ok, false);
});

test("the Xcode fix asks macOS for the administrator password once and reports success", async () => {
  const calls = [];
  const lines = [];
  const result = await applyFix("xcode", {
    platform: "darwin", ...fsWith(["Xcode.app"]), onOutput: line => lines.push(line),
    execFileImpl: (file, args, options, callback) => { calls.push([file, args, options.timeout]); callback(null, "", ""); },
  });
  assert.deepEqual(result, { ok: true, message: "Xcode is ready." });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.equal(calls[0][1][0], "-e");
  assert.match(calls[0][1][1], /with administrator privileges/);
  assert.ok(calls[0][2] >= 10 * 60_000, "the first-launch install is allowed to take a while");
  assert.ok(lines.some(line => /password/.test(line)));
});

test("the Xcode fix explains itself when Xcode is missing or the prompt is cancelled", async () => {
  const missing = await applyFix("xcode", { platform: "darwin", ...fsWith([]), execFileImpl: () => { throw new Error("must not run"); } });
  assert.match(missing.message, /Install Xcode from the App Store/);
  const cancelled = await applyFix("xcode", {
    platform: "darwin", ...fsWith(["Xcode.app"]),
    execFileImpl: (file, args, options, callback) => callback(new Error("failed"), "", "execution error: User canceled. (-128)"),
  });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.message, /cancelled/);
});

function fakeSpawn({ code = 0, lines = [], error = null } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (error) return child.emit("error", error);
      for (const line of lines) child.stdout.emit("data", `${line}\n`);
      child.emit("close", code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test("without Homebrew the iPhone-tools fix says what to install instead of failing mysteriously", async () => {
  const result = await applyFix("ios-tools", { platform: "darwin", existsSync: () => false, spawnImpl: () => { throw new Error("must not run"); } });
  assert.equal(result.ok, false);
  assert.match(result.message, /brew\.sh/);
});

test("the iPhone-tools fix installs exactly the two formulae, without a shell, and streams progress", async () => {
  const { spawnImpl, calls } = fakeSpawn({ lines: ["==> Downloading libusbmuxd", "==> Pouring libusbmuxd"] });
  const seen = [];
  const result = await applyFix("ios-tools", { platform: "darwin", existsSync: p => p === "/opt/homebrew/bin/brew", spawnImpl, onOutput: line => seen.push(line) });
  assert.deepEqual(result, { ok: true, message: "The iPhone tools are installed." });
  assert.equal(calls[0].file, "/opt/homebrew/bin/brew");
  assert.deepEqual(calls[0].args, ["install", "libimobiledevice", "libusbmuxd"]);
  assert.equal(calls[0].options.shell, undefined, "no shell involved");
  assert.equal(calls[0].options.env.NONINTERACTIVE, "1");
  assert.equal(calls[0].options.env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.ok(seen.includes("==> Pouring libusbmuxd"));
});

test("a failed Homebrew install reports its last line; a Homebrew that cannot start is reported too", async () => {
  const failed = fakeSpawn({ code: 1, lines: ["Error: No available formula"] });
  const first = await applyFix("ios-tools", { platform: "darwin", existsSync: () => true, spawnImpl: failed.spawnImpl });
  assert.equal(first.ok, false);
  assert.match(first.message, /exit 1: Error: No available formula/);
  const broken = fakeSpawn({ error: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }) });
  const second = await applyFix("ios-tools", { platform: "darwin", existsSync: () => true, spawnImpl: broken.spawnImpl });
  assert.match(second.message, /Could not start Homebrew: spawn EACCES/);
});

test("only one fix runs at a time", async () => {
  let release;
  const first = applyFix("xcode", {
    platform: "darwin", ...fsWith(["Xcode.app"]),
    execFileImpl: (file, args, options, callback) => { release = () => callback(null, "", ""); },
  });
  const second = await applyFix("xcode", { platform: "darwin", ...fsWith(["Xcode.app"]), execFileImpl: () => { throw new Error("must not run"); } });
  assert.match(second.message, /Another fix is still running/);
  release();
  assert.equal((await first).ok, true);
  const third = await applyFix("xcode", { platform: "darwin", ...fsWith(["Xcode.app"]), execFileImpl: (f, a, o, cb) => cb(null, "", "") });
  assert.equal(third.ok, true, "the lock is released afterwards");
});
