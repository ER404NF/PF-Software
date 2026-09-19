#!/usr/bin/env node
// "Is the macOS installer ready to be pushed?" - everything about it that can be checked WITHOUT a Mac.
//
//   node scripts/check-release.cjs            print the checklist (exit 1 if anything FAILS)
//   node scripts/check-release.cjs --tests    also run the full server and desktop test suites
//
// It cannot prove the .pkg builds (that needs macOS; the GitHub workflow does it) but it catches the mistakes
// that make a first build fail for silly reasons: a file the build needs that git would not push, a workflow that
// names a script that does not exist, a lockfile that is out of step, a secret about to be committed.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");

const REQUIRED = [
  ".github/workflows/mac-installer.yml",
  "desktop/main.js", "desktop/preload.js", "desktop/first-run.html", "desktop/package.json", "desktop/package-lock.json",
  "desktop/hostEnvironment.js", "desktop/hostFixes.js", "desktop/serverSupervisor.js", "desktop/diagnostics.js",
  "desktop/wdaSource.js", "desktop/windowSecurity.js", "desktop/siteAgentConfig.js", "desktop/wda.lock.json",
  "desktop/build/entitlements.mac.plist", "desktop/build/icon.png", "desktop/build/pkg/components.plist",
  "desktop/build/pkg/resources/welcome.html", "desktop/build/pkg/resources/readme.html", "desktop/build/pkg/resources/conclusion.html",
  "desktop/scripts/build-mac-pkg.cjs", "desktop/scripts/prepare-runtime.cjs", "desktop/scripts/prepare-wda.cjs",
  "desktop/scripts/verify-packaged-runtime.cjs", "desktop/scripts/ensure-electron.cjs", "desktop/scripts/audit-gate.cjs",
  "system/package.json", "system/package-lock.json", "system/server/src/index.js", "system/client/index.html",
];

