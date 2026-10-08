const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkMacosIcon, validateCandidate } = require("../scripts/check-macos-icon.cjs");

const desktopDir = path.resolve(__dirname, "..");
const candidate = path.join(desktopDir, "build", "candidates", "icon.icon");
const packageJson = require("../package.json");

test("the layered-icon candidate has the files Icon Composer needs and a transparent logo layer", () => {
  assert.deepEqual(validateCandidate(candidate), []);
  const manifest = JSON.parse(fs.readFileSync(path.join(candidate, "icon.json"), "utf8"));
  assert.equal(manifest.groups[0].layers[0]["image-name"], "logo.png");
  assert.deepEqual(fs.readFileSync(path.join(candidate, "Assets", "logo.png")), fs.readFileSync(path.join(desktopDir, "build", "icon.png")),
    "the candidate uses the same Bodun mark as the shipped icon");
});

test("a layer with no transparency, or a missing layer image, is reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bodun-icon-test-"));
  try {
    fs.mkdirSync(path.join(dir, "Assets"));
    fs.writeFileSync(path.join(dir, "icon.json"), JSON.stringify({ groups: [{ layers: [{ "image-name": "logo.png", name: "logo" }, { "image-name": "gone.png", name: "gone" }] }] }));
    const opaque = Buffer.from(fs.readFileSync(path.join(candidate, "Assets", "logo.png")));
    opaque[25] = 2; // colour type 2 = RGB, no alpha
    fs.writeFileSync(path.join(dir, "Assets", "logo.png"), opaque);
    const problems = validateCandidate(dir);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /not transparent/);
    assert.match(problems[1], /missing image/);
    assert.deepEqual(validateCandidate(path.join(dir, "nowhere")), ["icon.json is missing from nowhere"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("off a Mac the check says it needs a Mac with Xcode 26 and does not fail", () => {
  const result = checkMacosIcon({ platform: "win32", exec: () => { throw new Error("must not run"); } });
  assert.equal(result.ok, true);
  assert.equal(result.compiled, false);
  assert.match(result.message, /needs a Mac with Xcode 26/);
});

test("on a Mac without Xcode's icon compiler it says so", () => {
  const result = checkMacosIcon({ platform: "darwin", exec: () => { throw new Error("xcrun: unable to find actool"); } });
  assert.equal(result.ok, true);
  assert.equal(result.compiled, false);
  assert.match(result.message, /install Xcode 26/);
});

test("on a Mac with Xcode 26 it compiles the candidate into a temporary folder and reports", () => {
  const calls = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bodun-icon-out-"));
  try {
    const exec = (command, args) => { calls.push([command, ...args]); return command === "xcrun" && args.includes("--version") ? "version: 26.0\n" : ""; };
    const result = checkMacosIcon({ platform: "darwin", exec, tmpdir: tmp });
    assert.equal(result.ok, true);
    assert.equal(result.compiled, true);
    assert.deepEqual(calls[0], ["xcrun", "actool", "--version"]);
    assert.equal(calls[1][2], candidate, "compiles the candidate, not the shipped icon");
    assert.ok(calls[1].includes("--compile"));
    assert.ok(calls[1][calls[1].indexOf("--compile") + 1].startsWith(tmp), "output goes to a temporary folder");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a compile failure is reported in plain words", () => {
  const exec = (command, args) => {
    if (args.includes("--version")) return "version: 26.0\n";
    const error = new Error("failed");
    error.stderr = "icon.json: unknown key\nmore detail";
    throw error;
  };
  const result = checkMacosIcon({ platform: "darwin", exec });
  assert.equal(result.ok, false);
  assert.match(result.message, /Xcode could not compile the icon candidate: icon.json: unknown key/);
});

test("the installer still uses the shipped icon, and the candidate is not among the packaged inputs", () => {
  assert.equal(packageJson.build.mac.icon, "build/icon.png");
  assert.equal(packageJson.build.win.icon, "build/icon.png");
  const inputs = [...packageJson.build.files, ...packageJson.build.extraResources.flatMap(entry => [entry.from, ...(entry.filter || [])])];
  assert.ok(!inputs.some(input => String(input).includes("candidates")), "nothing packages the candidate folder");
});

test("the release guide names the one-line switch and the Mac checks", () => {
  const guide = fs.readFileSync(path.resolve(desktopDir, "../docs/MAC_RELEASE.md"), "utf8");
  assert.match(guide, /build\/candidates\/icon\.icon/);
  assert.match(guide, /"icon": "build\/candidates\/icon\.icon"/);
  assert.match(guide, /check-macos-icon\.cjs/);
});
