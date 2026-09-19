const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const repoRoot = path.resolve(__dirname, "..", "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "mac-installer.yml");
const text = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(text);
const build = workflow.jobs.build;
const runs = build.steps.map(step => `${step.name || ""}\n${step.run || ""}\n${step.uses || ""}`);
const indexOf = pattern => runs.findIndex(entry => pattern.test(entry));

test("the workflow parses and triggers on version tags, main and pull requests", () => {
  assert.equal(workflow.name, "macOS installer");
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.ok(workflow.on.pull_request);
  assert.ok(workflow.on.workflow_dispatch);
});

test("packaging runs on a macOS runner", () => {
  assert.match(build["runs-on"], /^macos-/);
});

test("nothing is built until the full server suite, the desktop suite and the audits have passed", () => {
  const server = indexOf(/Server test suite \(full\)/);
  const desktop = indexOf(/Desktop tests/);
  const audit = indexOf(/audit-gate/);
  const productionAudit = indexOf(/npm audit --omit=dev/);
  const buildStep = indexOf(/build-mac-pkg\.cjs --arch/);
  for (const step of [server, desktop, audit, productionAudit, buildStep]) assert.ok(step >= 0);
  assert.ok(Math.max(server, desktop, audit, productionAudit) < buildStep, "gates must precede the build");
  const serverStep = build.steps[server];
  assert.match(serverStep.run, /npm test/);
  assert.equal(serverStep["working-directory"], "system");
  assert.match(String(serverStep.env.TZ), /Asia\/Tokyo/, "the suite must run under a zone that is neither the California default nor UTC");
});

test("dependencies are installed from the lockfiles", () => {
  const installs = build.steps.filter(step => /npm (ci|install)/.test(step.run || ""));
  assert.ok(installs.length >= 2);
  for (const step of installs) {
    assert.match(step.run, /npm ci/);
    assert.doesNotMatch(step.run, /npm install/);
  }
});

test("build, verify, install-with-Installer and upload happen in that order", () => {
  const order = [
    indexOf(/build-mac-pkg\.cjs --arch/),
    indexOf(/build-mac-pkg\.cjs --verify/),
    indexOf(/sudo installer -pkg/),
    indexOf(/actions\/upload-artifact/),
  ];
  assert.ok(order.every(position => position >= 0), order.join(","));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const install = build.steps.find(step => /sudo installer -pkg/.test(step.run || ""));
  assert.match(install.run, /verify-packaged-runtime\.cjs/);
  assert.match(install.run, /\/Applications\/Phone Farm\.app/);
});

test("the .pkg is uploaded as a workflow artifact and a missing file is an error", () => {
  const upload = build.steps.find(step => /upload-artifact/.test(step.uses || ""));
  assert.match(upload.with.name, /phone-farm-pkg-/);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.match(upload.with.path, /steps\.build\.outputs\.pkg_path/);
});

test("a tagged build must match the app version and is a release build (unsigned only if explicitly allowed)", () => {
  const tagCheck = build.steps.find(step => /must match the app version/.test(step.name || ""));
  assert.match(tagCheck.if, /refs\/tags\/v/);
  assert.match(tagCheck.run, /desktop\/package\.json/);
  const buildStep = build.steps.find(step => step.id === "build");
  assert.match(buildStep.env.PHONE_FARM_RELEASE, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(buildStep.env.PHONE_FARM_ALLOW_UNSIGNED, /vars\.ALLOW_UNSIGNED_RELEASE/);
});

test("signing and notarization inputs are secrets, never literals", () => {
  const consumed = ["MACOS_APP_CERT_P12_BASE64", "MACOS_APP_CERT_PASSWORD", "MACOS_INSTALLER_CERT_P12_BASE64", "MACOS_INSTALLER_CERT_PASSWORD",
    "APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_ID", "APPLE_TEAM_ID", "APPLE_APP_SPECIFIC_PASSWORD"];
  for (const name of consumed) {
    assert.match(text, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`), `${name} must come from secrets`);
  }
  assert.doesNotMatch(text, /-----BEGIN/);
  assert.doesNotMatch(text, /[A-Za-z0-9+/]{80,}={0,2}/, "no embedded key material");
});

test("the app and package signing steps use the temporary keychain that is always cleaned up", () => {
  const importStep = build.steps.find(step => /Import Apple signing certificates/.test(step.name || ""));
  assert.match(importStep.run, /security create-keychain/);
  assert.match(importStep.run, /rm -f .*app\.p12/);
  const cleanup = build.steps.at(-1);
  assert.equal(cleanup.if, "always()");
  assert.match(cleanup.run, /delete-keychain/);
});

test("the release job publishes the .pkg files to a GitHub Release, only for version tags, with minimal extra permission", () => {
  const release = workflow.jobs.release;
  assert.match(release.if, /refs\/tags\/v/);
  assert.equal(release.needs, "build");
  assert.equal(release.permissions.contents, "write");
  assert.equal(workflow.permissions.contents, "read", "the default token stays read-only");
  const script = release.steps.map(step => step.run || "").join("\n");
  assert.match(script, /gh release (create|upload)/);
  assert.match(script, /\.pkg/);
  assert.match(script, /SHA256SUMS/);
  assert.match(script, /UNSIGNED/, "unsigned packages must be flagged on the release");
  assert.match(script, /--prerelease/);
});

test("the universal installer is optional; the arm64 installer is not", () => {
  assert.match(String(build["continue-on-error"]), /matrix\.arch == 'universal'/);
  assert.match(workflow.jobs.plan.steps.at(-1).run, /"arm64","universal"/);
});

test("every script the workflow calls exists", () => {
  for (const match of text.matchAll(/(?:desktop\/)?scripts\/([\w-]+\.cjs)/g)) {
    assert.ok(fs.existsSync(path.join(repoRoot, "desktop", "scripts", match[1])), match[1]);
  }
});

// ---- Windows installer workflow -------------------------------------------------------
const windowsText = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "windows-installer.yml"), "utf8");
const windowsWorkflow = yaml.load(windowsText);
const windowsBuild = windowsWorkflow.jobs.build;
const windowsRuns = windowsBuild.steps.map(step => `${step.name || ""}\n${step.run || ""}\n${step.uses || ""}`);
const windowsIndex = pattern => windowsRuns.findIndex(entry => pattern.test(entry));

test("the Windows workflow builds on Windows after the whole server and desktop suites pass", () => {
  assert.equal(windowsWorkflow.name, "Windows installer");
  assert.match(windowsBuild["runs-on"], /^windows-/);
  const server = windowsIndex(/Server test suite/);
  const desktop = windowsIndex(/Desktop tests/);
  const build = windowsIndex(/npm run dist:win/);
  assert.ok(server >= 0 && desktop > server && build > desktop, "tests gate the build");
  assert.match(windowsText, /TZ: Asia\/Tokyo/, "scheduling must not depend on the runner's time zone");
});

test("the Windows workflow installs from lockfiles, verifies and uploads the .exe, and publishes only for version tags", () => {
  assert.ok(windowsIndex(/npm ci/) >= 0);
  assert.equal(windowsIndex(/npm install\b/), -1, "no unlocked installs");
  assert.match(windowsText, /desktop\/dist\/\*\.exe/);
  assert.match(windowsText, /if-no-files-found: error/);
  assert.match(windowsWorkflow.jobs.release.if, /refs\/tags\/v/);
  assert.equal(windowsWorkflow.jobs.release.permissions.contents, "write");
  assert.equal(windowsWorkflow.permissions.contents, "read", "least privilege by default");
  assert.match(windowsText, /must match the app version|does not match desktop\/package\.json version/);
});

test("the setup page hides the Mac-only modes on Windows", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "first-run.html"), "utf8");
  assert.match(html, /Windows/);
  assert.match(html, /host-choice[\s\S]*hidden|hidden[\s\S]*host-choice/);
});
