const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ARCHES,
  COMPONENT_ID,
  artifactFileName,
  computePaths,
  inspectExpandedPkg,
  levelFromFileName,
  parseArgs,
  parseIdentityNames,
  planBuild,
  renderDistribution,
  resolveBuildLevel,
  resolveNotaryCredentials,
  resolveSigning,
} = require("../scripts/build-mac-pkg.cjs");

const APP_ID = "Developer ID Application: Example Org (ABCDE12345)";
const INSTALLER_ID = "Developer ID Installer: Example Org (ABCDE12345)";
const API_KEY_ENV = { APPLE_API_KEY: "/tmp/AuthKey.p8", APPLE_API_KEY_ID: "KEYID12345", APPLE_API_ISSUER: "issuer-uuid" };

function build(level, { arch = "arm64", env = {}, appOnly = false } = {}) {
  const signing = resolveSigning({
    env: level === "unsigned" ? {} : { PHONE_FARM_APP_IDENTITY: APP_ID, PHONE_FARM_INSTALLER_IDENTITY: INSTALLER_ID, ...(level === "notarized" ? API_KEY_ENV : {}), ...env },
    findIdentities: () => [],
  });
  const paths = computePaths({ arch, version: "1.2.3", level, workDir: path.join(os.tmpdir(), "pf-plan") });
  return { steps: planBuild({ arch, version: "1.2.3", level, signing, appOnly, paths, nodeBin: "node" }), paths, signing };
}

const ids = steps => steps.map(step => step.id);
const find = (steps, id) => steps.find(step => step.id === id);

// ---- naming ----------------------------------------------------------------

test("the primary artifact is Phone-Farm-<version>-arm64.pkg; anything not notarized says so in its name", () => {
  assert.equal(artifactFileName({ version: "0.1.0", arch: "arm64", level: "notarized" }), "Phone-Farm-0.1.0-arm64.pkg");
  assert.equal(artifactFileName({ version: "0.1.0", arch: "universal", level: "notarized" }), "Phone-Farm-0.1.0-universal.pkg");
  assert.equal(artifactFileName({ version: "0.1.0", arch: "arm64", level: "unsigned" }), "Phone-Farm-0.1.0-arm64-UNSIGNED.pkg");
  assert.equal(artifactFileName({ version: "0.1.0", arch: "arm64", level: "signed" }), "Phone-Farm-0.1.0-arm64-NOT-NOTARIZED.pkg");
  assert.equal(levelFromFileName("Phone-Farm-0.1.0-arm64-UNSIGNED.pkg"), "unsigned");
  assert.equal(levelFromFileName("Phone-Farm-0.1.0-arm64-NOT-NOTARIZED.pkg"), "signed");
  assert.equal(levelFromFileName("Phone-Farm-0.1.0-arm64.pkg"), "notarized");
});

// ---- credential resolution -------------------------------------------------

test("identities come from the environment first, then the keychain", () => {
  const keychain = [`Developer ID Application: Keychain Org (K1234567890)`, `Developer ID Installer: Keychain Org (K1234567890)`, "Apple Development: someone"];
  const found = resolveSigning({ env: {}, findIdentities: () => keychain });
  assert.equal(found.appIdentity, keychain[0]);
  assert.equal(found.installerIdentity, keychain[1]);
  const overridden = resolveSigning({ env: { PHONE_FARM_APP_IDENTITY: APP_ID }, findIdentities: () => keychain });
  assert.equal(overridden.appIdentity, APP_ID);
  assert.equal(overridden.installerIdentity, keychain[1]);
});

test("`security find-identity -v` output is parsed to identity names", () => {
  const output = `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Example Org (ABCDE12345)"
  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Installer: Example Org (ABCDE12345)"
     2 valid identities found`;
  assert.deepEqual(parseIdentityNames(output), [APP_ID, INSTALLER_ID]);
});