// Things that must never be pushed by accident.
const FORBIDDEN_IN_PUSH = [
  [/(^|\/)node_modules\//, "node_modules"], [/^desktop\/dist\//, "desktop/dist"], [/^desktop\/build\/runtime\//, "desktop/build/runtime"],
  [/\.(pkg|dmg|p12|p8|pem|key)$/i, "a package or a key/certificate file"], [/(^|\/)\.env$|(^|\/)\.env\.(?!example$|sample$)/, ".env file"],
  [/(^|\/)operators\.config\.json$/, "operators.config.json (real accounts)"], [/(^|\/)models\.config\.json$/, "models.config.json"],
  [/(^|\/)(storage|host-storage)\//, "runtime storage"], [/(^|\/)audit\.log$/, "an audit log"],
];

const pass = (id, title, detail = "") => ({ id, title, status: "pass", detail });
const warn = (id, title, detail = "") => ({ id, title, status: "warn", detail });
const fail = (id, title, detail = "") => ({ id, title, status: "fail", detail });

function defaultGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { ok: false, missing: result.error.code === "ENOENT", stdout: "", stderr: String(result.error.message) };
  return { ok: result.status === 0, code: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---- individual checks -------------------------------------------------------------------------

function checkRequiredFiles(repo) {
  const missing = REQUIRED.filter(file => !fs.existsSync(path.join(repo, file)));
  return missing.length ? fail("files", "Every file the build needs exists", `missing: ${missing.join(", ")}`)
    : pass("files", "Every file the build needs exists", `${REQUIRED.length} files`);
}

function checkNotIgnored(repo, git) {
  const clientFiles = fs.existsSync(path.join(repo, "system/client"))
    ? fs.readdirSync(path.join(repo, "system/client")).map(name => `system/client/${name}`) : [];
  const result = git(["check-ignore", "--no-index", ...REQUIRED, ...clientFiles], repo);
  if (result.missing) return warn("ignored", "No needed file is git-ignored", "git is not installed here, so this could not be checked");
  const ignored = result.stdout.split("\n").map(line => line.trim()).filter(Boolean);
  return ignored.length ? fail("ignored", "No needed file is git-ignored", `git would NOT push: ${ignored.join(", ")}`)
    : pass("ignored", "No needed file is git-ignored");
}

function checkCommitted(repo, git) {
  // Anything that is new or edited and not committed is invisible to GitHub, so the build there would not see it.
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", ".github", "desktop", "system"], repo);
  if (status.missing || !status.ok) return warn("committed", "The installer files are committed", "could not ask git");
  const changed = status.stdout.split("\n").map(line => line.slice(3).trim()).filter(Boolean);
  const needed = REQUIRED.filter(file => changed.includes(file));
  if (!changed.length) return pass("committed", "The installer files are committed");
  return warn("committed", "The installer files are committed",
    `${changed.length} file(s) in .github, desktop and system have changes that are not committed yet` +
    (needed.length ? ` (${needed.length} of the files the build needs, for example ${needed.slice(0, 3).join(", ")})` : "") +
    ". GitHub can only build what has been committed and pushed.");
}

function checkPushContents(repo, git) {
  const dry = git(["add", "-n", "-A"], repo);
  if (dry.missing || !dry.ok) return warn("push", "Nothing secret or generated would be pushed", "could not ask git");
  const paths = dry.stdout.split("\n").map(line => /^add '(.+)'$/.exec(line.trim())?.[1]).filter(Boolean);
  const found = [];
  for (const file of paths) for (const [pattern, label] of FORBIDDEN_IN_PUSH) if (pattern.test(file)) found.push(`${file} (${label})`);
  return found.length ? fail("push", "Nothing secret or generated would be pushed", `git add -A would include: ${found.slice(0, 5).join("; ")}`)
    : pass("push", "Nothing secret or generated would be pushed", `${paths.length} changed/new files would be added`);
}

function checkWorkflows(repo) {
  let yaml;
  try { yaml = require(path.join(repo, "desktop/node_modules/js-yaml")); } catch { return warn("workflows", "Workflows are valid and reference real files", "js-yaml is not installed (run npm ci in desktop)"); }
  const problems = [];
  const dir = path.join(repo, ".github/workflows");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /\.ya?ml$/.test(name)) : [];
  if (!files.length) return fail("workflows", "Workflows are valid and reference real files", "no workflow files");
  for (const name of files) {
    let doc;
    try { doc = yaml.load(fs.readFileSync(path.join(dir, name), "utf8")); } catch (error) { problems.push(`${name}: not valid YAML (${error.message.split("\n")[0]})`); continue; }
    if (!doc?.jobs || typeof doc.jobs !== "object") { problems.push(`${name}: has no jobs`); continue; }
    if (!doc.on && !doc.true) problems.push(`${name}: has no trigger`);
    for (const [jobId, job] of Object.entries(doc.jobs)) {
      if (!job["runs-on"]) problems.push(`${name}/${jobId}: no runs-on`);
      for (const [index, step] of (job.steps || []).entries()) {
        const where = `${name}/${jobId}/step ${index + 1}`;
        if (step.uses && !/^[\w.-]+\/[\w./-]+@v?\d/.test(step.uses)) problems.push(`${where}: "${step.uses}" is not pinned to a version`);
        const workDir = step["working-directory"];
        if (workDir && !fs.existsSync(path.join(repo, workDir))) problems.push(`${where}: working-directory ${workDir} does not exist`);
        for (const match of String(step.run || "").matchAll(/(?:^|[\s"'])((?:desktop\/)?scripts\/[\w.-]+\.(?:cjs|js|mjs))/g)) {
          const candidates = [path.join(repo, match[1]), path.join(repo, workDir || "", match[1]), path.join(repo, "desktop", match[1])];
          if (!candidates.some(candidate => fs.existsSync(candidate))) problems.push(`${where}: runs ${match[1]}, which does not exist`);
        }
      }
    }
  }
  return problems.length ? fail("workflows", "Workflows are valid and reference real files", problems.join("; "))
    : pass("workflows", "Workflows are valid and reference real files", files.join(", "));
}

function localRequires(source) {
  return [...source.matchAll(/require\("\.\/([\w.-]+?)(?:\.js)?"\)/g)].map(match => `${match[1]}.js`);
}

function checkPackagedFiles(repo) {
  const desktop = path.join(repo, "desktop");
  const files = readJson(path.join(desktop, "package.json")).build?.files ?? [];
  const missing = [];
  const pending = files.filter(file => file.endsWith(".js"));
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const full = path.join(desktop, file);
    if (!fs.existsSync(full)) { missing.push(`${file} (listed but absent)`); continue; }
    for (const required of localRequires(fs.readFileSync(full, "utf8"))) {
      if (!files.includes(required)) missing.push(`${required} (needed by ${file})`);
      else pending.push(required);
    }
  }
  return missing.length ? fail("packaged", "Every file the app loads is packed into it", `the packaged app would crash on start: ${[...new Set(missing)].join(", ")}`)
    : pass("packaged", "Every file the app loads is packed into it", `${files.length} files listed`);
}

function checkLockfile(repo, dir) {
  const pkg = readJson(path.join(repo, dir, "package.json"));
  const lock = readJson(path.join(repo, dir, "package-lock.json"));
  const root = lock.packages?.[""] ?? {};
  const problems = [];
  for (const field of ["dependencies", "devDependencies"]) {
    const wanted = pkg[field] ?? {};
    const locked = root[field] ?? {};
    for (const [name, range] of Object.entries(wanted)) {
      if (locked[name] !== range) problems.push(`${name}: package.json says ${range}, the lockfile says ${locked[name] ?? "nothing"}`);
      if (!lock.packages?.[`node_modules/${name}`]) problems.push(`${name}: not in the lockfile`);
    }
    for (const name of Object.keys(locked)) if (!(name in wanted)) problems.push(`${name}: in the lockfile but not in package.json`);
  }
  return problems.length ? fail(`lock-${dir}`, `${dir}: package-lock.json matches package.json (npm ci needs this)`, problems.slice(0, 4).join("; "))
    : pass(`lock-${dir}`, `${dir}: package-lock.json matches package.json (npm ci needs this)`);
}

function checkVersionAndWda(repo) {
  const problems = [];
  const version = readJson(path.join(repo, "desktop/package.json")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`desktop version "${version}" is not x.y.z`);
  const lock = readJson(path.join(repo, "desktop/wda.lock.json"));
  if (!/^[0-9a-f]{40}$/.test(lock.commit || "")) problems.push("wda.lock.json has no full 40-character commit");
  if (lock.tag !== `v${lock.version}`) problems.push(`wda.lock.json tag ${lock.tag} does not match version ${lock.version}`);
  return problems.length ? fail("version", "Version numbers and the pinned WebDriverAgent are sane", problems.join("; "))
    : pass("version", "Version numbers and the pinned WebDriverAgent are sane", `app ${version}, WebDriverAgent ${lock.version}`);
}

function checkPackageResources(repo) {
  const problems = [];
  const plist = fs.readFileSync(path.join(repo, "desktop/build/entitlements.mac.plist"), "utf8");
  if (!/^<\?xml/.test(plist) || !plist.includes("</plist>") || !plist.includes("com.apple.security.cs.allow-jit")) problems.push("entitlements.mac.plist looks wrong");
  const components = fs.readFileSync(path.join(repo, "desktop/build/pkg/components.plist"), "utf8");
  if (!components.includes("BundleIsRelocatable")) problems.push("components.plist has no BundleIsRelocatable");
  for (const page of ["welcome", "readme", "conclusion"]) {
    const html = fs.readFileSync(path.join(repo, `desktop/build/pkg/resources/${page}.html`), "utf8");
    if (html.trim().length < 40) problems.push(`the ${page} page of the installer is empty`);
  }
  return problems.length ? fail("resources", "Installer pages and entitlements are in place", problems.join("; "))
    : pass("resources", "Installer pages and entitlements are in place");
}

function checkDryRun(repo) {
  const result = spawnSync(process.execPath, ["scripts/build-mac-pkg.cjs", "--dry-run"], { cwd: path.join(repo, "desktop"), encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  const wanted = ["prepare-runtime", "prepare-wda", "build-app", "pkgbuild", "productbuild", "verify-expanded-pkg"];
  const missing = wanted.filter(step => !output.includes(`[${step}]`));
  return result.status === 0 && !missing.length ? pass("plan", "The build plan is complete", "runtime, WebDriverAgent, app, pkgbuild, productbuild, verification")
    : fail("plan", "The build plan is complete", result.status === 0 ? `missing steps: ${missing.join(", ")}` : output.trim().split("\n").slice(-2).join(" "));
}

function runChecks({ repo = REPO, git = defaultGit } = {}) {
  const guarded = (fn, id, title) => {
    try { return fn(); } catch (error) { return fail(id, title, error.message); }
  };
  return [
    guarded(() => checkRequiredFiles(repo), "files", "Every file the build needs exists"),
    guarded(() => checkNotIgnored(repo, git), "ignored", "No needed file is git-ignored"),
    guarded(() => checkCommitted(repo, git), "committed", "The needed files are committed"),
    guarded(() => checkPushContents(repo, git), "push", "Nothing secret or generated would be pushed"),
    guarded(() => checkWorkflows(repo), "workflows", "Workflows are valid and reference real files"),
    guarded(() => checkPackagedFiles(repo), "packaged", "Every file the app loads is packed into it"),
    guarded(() => checkLockfile(repo, "system"), "lock-system", "system lockfile"),
    guarded(() => checkLockfile(repo, "desktop"), "lock-desktop", "desktop lockfile"),
    guarded(() => checkVersionAndWda(repo), "version", "Version numbers and the pinned WebDriverAgent are sane"),
    guarded(() => checkPackageResources(repo), "resources", "Installer pages and entitlements are in place"),
    guarded(() => checkDryRun(repo), "plan", "The build plan is complete"),
  ];
}

function runSuites(repo) {
  const results = [];
  for (const dir of ["system", "desktop"]) {
    const run = spawnSync("npm", ["test"], { cwd: path.join(repo, dir), encoding: "utf8", shell: process.platform === "win32", maxBuffer: 256 * 1024 * 1024 });
    const summary = /Full suite: ([^\n]+)|ℹ pass (\d+)[\s\S]*ℹ fail (\d+)/.exec(run.stdout || "");
    results.push(run.status === 0 ? pass(`tests-${dir}`, `${dir} tests`, summary?.[1] ?? "passed") : fail(`tests-${dir}`, `${dir} tests`, "failed - run npm test there to see which"));
  }
  return results;
}

function render(results) {
  const mark = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const lines = results.map(result => `[${mark[result.status]}] ${result.title}${result.detail ? `\n       ${result.detail}` : ""}`);
  const failed = results.filter(result => result.status === "fail").length;
  const warned = results.filter(result => result.status === "warn").length;
  lines.push("", failed ? `NOT READY: ${failed} check(s) failed.` : warned ? `Ready to commit, with ${warned} thing(s) to do first (see WARN).` : "Everything checkable without a Mac is in order.");
  lines.push("This cannot prove the .pkg builds or installs: that needs macOS (the GitHub workflow does it) and real iPhones.");
  return lines.join("\n");
}

if (require.main === module) {
  const results = runChecks();
  if (process.argv.includes("--tests")) results.push(...runSuites(REPO));
  console.log(render(results));
  process.exit(results.some(result => result.status === "fail") ? 1 : 0);
}

module.exports = { REQUIRED, checkPackagedFiles, checkLockfile, render, runChecks };
