// Records which build this is, so the installed app can be told apart from any other build with the same version
// number. The short git commit and the build date are written into system/build-info.json inside the staged runtime;
// the server reads it and shows it in the badge and in Copy Diagnostics.
//
// The commit comes from git when the build runs in a checkout, from GITHUB_SHA on a CI clone without git history,
// and is "unknown" otherwise. A build never fails because the commit could not be found.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

function shortCommit(value) {
  const text = String(value ?? "").trim();
  return COMMIT_PATTERN.test(text) ? text.slice(0, 7).toLowerCase() : null;
}

function gitCommit(cwd, execFile = execFileSync) {
  try {
    return shortCommit(execFile("git", ["rev-parse", "--short=7", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

function resolveBuildInfo({ env = process.env, cwd = path.resolve(__dirname, ".."), now = new Date(), execFile = execFileSync } = {}) {
  const commit = gitCommit(cwd, execFile) || shortCommit(env.GITHUB_SHA) || "unknown";
  return { commit, builtAt: now.toISOString() };
}

function writeBuildInfo(stageSystemDir, options = {}) {
  const info = resolveBuildInfo(options);
  fs.mkdirSync(stageSystemDir, { recursive: true });
  fs.writeFileSync(path.join(stageSystemDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node write-build-info.cjs <folder to write build-info.json into>");
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(writeBuildInfo(path.resolve(target))));
  }
}

module.exports = { resolveBuildInfo, writeBuildInfo, shortCommit };
