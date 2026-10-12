const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const MANIFEST_VERSION = 1;
const PREBUILT_FILES = new Set([
  "prebuilt/mac/Phone-Farm.pkg",
  "prebuilt/mac/Phone-Farm.pkg.sha256",
  "prebuilt/mac/SIGNING_LEVEL.txt",
  "prebuilt/mac/BUILD_INFO.json",
]);

function packageDigest(file) {
  const size = fs.statSync(file).size;
  if (size < 1024) {
    const pointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([0-9a-f]{64})\r?\nsize \d+\r?\n?$/.exec(fs.readFileSync(file, "utf8"));
    if (pointer) return pointer[1];
  }
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function lfsPointerDigest(contents) {
  return /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([0-9a-f]{64})\r?\nsize \d+\r?\n?$/.exec(contents)?.[1] || null;
}

function validateManifest(value) {
  const problems = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["BUILD_INFO.json must contain an object"];
  const allowed = new Set(["version", "sourceCommit", "appVersion", "arch", "signingLevel", "packageSha256"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) problems.push(`unexpected manifest field ${key}`);
  if (value.version !== MANIFEST_VERSION) problems.push(`unsupported manifest version ${String(value.version)}`);
  if (!/^[0-9a-f]{40}$/.test(value.sourceCommit || "")) problems.push("sourceCommit must be a full Git commit");
  if (!/^\d+\.\d+\.\d+$/.test(value.appVersion || "")) problems.push("appVersion must be x.y.z");
  if (value.arch !== "arm64") problems.push("arch must be arm64");
  if (!["unsigned", "signed", "notarized"].includes(value.signingLevel)) problems.push("signingLevel is invalid");
  if (!/^[0-9a-f]{64}$/.test(value.packageSha256 || "")) problems.push("packageSha256 must be a SHA-256 digest");
  return problems;
}

function inspectPrebuiltRelease({ repo, git }) {
  const base = path.join(repo, "prebuilt", "mac");
  const manifestPath = path.join(base, "BUILD_INFO.json");
  const packagePath = path.join(base, "Phone-Farm.pkg");
  const checksumPath = path.join(base, "Phone-Farm.pkg.sha256");
  const signingPath = path.join(base, "SIGNING_LEVEL.txt");
  for (const file of [manifestPath, packagePath, checksumPath, signingPath]) {
    if (!fs.existsSync(file)) return { status: "fail", detail: `${path.basename(file)} is missing` };
  }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { return { status: "fail", detail: "BUILD_INFO.json is not valid JSON" }; }
  const problems = validateManifest(manifest);
  if (problems.length) return { status: "fail", detail: problems.join("; ") };

  const appVersion = JSON.parse(fs.readFileSync(path.join(repo, "desktop", "package.json"), "utf8")).version;
  const signingLevel = fs.readFileSync(signingPath, "utf8").trim();
  const digest = packageDigest(packagePath);
  const checksumContents = fs.readFileSync(checksumPath, "utf8");
  if (!lfsPointerDigest(checksumContents)) {
    const checksum = /^([0-9a-f]{64})\s+\*?Phone-Farm\.pkg\s*$/.exec(checksumContents.trim())?.[1];
    if (!checksum) problems.push("Phone-Farm.pkg.sha256 has an invalid format");
    else if (checksum !== digest) problems.push("checksum sidecar does not match the package");
  }
  if (manifest.appVersion !== appVersion) problems.push(`package version ${manifest.appVersion} does not match source version ${appVersion}`);
  if (manifest.signingLevel !== signingLevel) problems.push(`manifest signing level does not match SIGNING_LEVEL.txt`);
  if (manifest.packageSha256 !== digest) problems.push("package digest does not match BUILD_INFO.json");

  const commit = git(["cat-file", "-e", `${manifest.sourceCommit}^{commit}`], repo);
  if (!commit?.ok) {
    if (commit?.missing) return { status: "warn", detail: "git is unavailable, so the package source commit could not be verified" };
    return { status: "fail", detail: "the package source commit is not present in this checkout" };
  }
  const diff = git(["diff", "--name-only", `${manifest.sourceCommit}..HEAD`], repo);
  if (!diff?.ok) return { status: "warn", detail: "git could not compare the package source with HEAD" };
  const changed = diff.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const sourceChanges = changed.filter(file => !PREBUILT_FILES.has(file.replaceAll("\\", "/")));
  if (sourceChanges.length) problems.push(`package predates ${sourceChanges.length} source change(s), including ${sourceChanges.slice(0, 3).join(", ")}`);

  return problems.length
    ? { status: "fail", detail: problems.join("; ") }
    : { status: "pass", detail: `app ${manifest.appVersion}, ${manifest.signingLevel}, source ${manifest.sourceCommit.slice(0, 12)}, sha256 ${digest.slice(0, 12)}` };
}

module.exports = { MANIFEST_VERSION, PREBUILT_FILES, inspectPrebuiltRelease, packageDigest, validateManifest };
