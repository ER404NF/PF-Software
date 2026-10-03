// Tests for the double-click macOS installer at the repository root, "Install Phone Farm.command".
//
// The script is run for real under bash with stand-in `curl`, `uname`, `sw_vers`, `sysctl`, `xattr`,
// `open` and `shasum` commands placed first on PATH, so every scenario (release lookup, download
// failures, checksum mismatch, wrong architecture ...) runs offline and never touches GitHub.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const SCRIPT_NAME = "Install Phone Farm.command";
const scriptPath = path.join(repoRoot, SCRIPT_NAME);
const GH = "https://github.com/ER404NF/PF-Software";

function findBash() {
  if (process.platform !== "win32") return fs.existsSync("/bin/bash") ? "/bin/bash" : null;
  const gitBash = path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
  return fs.existsSync(gitBash) ? gitBash : null;
}
const bash = findBash();
const skip = bash ? false : "bash is not available on this machine";

// Paths handed to Git Bash on Windows must be POSIX-style (/c/Users/...).
function sh(p) {
  if (process.platform !== "win32") return p;
  return p.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/");
}

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");

// Stand-in commands (curl, uname, sysctl, sw_vers, xattr, open, shasum). CRs are stripped in case a
// Windows checkout converted their line endings.
const stubDir = path.join(__dirname, "helpers", "mac-bootstrap-stubs");
const STUBS = Object.fromEntries(fs.readdirSync(stubDir).map(name =>
  [name, fs.readFileSync(path.join(stubDir, name), "utf8").split(String.fromCharCode(13)).join("")]));

const PKG_BYTES = Buffer.from("xar!fake Phone Farm installer package bytes\n".repeat(64));

