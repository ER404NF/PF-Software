// Stages the pinned, UNMODIFIED WebDriverAgent source under
// build/runtime/wda/ so it ships inside Phone Farm.app
// (Contents/Resources/wda). The pin lives in desktop/wda.lock.json: a git
// tag AND the exact commit that tag must resolve to, so a moved/retagged
// upstream ref fails the build instead of shipping different code.
//
// WebDriverAgent is BSD-3-Clause (Facebook) / Apache-2.0 (Appium fork); both
// allow redistribution provided the notice is kept — its LICENSE is copied
// verbatim to build/runtime/licenses/. Nothing here modifies the source.
//
//   PHONE_FARM_WDA_SOURCE_DIR   use an existing checkout instead of cloning
//                               (its HEAD must still equal the pinned commit)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const desktopDir = path.resolve(__dirname, "..");
const stageRoot = path.join(desktopDir, "build", "runtime");
const lockPath = path.join(desktopDir, "wda.lock.json");

// Never shipped: VCS data, upstream CI, JS driver/test scaffolding.
const EXCLUDED_TOP_LEVEL = new Set([".git", ".github", "node_modules", "test", "Fastlane", "Gemfile"]);

function readLock(file = lockPath) {
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^[0-9a-f]{40}$/.test(lock.commit || "")) throw new Error("wda.lock.json commit must be a full 40-character SHA");
  if (!/^v\d+\.\d+\.\d+$/.test(lock.tag || "")) throw new Error("wda.lock.json tag must look like v1.2.3");
  if (lock.tag !== `v${lock.version}`) throw new Error("wda.lock.json tag and version disagree");
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(lock.repository || "")) throw new Error("wda.lock.json repository must be an https GitHub URL");
  return lock;
}

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || "").trim()}`);
  return (result.stdout || "").trim();
}

function fetchSource(lock, workDir) {
  const override = process.env.PHONE_FARM_WDA_SOURCE_DIR;
  if (override) {
    const resolved = path.resolve(override);
    const head = git(["-C", resolved, "rev-parse", "HEAD"]);
    if (head !== lock.commit) {
      throw new Error(`PHONE_FARM_WDA_SOURCE_DIR is at ${head}, not the pinned ${lock.commit} (${lock.tag})`);
    }
    return resolved;
  }
  const target = path.join(workDir, "wda-clone");
  git(["clone", "--quiet", "--depth", "1", "--branch", lock.tag, lock.repository, target]);
  const head = git(["-C", target, "rev-parse", "HEAD"]);
  if (head !== lock.commit) {
    throw new Error(`${lock.repository} ${lock.tag} resolved to ${head}, expected pinned ${lock.commit}; refusing to bundle`);
  }
  return target;
}

function copySource(sourceDir, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    fs.cpSync(path.join(sourceDir, entry.name), path.join(destination, entry.name), { recursive: true, dereference: false });
  }
}

function verifyStagedWda(wdaRoot = path.join(stageRoot, "wda")) {
  const project = path.join(wdaRoot, "WebDriverAgent", "WebDriverAgent.xcodeproj", "project.pbxproj");
  const license = path.join(wdaRoot, "WebDriverAgent", "LICENSE");
  const meta = path.join(wdaRoot, "WDA_VERSION.json");
  const missing = [project, license, meta].filter(file => !fs.existsSync(file));
  if (missing.length) throw new Error(`staged WebDriverAgent is incomplete:\n${missing.join("\n")}`);
  return JSON.parse(fs.readFileSync(meta, "utf8"));
}

function stageWda({ log = console.log } = {}) {
  const lock = readLock();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-wda-"));
  try {
    const source = fetchSource(lock, workDir);
    const wdaRoot = path.join(stageRoot, "wda");
    fs.rmSync(wdaRoot, { recursive: true, force: true });
    copySource(source, path.join(wdaRoot, "WebDriverAgent"));
    fs.writeFileSync(path.join(wdaRoot, "WDA_VERSION.json"), `${JSON.stringify({
      version: lock.version, tag: lock.tag, commit: lock.commit, repository: lock.repository, license: lock.license,
    }, null, 2)}\n`);
    const licensesDir = path.join(stageRoot, "licenses");
    fs.mkdirSync(licensesDir, { recursive: true });
    fs.copyFileSync(path.join(wdaRoot, "WebDriverAgent", "LICENSE"), path.join(licensesDir, "WebDriverAgent-LICENSE.txt"));
    const meta = verifyStagedWda(wdaRoot);
    log(`WebDriverAgent ${meta.tag} (${meta.commit.slice(0, 12)}) staged unmodified for packaging.`);
    return meta;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    stageWda();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { EXCLUDED_TOP_LEVEL, readLock, stageWda, verifyStagedWda };
