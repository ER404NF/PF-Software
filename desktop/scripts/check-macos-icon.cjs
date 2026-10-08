// Checks the macOS 26 layered-icon candidate (build/candidates/icon.icon) without changing the shipped icon.
//
// The installer still uses build/icon.png. The candidate is a standard Icon Composer folder (icon.json + Assets/)
// that is switched on by one line in package.json once it has been looked at on a Mac with Xcode 26 (see
// docs/MAC_RELEASE.md). This script is how to look at it:
//   - anywhere: confirms the folder has the files the Icon Composer format needs and the logo layer is transparent;
//   - on a Mac with Xcode 26: also asks Xcode's own icon compiler (actool) to build it and reports the result.
// It changes nothing and always exits 0 unless the folder itself is malformed.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const desktopDir = path.resolve(__dirname, "..");
const defaultCandidate = path.join(desktopDir, "build", "candidates", "icon.icon");

function pngHasAlpha(file) {
  const bytes = fs.readFileSync(file);
  return bytes.subarray(1, 4).toString("ascii") === "PNG" && (bytes[25] === 6 || bytes[25] === 4);
}

// Problems with the folder itself (an empty list means it is well formed).
function validateCandidate(candidate = defaultCandidate) {
  const problems = [];
  const manifest = path.join(candidate, "icon.json");
  if (!fs.existsSync(manifest)) return [`icon.json is missing from ${path.basename(candidate)}`];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch (error) {
    return [`icon.json is not valid JSON (${error.message})`];
  }
  const layers = (parsed.groups ?? []).flatMap(group => group.layers ?? []);
  if (layers.length === 0) problems.push("icon.json has no layers");
  for (const layer of layers) {
    const file = path.join(candidate, "Assets", String(layer["image-name"] ?? ""));
    if (!layer["image-name"] || !fs.existsSync(file)) problems.push(`layer "${layer.name ?? "?"}" points at a missing image`);
    else if (!pngHasAlpha(file)) problems.push(`layer "${layer.name ?? "?"}" is not transparent, so it would draw its own background`);
  }
  return problems;
}

// What this machine can say about the candidate. `exec` is injectable so the test never needs Xcode.
function checkMacosIcon({ candidate = defaultCandidate, platform = process.platform, exec = execFileSync, tmpdir = os.tmpdir() } = {}) {
  const problems = validateCandidate(candidate);
  if (problems.length) return { ok: false, compiled: false, message: `The icon candidate is not well formed: ${problems.join("; ")}.` };
  if (platform !== "darwin") {
    return { ok: true, compiled: false, message: "The icon candidate is well formed. Compiling it needs a Mac with Xcode 26; run this again there." };
  }
  let version;
  try {
    version = exec("xcrun", ["actool", "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return { ok: true, compiled: false, message: "The icon candidate is well formed. Xcode's icon compiler was not found; install Xcode 26 to compile it." };
  }
  const major = Number(String(version).match(/(\d+)\./)?.[1] ?? 0);
  const out = fs.mkdtempSync(path.join(tmpdir, "bodun-icon-"));
  try {
    exec("xcrun", ["actool", candidate, "--compile", out, "--output-format", "human-readable-text", "--notices", "--warnings", "--errors",
      "--output-partial-info-plist", path.join(out, "partial.plist"), "--app-icon", "icon", "--include-all-app-icons",
      "--platform", "macosx", "--minimum-deployment-target", "26.0", "--target-device", "mac"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return { ok: false, compiled: false, message: `Xcode could not compile the icon candidate: ${String(error.stderr || error.message).trim().split("\n")[0]}` };
  }
  return { ok: true, compiled: true, message: `Xcode compiled the icon candidate (icon compiler ${major || "version unknown"}). Look at the result in ${out} before switching the installer to it.` };
}

if (require.main === module) {
  const result = checkMacosIcon();
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { checkMacosIcon, validateCandidate, pngHasAlpha };
