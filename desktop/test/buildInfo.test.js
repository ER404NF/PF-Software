const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveBuildInfo, writeBuildInfo, shortCommit } = require("../scripts/write-build-info.cjs");
const { buildDiagnosticsReport, describeBuild, readBuildRecord } = require("../diagnostics.js");

const now = new Date("2026-10-07T09:30:00.000Z");

test("the build record uses the git commit when there is one", () => {
  const info = resolveBuildInfo({ env: {}, now, execFile: () => "A1B2C3D\n" });
  assert.deepEqual(info, { commit: "a1b2c3d", builtAt: "2026-10-07T09:30:00.000Z" });
});

test("on a CI clone without git it falls back to the commit CI reports, then to unknown", () => {
  const noGit = () => { throw new Error("git is not installed"); };
  assert.equal(resolveBuildInfo({ env: { GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567" }, now, execFile: noGit }).commit, "0123456");
  assert.equal(resolveBuildInfo({ env: {}, now, execFile: noGit }).commit, "unknown");
  assert.equal(resolveBuildInfo({ env: { GITHUB_SHA: "not a commit" }, now, execFile: noGit }).commit, "unknown");
  assert.equal(shortCommit("zzz"), null);
});

test("writeBuildInfo puts build-info.json in the staged runtime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bodun-build-"));
  try {
    writeBuildInfo(dir, { env: {}, now, execFile: () => "abc1234\n" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "build-info.json"), "utf8")), { commit: "abc1234", builtAt: "2026-10-07T09:30:00.000Z" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Copy Diagnostics names the build", () => {
  assert.match(buildDiagnosticsReport({ appVersion: "0.3.1", build: { commit: "abc1234", builtAt: "2026-10-07T09:30:00.000Z" } }), /^Build: abc1234, built 2026-10-07$/m);
  assert.match(buildDiagnosticsReport({ appVersion: "0.3.1", build: null }), /^Build: development build$/m);
  assert.equal(describeBuild({ commit: "unknown", builtAt: "2026-10-07T09:30:00.000Z" }), "unknown commit, built 2026-10-07");
});

test("the build record is read from beside the server, and a missing file means a development run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bodun-build-read-"));
  try {
    assert.equal(readBuildRecord(path.join(dir, "build-info.json")), null);
    fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ commit: "abc1234", builtAt: "2026-10-07T09:30:00.000Z" }));
    assert.deepEqual(readBuildRecord(path.join(dir, "build-info.json")), { commit: "abc1234", builtAt: "2026-10-07T09:30:00.000Z" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