test("notarization credentials: keychain profile, API key, or Apple ID - and a password is never on a command line", () => {
  assert.deepEqual(resolveNotaryCredentials({ NOTARY_KEYCHAIN_PROFILE: "pf", NOTARY_KEYCHAIN: "/k.keychain-db" }).args,
    ["--keychain-profile", "pf", "--keychain", "/k.keychain-db"]);
  assert.deepEqual(resolveNotaryCredentials(API_KEY_ENV).args, ["--key", "/tmp/AuthKey.p8", "--key-id", "KEYID12345", "--issuer", "issuer-uuid"]);
  const appleId = resolveNotaryCredentials({ APPLE_ID: "a@b.c", APPLE_TEAM_ID: "ABCDE12345", APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop" });
  assert.equal(appleId.kind, "apple-id");
  assert.ok(appleId.args.includes("@env:APPLE_APP_SPECIFIC_PASSWORD"));
  assert.equal(appleId.args.some(arg => arg.includes("abcd-efgh")), false);
  assert.equal(resolveNotaryCredentials({ APPLE_API_KEY: "/k", APPLE_ID: "a@b.c" }), null, "incomplete credential sets are not used");
  assert.equal(resolveNotaryCredentials({}), null);
});

// ---- policy ------------------------------------------------------------------

test("signing level: none -> unsigned, both identities -> signed, plus notarization -> notarized", () => {
  const notary = { kind: "api-key", args: [] };
  assert.equal(resolveBuildLevel({ signing: { appIdentity: null, installerIdentity: null, notary: null } }), "unsigned");
  assert.equal(resolveBuildLevel({ signing: { appIdentity: APP_ID, installerIdentity: INSTALLER_ID, notary: null } }), "signed");
  assert.equal(resolveBuildLevel({ signing: { appIdentity: APP_ID, installerIdentity: INSTALLER_ID, notary } }), "notarized");
});

test("a half-configured signing setup is an error, never a silent downgrade", () => {
  assert.throws(() => resolveBuildLevel({ signing: { appIdentity: APP_ID, installerIdentity: null, notary: null } }), /half-configured.*no Developer ID Installer/);
  assert.throws(() => resolveBuildLevel({ signing: { appIdentity: null, installerIdentity: INSTALLER_ID, notary: null } }), /half-configured.*no Developer ID Application/);
});

test("a release must be notarized unless an unsigned fallback is explicitly allowed", () => {
  const none = { appIdentity: null, installerIdentity: null, notary: null };
  assert.throws(() => resolveBuildLevel({ signing: none, release: true }), /must be signed AND notarized/);
  assert.equal(resolveBuildLevel({ signing: none, release: true, allowUnsigned: true }), "unsigned");
  const signedOnly = { appIdentity: APP_ID, installerIdentity: INSTALLER_ID, notary: null };
  assert.throws(() => resolveBuildLevel({ signing: signedOnly, release: true }), /notarized/);
});

test("command-line options are validated", () => {
  assert.deepEqual(parseArgs(["--arch", "universal", "--release", "--dry-run"]), { arch: "universal", appOnly: false, release: true, dryRun: true, verifyPath: null, expect: null });
  assert.throws(() => parseArgs(["--arch", "x86"]), /--arch must be/);
  assert.throws(() => parseArgs(["--frobnicate"]), /unknown option/);
  assert.throws(() => parseArgs(["--expect", "maybe"]), /--expect must be/);
});

// ---- the build plan ----------------------------------------------------------

test("an unsigned build ad-hoc signs the app, builds the pkg, and never touches Apple's notary service", () => {
  const { steps } = build("unsigned");
  assert.deepEqual(ids(steps), [
    "ensure-electron", "prepare-runtime", "prepare-wda", "build-app", "adhoc-sign-app",
    "stage-pkg-root", "copy-app", "pkgbuild", "write-distribution", "productbuild", "expand-pkg", "verify-expanded-pkg",
  ]);
  assert.equal(find(steps, "build-app").env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.deepEqual(find(steps, "adhoc-sign-app").args.slice(0, 4), ["--force", "--deep", "--sign", "-"]);
  assert.equal(find(steps, "productbuild").args.includes("--sign"), false);
  assert.equal(steps.some(step => step.args?.includes("notarytool")), false);
  assert.match(find(steps, "productbuild").args.at(-1), /Phone-Farm-1\.2\.3-arm64-UNSIGNED\.pkg$/);
});

test("a notarized build signs, notarizes and staples BOTH the app and the package, then verifies with Apple's tools", () => {
  const { steps } = build("notarized");
  assert.deepEqual(ids(steps), [
    "ensure-electron", "prepare-runtime", "prepare-wda", "build-app", "verify-app-signature",
    "zip-app", "notarize-app", "staple-app", "validate-app-ticket",
    "stage-pkg-root", "copy-app", "pkgbuild", "write-distribution", "productbuild",
    "notarize-pkg", "staple-pkg",
    "verify-pkg-signature", "validate-pkg-ticket", "assess-pkg", "expand-pkg", "verify-expanded-pkg",
  ]);
  assert.equal(find(steps, "build-app").env.CSC_NAME, "Example Org (ABCDE12345)", "electron-builder gets the identity without its 'Developer ID Application:' prefix");
  assert.deepEqual(find(steps, "productbuild").args.slice(-4, -1), ["--sign", INSTALLER_ID, "--timestamp"]);
  const notarizePkg = find(steps, "notarize-pkg");
  assert.deepEqual(notarizePkg.args.slice(0, 2), ["notarytool", "submit"]);
  assert.ok(notarizePkg.args.includes("--wait"));
  assert.ok(notarizePkg.args.includes("--key-id"));
  assert.deepEqual(find(steps, "verify-app-signature").args.slice(0, 3), ["--verify", "--deep", "--strict"]);
  assert.deepEqual(find(steps, "staple-pkg").args.slice(0, 2), ["stapler", "staple"]);
  assert.deepEqual(find(steps, "assess-pkg").args.slice(0, 3), ["--assess", "--type", "install"]);
  assert.match(find(steps, "verify-pkg-signature").expectOutput.source, /Developer ID Installer/);
  assert.match(find(steps, "productbuild").args.at(-1), /Phone-Farm-1\.2\.3-arm64\.pkg$/);
});

test("a signed-but-not-notarized build signs everything and is labelled NOT-NOTARIZED", () => {
  const { steps } = build("signed");
  assert.ok(ids(steps).includes("verify-pkg-signature"));
  assert.equal(ids(steps).some(id => /notarize|staple|assess/.test(id)), false);
  assert.match(find(steps, "productbuild").args.at(-1), /-NOT-NOTARIZED\.pkg$/);
});

test("the package installs to /Applications, is never relocatable, and runs no scripts", () => {
  const { steps, paths } = build("notarized");
  const pkgbuild = find(steps, "pkgbuild");
  const value = flag => pkgbuild.args[pkgbuild.args.indexOf(flag) + 1];
  assert.equal(value("--install-location"), "/Applications");
  assert.equal(value("--identifier"), COMPONENT_ID);
  assert.equal(value("--version"), "1.2.3");
  assert.equal(value("--component-plist"), paths.componentsPlist);
  assert.equal(pkgbuild.args.includes("--scripts"), false, "no pre/post-install scripts: nothing runs on the user's machine");
  assert.equal(steps.some(step => /^(npm|npx)$/.test(step.cmd) && step.id !== "build-app"), false);
});

test("the installer is built from the app produced by electron-builder for the requested architecture", () => {
  assert.match(build("unsigned", { arch: "arm64" }).paths.appPath.replaceAll("\\", "/"), /dist\/mac-arm64\/Phone Farm\.app$/);
  assert.match(build("unsigned", { arch: "universal" }).paths.appPath.replaceAll("\\", "/"), /dist\/mac-universal\/Phone Farm\.app$/);
  assert.ok(find(build("unsigned", { arch: "universal" }).steps, "build-app").args.includes("--universal"));
  assert.ok(find(build("unsigned", { arch: "arm64" }).steps, "build-app").args.includes("--arm64"));
});

test("--app-only stops after the (signed) app", () => {
  const { steps } = build("notarized", { appOnly: true });
  assert.equal(steps.at(-1).id, "validate-app-ticket");
  assert.equal(ids(steps).includes("pkgbuild"), false);
});

// ---- the wizard ----------------------------------------------------------------

test("the installer wizard has welcome, read-me and conclusion pages, installs on the system volume, and restricts architectures", () => {
  const xml = renderDistribution({ version: "1.2.3", hostArchitectures: ARCHES.arm64.hostArchitectures });
  assert.match(xml, /<welcome file="welcome\.html"/);
  assert.match(xml, /<readme file="readme\.html"/);
  assert.match(xml, /<conclusion file="conclusion\.html"/);
  assert.match(xml, /hostArchitectures="arm64"/);
  assert.match(xml, /customize="never"/);
  assert.match(xml, /enable_localSystem="true"/);
  assert.match(xml, /enable_currentUserHome="false"/);
  assert.match(xml, /<os-version min="12\.0"\/>/);
  assert.match(xml, new RegExp(`<pkg-ref id="${COMPONENT_ID}" version="1\\.2\\.3"`));
  assert.match(renderDistribution({ version: "1.2.3", hostArchitectures: ARCHES.universal.hostArchitectures }), /hostArchitectures="arm64,x86_64"/);
});

// ---- inspecting what the package would install ---------------------------------

function expandedPkg(root, { version = "1.2.3", installLocation = "/Applications", hostArchitectures = "arm64", wda = true, bundleId = COMPONENT_ID } = {}) {
  const write = (relative, content = "x") => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write("Distribution", `<installer-gui-script><options hostArchitectures="${hostArchitectures}"/><welcome file="w.html"/><readme file="r.html"/><conclusion file="c.html"/></installer-gui-script>`);
  write("component.pkg/PackageInfo", `<pkg-info install-location="${installLocation}" identifier="${COMPONENT_ID}"/>`);
  const app = "component.pkg/Payload/Phone Farm.app/Contents";
  write(`${app}/Info.plist`, `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`);
  write(`${app}/Resources/system/package.json`, JSON.stringify({ name: "fake", dependencies: { express: "1" } }));
  write(`${app}/Resources/system/package-lock.json`, "{}");
  write(`${app}/Resources/system/client/index.html`, "<html></html>");
  write(`${app}/Resources/system/client/app.js`, "//");
  write(`${app}/Resources/system/client/phoneStage.js`, "//");
  write(`${app}/Resources/system/server/src/agentMain.js`, "//");
  write(`${app}/Resources/system/server/src/index.js`, 'import express from "express";\n');
  write(`${app}/Resources/system/node_modules/express/package.json`, "{}");
  if (wda) {
    write(`${app}/Resources/wda/WDA_VERSION.json`, "{}");
    write(`${app}/Resources/wda/WebDriverAgent/WebDriverAgent.xcodeproj/project.pbxproj`, "//");
    write(`${app}/Resources/wda/WebDriverAgent/LICENSE`, "BSD");
    write(`${app}/Resources/licenses/WebDriverAgent-LICENSE.txt`, "BSD");
  }
}

async function inspect(options = {}, expectation = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-expanded-"));
  try {
    expandedPkg(root, options);
    return await inspectExpandedPkg({ expandedDir: root, version: "1.2.3", arch: "arm64", level: "notarized", boot: false, ...expectation });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a correct expanded package passes inspection", async () => {
  assert.deepEqual(await inspect(), []);
});

test("inspection rejects a wrong install location, version, bundle id, architecture rule or missing WDA", async () => {
  assert.ok((await inspect({ installLocation: "/Users/me/Desktop" })).some(failure => /install-location/.test(failure)));
  assert.ok((await inspect({ version: "9.9.9" })).some(failure => /Info\.plist version/.test(failure)));
  assert.ok((await inspect({ bundleId: "com.other.app" })).some(failure => /CFBundleIdentifier/.test(failure)));
  assert.ok((await inspect({ hostArchitectures: "x86_64" })).some(failure => /hostArchitectures/.test(failure)));
  assert.ok((await inspect({ wda: false })).some(failure => /wda/.test(failure)));
});

test("inspection of a package with no app reports it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-expanded-empty-"));
  try {
    const failures = await inspectExpandedPkg({ expandedDir: root, version: "1.2.3", arch: "arm64", level: "unsigned", boot: false });
    assert.match(failures[0], /does not contain Phone Farm\.app/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
