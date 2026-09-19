// Stages the runtime that ships inside Phone Farm.app (Contents/Resources) into
// desktop/build/runtime/. An ALLOW-LIST is copied out of ../system — never the
// whole working tree — so a developer's operators.config.json (password
// hashes), runtime storage/, test output or key material can never end up in
// an installer. Production dependencies are installed from the committed
// lockfile INTO the staging directory (`npm ci --omit=dev`), leaving the
// development tree's node_modules untouched.
//
// Layout produced (matches what desktop/main.js resolves at runtime):
//   build/runtime/system/{package.json, package-lock.json, client/, server/src/,
//                         models|platform-skills|research.config.json, node_modules/}
//   build/runtime/licenses/   (Electron + WebDriverAgent notices; see prepare-wda.cjs)

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { findForbiddenFiles, findMissingFiles, findUnresolvableImports } = require("./verify-packaged-runtime.cjs");

const desktopDir = path.resolve(__dirname, "..");
const defaultSystemDir = path.resolve(desktopDir, "..", "system");
const defaultStageRoot = path.join(desktopDir, "build", "runtime");

// Relative to system/. Directories are copied recursively.
const RUNTIME_ALLOWLIST = [
  "package.json",
  "package-lock.json",
  "client",
  "server/src",
  // Shipped-empty defaults the server reads when no override is configured.
  "models.config.json",
  "platform-skills.config.json",
  "research.config.json",
];

function installProductionDependencies(stageSystemDir) {
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const npmArgs = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...npmArgs] : npmArgs;
  const result = spawnSync(command, args, { cwd: stageSystemDir, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci --omit=dev failed in the staging directory (exit ${result.status})`);
}

function copyAllowlist(systemDir, stageSystemDir) {
  for (const relative of RUNTIME_ALLOWLIST) {
    const source = path.join(systemDir, relative);
    if (!fs.existsSync(source)) throw new Error(`runtime allow-list entry is missing from the repository: system/${relative}`);
    const destination = path.join(stageSystemDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
}

function verifyRuntime(stageRoot = defaultStageRoot) {
  const problems = [
    ...findMissingFiles(stageRoot).map(file => `missing: ${path.relative(stageRoot, file)}`),
  ];
  if (problems.length === 0) {
    problems.push(...findUnresolvableImports(stageRoot));
    problems.push(...findForbiddenFiles(stageRoot).map(file => `forbidden content staged: system/${file}`));
  }
  if (problems.length) throw new Error(`Packaged server runtime is not valid:\n${problems.join("\n")}`);
  return stageRoot;
}

// Attribution shipped in Contents/Resources/licenses. Electron/Chromium's own
// license files come from the installed electron package; the WebDriverAgent
// license is added by prepare-wda.cjs; npm packages keep their LICENSE files
// inside system/node_modules/<package>/.
function stageNotices({
  stageRoot = defaultStageRoot,
  electronDist = path.join(desktopDir, "node_modules", "electron", "dist"),
  log = console.log,
} = {}) {
  const licensesDir = path.join(stageRoot, "licenses");
  fs.mkdirSync(licensesDir, { recursive: true });
  for (const [source, name] of [["LICENSE", "Electron-LICENSE.txt"], ["LICENSES.chromium.html", "Chromium-LICENSES.html"]]) {
    const from = path.join(electronDist, source);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(licensesDir, name));
    else log(`warning: ${source} not found in the installed electron package; run npm ci in desktop/ first`);
  }
  fs.writeFileSync(path.join(stageRoot, "THIRD_PARTY_NOTICES.txt"), [
    "Phone Farm third-party notices",
    "==============================",
    "",
    "Phone Farm.app bundles the following third-party software. Each keeps its own license.",
    "",
    "- Electron and Chromium ... licenses/Electron-LICENSE.txt, licenses/Chromium-LICENSES.html",
    "- WebDriverAgent (unmodified source, BSD-3-Clause / Apache-2.0) ... licenses/WebDriverAgent-LICENSE.txt",
    "- Node.js packages used by the Phone Farm server (express, express-session, multer, nodemailer, ws",
    "  and their dependencies) ... the LICENSE file inside each system/node_modules/<package>/ directory",
    "",
  ].join("\n"));
}

function stageRuntime({
  systemDir = defaultSystemDir,
  stageRoot = defaultStageRoot,
  install = installProductionDependencies,
  log = console.log,
} = {}) {
  const stageSystemDir = path.join(stageRoot, "system");
  fs.rmSync(stageSystemDir, { recursive: true, force: true });
  fs.mkdirSync(stageSystemDir, { recursive: true });
  copyAllowlist(systemDir, stageSystemDir);
  install(stageSystemDir);
  stageNotices({ stageRoot, log });
  verifyRuntime(stageRoot);
  log(`Phone Farm server runtime staged at ${stageSystemDir}`);
  return stageSystemDir;
}

if (require.main === module) {
  try {
    stageRuntime();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { RUNTIME_ALLOWLIST, installProductionDependencies, stageNotices, stageRuntime, verifyRuntime };