// Builds a sandbox and runs the installer. `routes` maps URL -> action string.
function run({ routes = {}, env = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-bootstrap-test-"));
  const bin = path.join(dir, "bin");
  const tmp = path.join(dir, "tmp");
  const cwd = path.join(dir, "cwd");
  const fixtures = path.join(dir, "fixtures");
  for (const d of [bin, tmp, cwd, fixtures]) fs.mkdirSync(d);
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(fixtures, name), body);
  const lines = Object.entries(routes).map(([url, action]) =>
    `${url} ${action.replace(/\{fixtures\}/g, sh(fixtures))}`);
  const routesFile = path.join(dir, "routes.txt");
  fs.writeFileSync(routesFile, `${lines.join("\n")}\n`);
  const logFile = path.join(dir, "calls.log");
  fs.writeFileSync(logFile, "");

  const result = spawnSync(bash, ["-c", 'export PATH="$PF_TEST_BIN:$PATH"; exec bash "$PF_TEST_SCRIPT"'], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PF_TEST_BIN: sh(bin),
      PF_TEST_SCRIPT: sh(scriptPath),
      TMPDIR: sh(tmp),
      FAKE_ROUTES: sh(routesFile),
      FAKE_LOG: sh(logFile),
      PHONE_FARM_NONINTERACTIVE: "1",
      ...env,
    },
  });
  const log = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  const tmpEntries = fs.readdirSync(tmp);
  const kept = tmpEntries.flatMap(entry => fs.readdirSync(path.join(tmp, entry)));
  const cwdEntries = fs.readdirSync(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}`, log, tmpEntries, kept, cwdEntries };
}

// A published release vX with the given installer assets (name -> {sidecar, sums, corrupt, partial}).
function release(version, assets, { sums = false } = {}) {
  const routes = {
    "https://github.com/": "ok",
    [`${GH}/releases/latest`]: `redirect ${GH}/releases/tag/v${version}`,
  };
  const files = {};
  const sumLines = [];
  for (const [name, options = {}] of Object.entries(assets)) {
    files[name] = PKG_BYTES;
    const digest = options.digest || sha256(PKG_BYTES);
    const base = `${GH}/releases/download/v${version}/${name}`;
    routes[base] = options.partial ? `partial {fixtures}/${name}` : `file {fixtures}/${options.corrupt ? `${name}.bad` : name}`;
    if (options.corrupt) files[`${name}.bad`] = Buffer.concat([PKG_BYTES, Buffer.from("tampered")]);
    if (options.sidecar !== false) {
      files[`${name}.sha256`] = options.sidecarText ?? `${digest}  ${name}\n`;
      routes[`${base}.sha256`] = `file {fixtures}/${name}.sha256`;
    }
    if (options.inSums) sumLines.push(`${digest}  ${name}`);
  }
  if (sums || sumLines.length) {
    files["SHA256SUMS.txt"] = `${sumLines.join("\n")}\n`;
    routes[`${GH}/releases/download/v${version}/SHA256SUMS.txt`] = "file {fixtures}/SHA256SUMS.txt";
  }
  return { routes, files };
}

const openCalls = log => log.filter(line => line.startsWith("open "));
const indexOfCall = (log, prefix) => log.findIndex(line => line.startsWith(prefix));

// ------------------------------------------------------------------- the file itself

test("the installer is at the repository root, is a bash script with LF endings and tracked as executable", () => {
  assert.ok(fs.existsSync(scriptPath), `${SCRIPT_NAME} must exist at the repository root`);
  const text = fs.readFileSync(scriptPath, "utf8");
  assert.match(text, /^#!\/bin\/bash\n/);
  assert.ok(!text.includes("\r"), "CRLF line endings break bash on macOS");
  const git = spawnSync("git", ["ls-files", "-s", "--", SCRIPT_NAME], { cwd: repoRoot, encoding: "utf8" });
  if (git.error) return; // git is not installed here; CI has it
  assert.match(git.stdout, /^100755 /, `${SCRIPT_NAME} must be tracked by git with the executable bit (git add --chmod=+x)`);
  const attributes = spawnSync("git", ["check-attr", "eol", "--", SCRIPT_NAME], { cwd: repoRoot, encoding: "utf8" });
  assert.match(attributes.stdout, /eol: lf/);
});

test("the installer never weakens macOS security, never builds from source and needs no Node or npm", () => {
  const code = fs.readFileSync(scriptPath, "utf8").split("\n").filter(line => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /spctl\s+--master-disable|spctl\s+--global-disable|--add\b/);
  assert.doesNotMatch(code, /xattr\s+-(d|c|r)/, "quarantine must never be removed");
  assert.doesNotMatch(code, /\bsudo\b|\binstaller\s+-pkg\b|\bnpm\b|\bnode\b|electron|git\s+/);
  assert.match(code, /shasum -a 256/);
  assert.match(code, /com\.apple\.quarantine/);
  assert.doesNotMatch(code, /0\.2\.2/, "the version must never be hard-coded");
});

test("the installer passes bash syntax checking (and shellcheck when it is installed)", { skip }, () => {
  const syntax = spawnSync(bash, ["-n", sh(scriptPath)], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const which = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
  if (which.error) return;
  const lint = spawnSync("shellcheck", ["--shell=bash", "--severity=warning", scriptPath], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout);
});

test("the developer build script stays out of the repository root and is clearly labelled", { skip }, () => {
  const devScript = path.join(repoRoot, "desktop", "scripts", "build-macos-installer.sh");
  const text = fs.readFileSync(devScript, "utf8");
  assert.match(text, /^#!\/bin\/bash\n# DEVELOPER TOOL/);
  assert.match(text, /NOT how people install Phone Farm/);
  assert.equal(spawnSync(bash, ["-n", sh(devScript)], { encoding: "utf8" }).status, 0);
  const git = spawnSync("git", ["ls-files", "-s", "--", "desktop/scripts/build-macos-installer.sh"], { cwd: repoRoot, encoding: "utf8" });
  if (!git.error) assert.match(git.stdout, /^100755 /);
  const rootScripts = fs.readdirSync(repoRoot).filter(name => /\.(command|sh|cmd|bat|mjs)$/i.test(name));
  assert.deepEqual(rootScripts, [SCRIPT_NAME], "the only runnable file at the root is the end-user installer");
});

// ------------------------------------------------------------------- pure functions

function callFunctions(snippet) {
  return spawnSync(bash, ["-c", `source "$PF_TEST_SCRIPT"; ${snippet}`], {
    encoding: "utf8", env: { ...process.env, PF_TEST_SCRIPT: sh(scriptPath) },
  });
}

test("version parsing accepts release tags and rejects anything else", { skip }, () => {
  const result = callFunctions(`
    pf_tag_from_url "${GH}/releases/tag/v0.2.3"
    pf_tag_from_url "${GH}/releases/tag/v1.0.0"
    pf_tag_from_url "${GH}/releases/tag/v1.2.3-rc.1"
    pf_tag_from_url "${GH}/releases" || echo reject-list
    pf_tag_from_url "${GH}/releases/tag/v1.2.3;rm" || echo reject-injection
    pf_tag_from_url "${GH}/releases/tag/latest" || echo reject-word
    pf_version_from_tag v10.20.30
    pf_version_from_tag 0.3.0
    pf_version_from_tag ../x || echo reject-path
  `);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "v0.2.3", "v1.0.0", "v1.2.3-rc.1", "reject-list", "reject-injection", "reject-word", "10.20.30", "0.3.0", "reject-path",
  ]);
});

test("asset selection: Apple silicon prefers its own package, Intel only ever gets the universal one", { skip }, () => {
  const arm = callFunctions("pf_candidates 0.3.0 arm64").stdout.trim().split("\n");
  assert.deepEqual(arm, [
    "Phone-Farm-0.3.0-arm64.pkg", "Phone-Farm-0.3.0-arm64-NOT-NOTARIZED.pkg", "Phone-Farm-0.3.0-arm64-UNSIGNED.pkg",
    "Phone-Farm-0.3.0-universal.pkg", "Phone-Farm-0.3.0-universal-NOT-NOTARIZED.pkg", "Phone-Farm-0.3.0-universal-UNSIGNED.pkg",
  ]);
  const intel = callFunctions("pf_candidates 1.0.0 x86_64").stdout.trim().split("\n");
  assert.ok(intel.length === 3 && intel.every(name => name.includes("-universal")), intel.join(", "));
  // These are exactly the names the release pipeline produces.
  const { artifactFileName } = require("../scripts/build-mac-pkg.cjs");
  for (const level of ["notarized", "signed", "unsigned"]) {
    assert.ok(arm.includes(artifactFileName({ version: "0.3.0", arch: "arm64", level })));
    assert.ok(arm.includes(artifactFileName({ version: "0.3.0", arch: "universal", level })));
  }
});

test("architecture detection: arm64, Intel, Apple silicon under Rosetta, and unsupported CPUs", { skip }, () => {
  const detect = env => spawnSync(bash, ["-c", 'export PATH="$PF_TEST_BIN:$PATH"; source "$PF_TEST_SCRIPT"; pf_detect_arch || echo unsupported'], {
    encoding: "utf8", env: { ...process.env, PF_TEST_SCRIPT: sh(scriptPath), PF_TEST_BIN: sh(stubBin), ...env },
  }).stdout.trim();
  const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "pf-arch-"));
  for (const name of ["uname", "sysctl"]) fs.writeFileSync(path.join(stubBin, name), STUBS[name], { mode: 0o755 });
  try {
    assert.equal(detect({ FAKE_UNAME_M: "arm64" }), "arm64");
    assert.equal(detect({ FAKE_UNAME_M: "x86_64" }), "x86_64");
    assert.equal(detect({ FAKE_UNAME_M: "x86_64", FAKE_TRANSLATED: "1" }), "arm64");
    assert.equal(detect({ FAKE_UNAME_M: "ppc" }), "unsupported");
  } finally {
    fs.rmSync(stubBin, { recursive: true, force: true });
  }
});

test("checksum files: sidecar, SHA256SUMS list, and malformed content", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-sum-"));
  const good = "a".repeat(64);
  fs.writeFileSync(path.join(dir, "side"), `${good.toUpperCase()}  Phone-Farm-1.0.0-arm64.pkg\n`);
  fs.writeFileSync(path.join(dir, "sums"), `${"b".repeat(64)}  Phone-Farm-1.0.0-universal.pkg\r\n${good} *Phone-Farm-1.0.0-arm64.pkg\r\n`);
  fs.writeFileSync(path.join(dir, "bare"), `${good}\n`);
  fs.writeFileSync(path.join(dir, "short"), "abc123  Phone-Farm-1.0.0-arm64.pkg\n");
  fs.writeFileSync(path.join(dir, "other"), `${good}  Phone-Farm-9.9.9-arm64.pkg\n`);
  fs.writeFileSync(path.join(dir, "empty"), "");
  const d = sh(dir);
  const name = "Phone-Farm-1.0.0-arm64.pkg";
  const result = callFunctions(["side", "sums", "bare", "short", "other", "empty", "absent"]
    .map(file => `pf_expected_checksum "${d}/${file}" ${name} || echo none`).join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(result.stdout.trim().split("\n"), [good, good, good, "none", "none", "none", "none"]);
});

// ----------------------------------------------------------------- whole-script runs

test("success: downloads the latest arm64 release, verifies SHA-256, then opens the macOS Installer", { skip }, () => {
  const r = run(release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": {} }));
  assert.equal(r.status, 0, r.output);
  for (const line of ["Phone Farm Installer", "Checking your Mac...", "Checking for latest release...", "Downloading Phone Farm...",
    "Verifying package...", "Opening installer...", "Phone Farm installer opened successfully. Follow the macOS Installer steps."]) {
    assert.ok(r.stdout.includes(line), `missing "${line}" in:\n${r.stdout}`);
  }
  assert.doesNotMatch(r.output, /DEVELOPMENT build/);
  const opens = openCalls(r.log);
  assert.equal(opens.length, 1);
  assert.match(opens[0], /phone-farm-installer\.[^/]+\/Phone-Farm-0\.2\.3-arm64\.pkg exists$/);
  const verify = indexOfCall(r.log, "shasum -a 256");
  const quarantine = indexOfCall(r.log, "xattr -w com.apple.quarantine");
  const open = indexOfCall(r.log, "open ");
  assert.ok(verify >= 0 && quarantine > verify && open > quarantine, `verify -> quarantine -> open, got:\n${r.log.join("\n")}`);
  assert.ok(r.kept.includes("Phone-Farm-0.2.3-arm64.pkg"), "the package must stay for Installer.app to read");
  assert.ok(!r.kept.some(name => name.endsWith(".part")));
  assert.deepEqual(r.cwdEntries, [], "nothing may be written into the folder the script was started from");
});

test("the release is resolved dynamically: a 1.0.0 release is installed without any script change", { skip }, () => {
  const r = run(release("1.0.0", { "Phone-Farm-1.0.0-arm64.pkg": {} }));
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Phone Farm 1\.0\.0: Phone-Farm-1\.0\.0-arm64\.pkg/);
  assert.ok(r.log.includes(`curl ${GH}/releases/download/v1.0.0/Phone-Farm-1.0.0-arm64.pkg`));
});

test("an unsigned development package is installed only with a clear warning and no security bypass", { skip }, () => {
  const r = run(release("0.2.3", { "Phone-Farm-0.2.3-arm64-UNSIGNED.pkg": {} }));
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /DEVELOPMENT build that is not signed and notarized/);
  assert.match(r.stdout, /Privacy & Security/);
  assert.equal(openCalls(r.log).length, 1);
  assert.ok(r.log.some(line => line.startsWith("xattr -w com.apple.quarantine")));
});

test("a signed, notarized package is preferred over an unsigned one in the same release", { skip }, () => {
  const r = run(release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": {}, "Phone-Farm-0.2.3-arm64-UNSIGNED.pkg": {} }));
  assert.equal(r.status, 0, r.output);
  assert.match(openCalls(r.log)[0], /Phone-Farm-0\.2\.3-arm64\.pkg exists/);
});

test("the SHA256SUMS.txt list is used when a package has no .sha256 file", { skip }, () => {
  const r = run(release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": { sidecar: false, inSums: true } }));
  assert.equal(r.status, 0, r.output);
  assert.equal(openCalls(r.log).length, 1);
});

test("checksum mismatch: the package is deleted, the Installer is NOT opened, exit is non-zero", { skip }, () => {
  const r = run(release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": { corrupt: true } }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /INTEGRITY CHECK FAILED/);
  assert.match(r.stderr, /Phone Farm was NOT installed/);
  assert.equal(openCalls(r.log).length, 0);
  assert.equal(indexOfCall(r.log, "xattr"), -1);
  assert.deepEqual(r.tmpEntries, [], "the bad package and its folder must be removed");
});

test("a malformed published checksum is refused before anything is downloaded", { skip }, () => {
  const r = run(release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": { sidecarText: "not-a-checksum\n" } }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /checksum file .* is not valid/);
  assert.equal(openCalls(r.log).length, 0);
  assert.ok(!r.log.includes(`curl ${GH}/releases/download/v0.2.3/Phone-Farm-0.2.3-arm64.pkg`));
});

test("missing checksum: a package without any published SHA-256 is never opened", { skip }, () => {
  const r = run(release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": { sidecar: false } }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no SHA-256 checksum/);
  assert.equal(openCalls(r.log).length, 0);
  assert.deepEqual(r.tmpEntries, []);
});

test("missing package: a release without a macOS installer says so plainly", { skip }, () => {
  const r = run(release("0.2.2", {}, { sums: true }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Phone Farm 0\.2\.2 \(the latest release\) does not include a macOS installer yet/);
  assert.equal(openCalls(r.log).length, 0);
});

test("no published release at all", { skip }, () => {
  const r = run({ routes: { "https://github.com/": "ok" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No Phone Farm release has been published yet/);
});

test("GitHub unreachable (DNS / no connection / timeout) gives a human message and downloads nothing", { skip }, () => {
  for (const [code, message] of [["6", /Unable to reach GitHub\. Check your Internet connection and try again\./],
    ["7", /Unable to reach GitHub/], ["28", /did not answer in time/], ["60", /secure connection to GitHub/]]) {
    const r = run({ routes: { "https://github.com/": `exit ${code}` } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, message);
    assert.equal(r.log.length, 1, "nothing after the connectivity check");
    assert.deepEqual(r.tmpEntries, []);
  }
});

test("GitHub API/release lookup failing mid-way is reported, not mistaken for success", { skip }, () => {
  const r = run({ routes: { "https://github.com/": "ok", [`${GH}/releases/latest`]: "exit 56" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /interrupted/);
  assert.equal(openCalls(r.log).length, 0);
});

test("an interrupted download leaves no partial file and never opens the Installer", { skip }, () => {
  const r = run(release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": { partial: true } }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /download was interrupted/);
  assert.equal(openCalls(r.log).length, 0);
  assert.equal(indexOfCall(r.log, "shasum"), -1);
  assert.deepEqual(r.tmpEntries, []);
});

test("an Intel Mac gets the universal package, and a clear refusal when only arm64 exists", { skip }, () => {
  const refused = run({ ...release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": {} }), env: { FAKE_UNAME_M: "x86_64" } });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /no installer for Intel Macs/);
  assert.equal(openCalls(refused.log).length, 0);
  assert.ok(!refused.log.includes(`curl ${GH}/releases/download/v0.2.3/Phone-Farm-0.2.3-arm64.pkg`), "never downloads an incompatible package");

  const universal = run({ ...release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": {}, "Phone-Farm-0.2.3-universal.pkg": {} }), env: { FAKE_UNAME_M: "x86_64" } });
  assert.equal(universal.status, 0, universal.output);
  assert.match(openCalls(universal.log)[0], /universal\.pkg exists/);
  assert.match(universal.stdout, /Intel \(x86_64\)/);
});

test("Apple silicon running the script under Rosetta still installs the arm64 package", { skip }, () => {
  const r = run({ ...release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": {} }), env: { FAKE_UNAME_M: "x86_64", FAKE_TRANSLATED: "1" } });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Apple silicon \(arm64\)/);
});

test("unsupported processor, non-macOS system and too-old macOS stop before any network use", { skip }, () => {
  for (const [env, message] of [[{ FAKE_UNAME_M: "ppc" }, /processor \(ppc\) is not supported/],
    [{ FAKE_UNAME_S: "Linux" }, /This installer is for macOS/],
    [{ FAKE_MACOS: "11.7.10" }, /needs macOS 12 \(Monterey\) or newer/]]) {
    const r = run({ ...release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": {} }), env });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, message);
    assert.equal(r.log.filter(line => line.startsWith("curl")).length, 0);
  }
});

test("if Gatekeeper marking fails the package is not opened", { skip }, () => {
  const r = run({ ...release("0.2.3", { "Phone-Farm-0.2.3-arm64.pkg": {} }), env: { FAKE_XATTR_EXIT: "1" } });
  assert.notEqual(r.status, 0);
  assert.equal(openCalls(r.log).length, 0);
  assert.deepEqual(r.tmpEntries, []);
});
