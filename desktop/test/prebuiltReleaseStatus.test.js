const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectPrebuiltRelease, packageDigest } = require("../scripts/prebuilt-release-status.cjs");

function fixture(overrides = {}, changed = []) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bodun-prebuilt-"));
  fs.mkdirSync(path.join(repo, "desktop"), { recursive: true });
  fs.mkdirSync(path.join(repo, "prebuilt", "mac"), { recursive: true });
  fs.writeFileSync(path.join(repo, "desktop", "package.json"), JSON.stringify({ version: "0.3.1" }));
  fs.writeFileSync(path.join(repo, "prebuilt", "mac", "Phone-Farm.pkg"), "package bytes");
  const checksumPath = path.join(repo, "prebuilt", "mac", "Phone-Farm.pkg.sha256");
  fs.writeFileSync(path.join(repo, "prebuilt", "mac", "SIGNING_LEVEL.txt"), "unsigned\n");
  const digest = packageDigest(path.join(repo, "prebuilt", "mac", "Phone-Farm.pkg"));
  fs.writeFileSync(checksumPath, `${digest}  Phone-Farm.pkg\n`);
  fs.writeFileSync(path.join(repo, "prebuilt", "mac", "BUILD_INFO.json"), JSON.stringify({
    version: 1,
    sourceCommit: "a".repeat(40),
    appVersion: "0.3.1",
    arch: "arm64",
    signingLevel: "unsigned",
    packageSha256: digest,
    ...overrides,
  }));
  const git = args => args[0] === "cat-file"
    ? { ok: true, stdout: "" }
    : { ok: true, stdout: `${changed.join("\n")}${changed.length ? "\n" : ""}` };
  return { repo, git };
}

test("a matching package manifest is ready", () => {
  const value = fixture();
  try { assert.equal(inspectPrebuiltRelease(value).status, "pass"); }
  finally { fs.rmSync(value.repo, { recursive: true, force: true }); }
});

test("source changes after the recorded build make the package stale", () => {
  const value = fixture({}, ["system/server/src/index.js"]);
  try {
    const result = inspectPrebuiltRelease(value);
    assert.equal(result.status, "fail");
    assert.match(result.detail, /predates 1 source change/);
  } finally { fs.rmSync(value.repo, { recursive: true, force: true }); }
});

test("prebuilt sidecar-only commits after a build do not make its source stale", () => {
  const value = fixture({}, ["prebuilt/mac/Phone-Farm.pkg", "prebuilt/mac/BUILD_INFO.json"]);
  try { assert.equal(inspectPrebuiltRelease(value).status, "pass"); }
  finally { fs.rmSync(value.repo, { recursive: true, force: true }); }
});

test("a mismatched package digest fails closed", () => {
  const value = fixture({ packageSha256: crypto.createHash("sha256").update("other").digest("hex") });
  try {
    const result = inspectPrebuiltRelease(value);
    assert.equal(result.status, "fail");
    assert.match(result.detail, /digest does not match/);
  } finally { fs.rmSync(value.repo, { recursive: true, force: true }); }
});

test("a mismatched checksum sidecar fails closed", () => {
  const value = fixture();
  fs.writeFileSync(path.join(value.repo, "prebuilt", "mac", "Phone-Farm.pkg.sha256"), `${"c".repeat(64)}  Phone-Farm.pkg\n`);
  try {
    const result = inspectPrebuiltRelease(value);
    assert.equal(result.status, "fail");
    assert.match(result.detail, /checksum sidecar does not match/);
  } finally { fs.rmSync(value.repo, { recursive: true, force: true }); }
});

test("an LFS pointer is checked against its object digest without downloading the binary", () => {
  const value = fixture();
  const digest = "b".repeat(64);
  fs.writeFileSync(path.join(value.repo, "prebuilt", "mac", "Phone-Farm.pkg"), `version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize 123\n`);
  const manifestPath = path.join(value.repo, "prebuilt", "mac", "BUILD_INFO.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.packageSha256 = digest;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(value.repo, "prebuilt", "mac", "Phone-Farm.pkg.sha256"), `version https://git-lfs.github.com/spec/v1\noid sha256:${"d".repeat(64)}\nsize 81\n`);
  try { assert.equal(inspectPrebuiltRelease(value).status, "pass"); }
  finally { fs.rmSync(value.repo, { recursive: true, force: true }); }
});
