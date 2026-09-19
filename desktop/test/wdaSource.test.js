const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  detectDevelopmentTeams,
  ensureManagedWdaSource,
  isValidTeamId,
  parseTeamIdsFromSubjects,
  resolveWdaDevelopmentTeam,
} = require("../wdaSource");

const COMMIT = "6e2b5c026f728aed9098481e756b458db87d1272";

function makeBundledWda(root, { version = "16.12.1", commit = COMMIT } = {}) {
  const wda = path.join(root, "WebDriverAgent");
  fs.mkdirSync(path.join(wda, "WebDriverAgent.xcodeproj"), { recursive: true });
  fs.writeFileSync(path.join(wda, "WebDriverAgent.xcodeproj", "project.pbxproj"), "// pbxproj");
  fs.writeFileSync(path.join(wda, "LICENSE"), "BSD");
  fs.writeFileSync(path.join(root, "WDA_VERSION.json"), JSON.stringify({ version, tag: `v${version}`, commit }));
  return wda;
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pf-wdasource-"));
}

test("the bundled WDA is copied once to a writable managed folder and reused afterwards", () => {
  const root = scratch();
  try {
    const bundled = path.join(root, "bundle");
    fs.mkdirSync(bundled);
    makeBundledWda(bundled);
    const managedRoot = path.join(root, "userData", "wda-source");

    const first = ensureManagedWdaSource({ bundledRoot: bundled, managedRoot });
    assert.equal(first.version, "16.12.1");
    assert.ok(first.path.startsWith(managedRoot));
    assert.ok(fs.existsSync(path.join(first.path, "WebDriverAgent.xcodeproj", "project.pbxproj")));

    // Writable: xcodebuild must be able to create files next to the project.
    fs.writeFileSync(path.join(first.path, "xcodebuild-was-here"), "x");
    const second = ensureManagedWdaSource({ bundledRoot: bundled, managedRoot });
    assert.equal(second.path, first.path);
    assert.ok(fs.existsSync(path.join(first.path, "xcodebuild-was-here")), "a completed copy is reused, not recopied");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the bundle itself is never modified, and never used as the build directory", () => {
  const root = scratch();
  try {
    const bundled = path.join(root, "bundle");
    fs.mkdirSync(bundled);
    makeBundledWda(bundled);
    const before = fs.readdirSync(path.join(bundled, "WebDriverAgent")).sort();
    const { path: managed } = ensureManagedWdaSource({ bundledRoot: bundled, managedRoot: path.join(root, "managed") });
    assert.ok(!managed.startsWith(bundled));
    assert.deepEqual(fs.readdirSync(path.join(bundled, "WebDriverAgent")).sort(), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted copy is discarded and redone; older versions are pruned", () => {
  const root = scratch();
  try {
    const bundled = path.join(root, "bundle");
    fs.mkdirSync(bundled);
    makeBundledWda(bundled);
    const managedRoot = path.join(root, "managed");
    const versionDir = path.join(managedRoot, `16.12.1-${COMMIT.slice(0, 12)}`);
    // Simulate a crash mid-copy: a half-written directory without the completion marker.
    fs.mkdirSync(path.join(versionDir, "WebDriverAgent"), { recursive: true });
    fs.writeFileSync(path.join(versionDir, "WebDriverAgent", "partial"), "x");
    fs.mkdirSync(path.join(managedRoot, "15.0.0-oldoldoldold"), { recursive: true });

    const result = ensureManagedWdaSource({ bundledRoot: bundled, managedRoot });
    assert.ok(fs.existsSync(path.join(result.path, "WebDriverAgent.xcodeproj", "project.pbxproj")));
    assert.equal(fs.existsSync(path.join(result.path, "partial")), false);
    assert.equal(fs.existsSync(path.join(managedRoot, "15.0.0-oldoldoldold")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no bundled WDA (or a malformed version file) yields null instead of throwing", () => {
  const root = scratch();
  try {
    assert.equal(ensureManagedWdaSource({ bundledRoot: path.join(root, "absent"), managedRoot: path.join(root, "m") }), null);
    const bundled = path.join(root, "bundle");
    fs.mkdirSync(bundled);
    makeBundledWda(bundled, { commit: "not-a-sha" });
    assert.equal(ensureManagedWdaSource({ bundledRoot: bundled, managedRoot: path.join(root, "m") }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("team ids are the OU of the certificate subject, not the id inside the common name", () => {
  const subject = "subject=UID=AAAAAAAAAA,CN=Apple Development: Jane Doe (BBBBBBBBBB),OU=CCCCCCCCCC,O=Jane Doe,C=US";
  assert.deepEqual(parseTeamIdsFromSubjects(subject), ["CCCCCCCCCC"]);
  // Older LibreSSL default format.
  assert.deepEqual(parseTeamIdsFromSubjects("subject= /UID=AAAAAAAAAA/CN=Apple Development: J (BBBBBBBBBB)/OU=CCCCCCCCCC/O=J/C=US"), ["CCCCCCCCCC"]);
  assert.deepEqual(parseTeamIdsFromSubjects("subject=CN=Nothing"), []);
});

test("team detection reads Apple Development certificates and never guesses between several teams", () => {
  const pem = block => `-----BEGIN CERTIFICATE-----\n${block}\n-----END CERTIFICATE-----\n`;
  const subjects = { AAA: "subject=UID=X,CN=Apple Development: A (Y),OU=TEAMONE111,O=A,C=US", BBB: "subject=UID=X,CN=Apple Development: B (Y),OU=TEAMTWO222,O=B,C=US" };
  const execFile = (bin, args, options) => {
    if (bin === "/usr/bin/security") return args.includes("Apple Development") ? pem("AAA") + pem("BBB") : (() => { throw new Error("none"); })();
    return subjects[options.input.match(/\n(\w+)\n/)[1]];
  };
  const teams = detectDevelopmentTeams({ platform: "darwin", execFile });
  assert.deepEqual(teams, ["TEAMONE111", "TEAMTWO222"]);
  const resolved = resolveWdaDevelopmentTeam({ env: {}, detected: teams });
  assert.equal(resolved.teamId, null);
  assert.deepEqual(resolved.candidates, teams);
});

test("detection is macOS-only and a locked or empty keychain is not an error", () => {
  assert.deepEqual(detectDevelopmentTeams({ platform: "win32", execFile: () => { throw new Error("must not run"); } }), []);
  assert.deepEqual(detectDevelopmentTeams({ platform: "darwin", execFile: () => { throw new Error("keychain locked"); } }), []);
});

test("team precedence is environment, then saved, then a single detected team", () => {
  assert.deepEqual(resolveWdaDevelopmentTeam({ env: { WDA_DEVELOPMENT_TEAM: "ENVTEAM123" }, savedTeam: "SAVEDTEAM1", detected: ["DETECTED12"] }).source, "environment");
  assert.equal(resolveWdaDevelopmentTeam({ env: {}, savedTeam: "SAVEDTEAM1", detected: ["DETECTED12"] }).teamId, "SAVEDTEAM1");
  assert.deepEqual(resolveWdaDevelopmentTeam({ env: {}, savedTeam: null, detected: ["DETECTED12"] }), { teamId: "DETECTED12", source: "detected", candidates: ["DETECTED12"] });
  assert.equal(resolveWdaDevelopmentTeam({ env: { WDA_DEVELOPMENT_TEAM: "bad" }, savedTeam: null, detected: [] }).teamId, null);
});

test("only exactly ten uppercase letters/digits are accepted as a team id", () => {
  assert.equal(isValidTeamId("ABCDE12345"), true);
  for (const bad of ["abcde12345", "ABCDE1234", "ABCDE123456", "ABCDE-2345", "", null, undefined, 12345678901]) {
    assert.equal(isValidTeamId(bad), false, String(bad));
  }
});
