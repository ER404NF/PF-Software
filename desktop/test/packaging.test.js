const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RUNTIME_ALLOWLIST, stageRuntime } = require("../scripts/prepare-runtime.cjs");
const { readLock } = require("../scripts/prepare-wda.cjs");

const desktopDir = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pf-packaging-"));
}

function writeFile(root, relative, content = "x") {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// A stand-in for the development tree, complete with everything that must
// NEVER reach an installer.
function fakeSystemTree(root) {
  writeFile(root, "package.json", JSON.stringify({ name: "fake", dependencies: { express: "1.0.0" } }));
  writeFile(root, "package-lock.json", "{}");
  writeFile(root, "client/index.html", "<html></html>");
  writeFile(root, "client/app.js", "//");
  writeFile(root, "client/phoneStage.js", "//");
  writeFile(root, "server/src/agentMain.js", "//");
  writeFile(root, "server/src/index.js", 'import express from "express";\nimport fs from "node:fs";\n');
  writeFile(root, "models.config.json", '{"providers":[]}');
  writeFile(root, "platform-skills.config.json", '{"skills":[]}');
  writeFile(root, "research.config.json", '{"accounts":[]}');
  // never shipped:
  writeFile(root, "operators.config.json", '{"operators":[{"passwordHash":"secret"}]}');
  writeFile(root, "devices.config.json", "{}");
  writeFile(root, "storage/sessions/abc.json", "session");
  writeFile(root, "tmp/scratch", "x");
  writeFile(root, "server/test/unit/a.test.js", "//");
  writeFile(root, "server/fixtures/fake.js", "//");
  writeFile(root, "test-results-debug.txt", "log");
  writeFile(root, ".env", "SECRET=1");
}

const fakeInstall = stageSystem => writeFile(stageSystem, "node_modules/express/package.json", '{"name":"express"}');

test("only the allow-listed runtime is staged; credentials, storage, tests and fixtures never are", () => {
  const root = scratch();
  try {
    const systemDir = path.join(root, "system");
    fakeSystemTree(systemDir);
    const stageRoot = path.join(root, "stage");
    stageRuntime({ systemDir, stageRoot, install: fakeInstall, log: () => {} });
    const staged = path.join(stageRoot, "system");
    for (const wanted of ["server/src/index.js", "client/index.html", "package.json", "models.config.json", "node_modules/express/package.json"]) {
      assert.ok(fs.existsSync(path.join(staged, wanted)), `${wanted} should be staged`);
    }
    for (const forbidden of ["operators.config.json", "devices.config.json", "storage", "tmp", "server/test", "server/fixtures", "test-results-debug.txt", ".env"]) {
      assert.equal(fs.existsSync(path.join(staged, forbidden)), false, `${forbidden} must not be staged`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging fails loudly when a production import cannot be resolved", () => {
  const root = scratch();
  try {
    const systemDir = path.join(root, "system");
    fakeSystemTree(systemDir);
    writeFile(systemDir, "server/src/index.js", 'import express from "express";\nimport left from "left-pad-not-installed";\n');
    assert.throws(
      () => stageRuntime({ systemDir, stageRoot: path.join(root, "stage"), install: fakeInstall, log: () => {} }),
      /left-pad-not-installed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging fails when an allow-listed file is missing from the repository", () => {
  const root = scratch();
  try {
    const systemDir = path.join(root, "system");
    fakeSystemTree(systemDir);
    fs.rmSync(path.join(systemDir, "client"), { recursive: true });
    assert.throws(() => stageRuntime({ systemDir, stageRoot: path.join(root, "stage"), install: fakeInstall, log: () => {} }), /system\/client/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the allow-list is explicit and never a wildcard over the development tree", () => {
  for (const entry of RUNTIME_ALLOWLIST) {
    assert.doesNotMatch(entry, /[*]|^\.$|^\.\.|operators|storage|test|fixtures|\.env/);
  }
  assert.ok(RUNTIME_ALLOWLIST.includes("server/src"));
});

test("electron-builder packages an allow-listed app, not the whole desktop directory", () => {
  const files = packageJson.build.files;
  assert.ok(files.includes("main.js"));
  assert.equal(files.some(pattern => /\*\*/.test(pattern)), false, "no wildcard patterns: build/runtime and tests must stay out of app.asar");
  for (const source of ["main.js", "hostEnvironment.js", "windowSecurity.js", "wdaSource.js"]) {
    const text = fs.readFileSync(path.join(desktopDir, source), "utf8");
    for (const match of text.matchAll(/require\("\.\/([\w-]+)"\)/g)) {
      assert.ok(files.includes(`${match[1]}.js`), `${source} requires ./${match[1]} which is missing from build.files`);
    }
  }
  for (const file of files) assert.ok(fs.existsSync(path.join(desktopDir, file)), `${file} listed in build.files does not exist`);
});

test("the runtime is shipped from build/runtime so its node_modules is not dropped", () => {
  // electron-builder unconditionally drops a node_modules directory sitting at the ROOT of an
  // extraResources source (util/filter.js). Making build/runtime the root keeps system/node_modules.
  const [resource] = packageJson.build.extraResources;
  assert.equal(packageJson.build.extraResources.length, 1);
  assert.equal(resource.from, "build/runtime");
  assert.equal(resource.to, ".");
  for (const wanted of ["system/**/*", "wda/**/*", "licenses/**/*", "THIRD_PARTY_NOTICES.txt"]) assert.ok(resource.filter.includes(wanted), wanted);
  assert.notEqual(resource.from, "../system");
  assert.notEqual(resource.from, "build/runtime/system");
});

test("the macOS build produces a .pkg installer, signs with the hardened runtime, and does not rely on a DMG", () => {
  const { scripts, build } = packageJson;
  assert.match(scripts["dist:mac"], /dist:mac:pkg/);
  assert.match(scripts["dist:mac:pkg"], /build-mac-pkg\.cjs --arch arm64/);
  assert.match(scripts["dist:mac:pkg:universal"], /--arch universal/);
  assert.equal(build.mac.hardenedRuntime, true);
  assert.equal(build.mac.notarize, false, "notarization is done by build-mac-pkg.cjs so app and installer are notarized in one auditable place");
  assert.equal(build.mac.target.some(target => /dmg|pkg/.test(target.target ?? target)), false, "electron-builder only makes the .app; build-mac-pkg.cjs makes the installer");
  assert.ok(fs.existsSync(path.join(desktopDir, build.mac.entitlements)));
  assert.match(fs.readFileSync(path.join(desktopDir, build.mac.entitlements), "utf8"), /allow-jit/);
  assert.equal(packageJson.productName, "Phone Farm");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
});

test("the installer wizard resources and component definition exist", () => {
  for (const file of ["build/pkg/components.plist", "build/pkg/resources/welcome.html", "build/pkg/resources/readme.html", "build/pkg/resources/conclusion.html"]) {
    assert.ok(fs.existsSync(path.join(desktopDir, file)), file);
  }
  const plist = fs.readFileSync(path.join(desktopDir, "build/pkg/components.plist"), "utf8");
  assert.match(plist, /<key>BundleIsRelocatable<\/key>\s*<false\/>/);
  assert.match(plist, /Phone Farm\.app/);
});

test("WebDriverAgent is pinned to an exact commit, and its license is recorded", () => {
  const lock = readLock();
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  assert.equal(lock.tag, `v${lock.version}`);
  assert.match(lock.repository, /^https:\/\/github\.com\/appium\/WebDriverAgent\.git$/);
  assert.match(lock.license, /BSD/);
  assert.match(lock.licenseNote, /UNMODIFIED/);
});

test("a pin that is not a full commit hash is refused", () => {
  const root = scratch();
  try {
    const file = path.join(root, "lock.json");
    fs.writeFileSync(file, JSON.stringify({ repository: "https://github.com/appium/WebDriverAgent.git", tag: "v1.0.0", version: "1.0.0", commit: "abc123" }));
    assert.throws(() => readLock(file), /40-character SHA/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("build output and staged runtime are not tracked by git", () => {
  const ignore = fs.readFileSync(path.resolve(desktopDir, "..", ".gitignore"), "utf8");
  assert.match(ignore, /^\/desktop\/dist\/$/m);
  assert.match(ignore, /^\/desktop\/build\/runtime\/$/m);
});
