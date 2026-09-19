// The release checklist is itself part of the suite: a change that would make the first GitHub build fail for a
// silly reason (a needed file git ignores, a packaged file missing from build.files, a lockfile out of step, a
// secret about to be committed) fails here first, on any machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REQUIRED, runChecks, render } = require("../scripts/check-release.cjs");

const repo = path.resolve(__dirname, "..", "..");
const quietGit = () => ({ ok: true, stdout: "", stderr: "" });
const byId = (results, id) => results.find(result => result.id === id);

test("the real repository passes every check that does not depend on git history", () => {
  const results = runChecks({ repo, git: quietGit });
  const failed = results.filter(result => result.status === "fail");
  assert.deepEqual(failed.map(result => `${result.id}: ${result.detail}`), []);
  assert.deepEqual(results.map(result => result.id), ["files", "ignored", "committed", "push", "workflows", "packaged", "lock-system", "lock-desktop", "version", "resources", "plan"]);
});

test("a needed file that git would ignore is a failure, not a surprise on the build machine", () => {
  const git = args => (args[0] === "check-ignore" ? { ok: true, stdout: "desktop/wda.lock.json\n" } : quietGit());
  const result = byId(runChecks({ repo, git }), "ignored");
  assert.equal(result.status, "fail");
  assert.match(result.detail, /desktop\/wda\.lock\.json/);
});

test("secrets, keys, packages and installed modules are never allowed into a push", () => {
  const added = ["desktop/main.js", "operators.config.json", "certs/developer.p12", "desktop/node_modules/x/index.js", "deploy/hub/.env", "deploy/hub/.env.example", "Phone-Farm-0.1.0.pkg"];
  const git = args => (args[0] === "add" ? { ok: true, stdout: added.map(file => `add '${file}'\n`).join("") } : quietGit());
  const result = byId(runChecks({ repo, git }), "push");
  assert.equal(result.status, "fail");
  for (const expected of ["operators.config.json", "developer.p12", "node_modules", "deploy/hub/.env ", ".pkg"]) assert.match(result.detail.replace(/\)\s*;/g, ") ;"), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) );
  assert.doesNotMatch(result.detail, /\.env\.example/, "an example file is fine");
});

test("ordinary source changes pass the push check", () => {
  const git = args => (args[0] === "add" ? { ok: true, stdout: "add 'desktop/main.js'\nadd 'deploy/hub/.env.example'\n" } : quietGit());
  assert.equal(byId(runChecks({ repo, git }), "push").status, "pass");
});

test("uncommitted work is reported as something to do before pushing, not hidden", () => {
  const git = args => (args[0] === "status" ? { ok: true, stdout: "?? .github/workflows/mac-installer.yml\n M desktop/main.js\n" } : quietGit());
  const result = byId(runChecks({ repo, git }), "committed");
  assert.equal(result.status, "warn");
  assert.match(result.detail, /2 file\(s\)/);
  assert.match(result.detail, /mac-installer\.yml/);
  assert.equal(byId(runChecks({ repo, git: quietGit }), "committed").status, "pass");
});

test("without git the git-based checks warn instead of pretending everything is fine", () => {
  const git = () => ({ ok: false, missing: true, stdout: "", stderr: "" });
  const results = runChecks({ repo, git });
  for (const id of ["ignored", "committed", "push"]) assert.equal(byId(results, id).status, "warn", id);
});

function copyRepoSkeleton(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-release-"));
  for (const file of REQUIRED) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(dir, file));
  }
  fs.mkdirSync(path.join(dir, "desktop/node_modules"), { recursive: true });
  fs.cpSync(path.join(repo, "desktop/node_modules/js-yaml"), path.join(dir, "desktop/node_modules/js-yaml"), { recursive: true });
  fs.cpSync(path.join(repo, "desktop/node_modules/argparse"), path.join(dir, "desktop/node_modules/argparse"), { recursive: true });
  for (const other of ["hostFixes", "serverSupervisor", "diagnostics", "wdaSource", "windowSecurity", "siteAgentConfig", "hostEnvironment"]) {
    fs.copyFileSync(path.join(repo, `desktop/${other}.js`), path.join(dir, `desktop/${other}.js`));
  }
  mutate?.(dir);
  return dir;
}

test("a file the app loads but build.files omits is caught (the packaged app would crash on start)", () => {
  const dir = copyRepoSkeleton(root => {
    const pkgPath = path.join(root, "desktop/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.build.files = pkg.build.files.filter(file => file !== "hostFixes.js");
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  });
  try {
    const result = byId(runChecks({ repo: dir, git: quietGit }), "packaged");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /hostFixes\.js \(needed by/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lockfile that has drifted from package.json is caught (npm ci would refuse it)", () => {
  const dir = copyRepoSkeleton(root => {
    const pkgPath = path.join(root, "system/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.dependencies.express = "^99.0.0";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  });
  try {
    const result = byId(runChecks({ repo: dir, git: quietGit }), "lock-system");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /express: package\.json says \^99\.0\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a workflow that runs a script that does not exist is caught", () => {
  const dir = copyRepoSkeleton(root => {
    const workflow = path.join(root, ".github/workflows/mac-installer.yml");
    fs.writeFileSync(workflow, fs.readFileSync(workflow, "utf8").replace("scripts/audit-gate.cjs", "scripts/not-a-real-script.cjs"));
  });
  try {
    const result = byId(runChecks({ repo: dir, git: quietGit }), "workflows");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /not-a-real-script\.cjs, which does not exist/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the printed checklist is plain language and says what it cannot prove", () => {
  const text = render(runChecks({ repo, git: quietGit }));
  assert.match(text, /\[PASS\] Every file the build needs exists/);
  assert.match(text, /cannot prove the \.pkg builds or installs/);
});
