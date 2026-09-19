#!/usr/bin/env node
// Builds the macOS installer users actually download:
//
//     Phone-Farm-<version>-<arch>.pkg      (double-click -> Installer.app -> /Applications/Phone Farm.app)
//
// Pipeline: stage the runtime + pinned WebDriverAgent -> electron-builder makes
// Phone Farm.app -> (sign, notarize, staple the app) -> pkgbuild/productbuild make
// the installer package -> (sign, notarize, staple the package) -> verify.
// Nothing runs on the END USER's machine except Apple's Installer: no npm, no
// Node, no tests, no build.
//
// Signing modes (decided from the environment, never hard-coded credentials):
//   notarized  Developer ID Application + Installer identities and notarization
//              credentials present -> the seamless public installer.
//   signed     both identities, no notarization credentials -> NOT-NOTARIZED.
//   unsigned   nothing configured -> ad-hoc-signed app, UNSIGNED installer.
//              Gatekeeper WILL warn; this is a local development artifact only.
// A release (--release / PHONE_FARM_RELEASE=true) fails unless it is notarized,
// unless PHONE_FARM_ALLOW_UNSIGNED=true explicitly permits a clearly-named fallback.
//
//   node scripts/build-mac-pkg.cjs [--arch arm64|universal] [--app-only] [--release] [--dry-run]
//   node scripts/build-mac-pkg.cjs --verify <file.pkg> [--expect notarized|signed|unsigned]
//
// Signing/notarization environment (all optional):
//   PHONE_FARM_APP_IDENTITY         "Developer ID Application: Name (TEAMID)" (else auto-discovered in the keychain)
//   PHONE_FARM_INSTALLER_IDENTITY   "Developer ID Installer: Name (TEAMID)"   (else auto-discovered)
//   NOTARY_KEYCHAIN_PROFILE [+ NOTARY_KEYCHAIN]                   notarytool stored-credentials profile
//   APPLE_API_KEY (path to .p8) + APPLE_API_KEY_ID [+ APPLE_API_ISSUER]   App Store Connect API key
//   APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD        Apple ID (password is passed as @env:, never on argv)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { verifyPackagedRuntime } = require("./verify-packaged-runtime.cjs");

const desktopDir = path.resolve(__dirname, "..");
const PRODUCT_NAME = "Phone Farm";
const APP_BUNDLE = "Phone Farm.app";
const COMPONENT_ID = "com.phonefarm.desktop";
const MIN_MACOS = "12.0";
const ARCHES = {
  arm64: { builderFlag: "--arm64", outputDir: "mac-arm64", hostArchitectures: "arm64" },
  universal: { builderFlag: "--universal", outputDir: "mac-universal", hostArchitectures: "arm64,x86_64" },
};
const LEVELS = ["unsigned", "signed", "notarized"];
const SUFFIX = { unsigned: "-UNSIGNED", signed: "-NOT-NOTARIZED", notarized: "" };

// ---------------------------------------------------------------- inputs

function parseArgs(argv) {
  const options = { arch: "arm64", appOnly: false, release: false, dryRun: false, verifyPath: null, expect: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--arch") options.arch = argv[++i];
    else if (arg === "--app-only") options.appOnly = true;
    else if (arg === "--release") options.release = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verify") options.verifyPath = argv[++i];
    else if (arg === "--expect") options.expect = argv[++i];
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!ARCHES[options.arch]) throw new Error(`--arch must be one of: ${Object.keys(ARCHES).join(", ")}`);
  if (options.expect !== null && !LEVELS.includes(options.expect)) throw new Error(`--expect must be one of: ${LEVELS.join(", ")}`);
  if (options.verifyPath === undefined) throw new Error("--verify requires a .pkg path");
  return options;
}

function parseIdentityNames(securityOutput) {
  return [...String(securityOutput || "").matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"([^"]+)"/gm)].map(match => match[1]);
}

function defaultFindIdentities() {
  const result = spawnSync("security", ["find-identity", "-v"], { encoding: "utf8" });
  return result.status === 0 ? parseIdentityNames(result.stdout) : [];
}

function resolveNotaryCredentials(env) {
  if (env.NOTARY_KEYCHAIN_PROFILE) {
    return {
      kind: "keychain-profile",
      args: ["--keychain-profile", env.NOTARY_KEYCHAIN_PROFILE, ...(env.NOTARY_KEYCHAIN ? ["--keychain", env.NOTARY_KEYCHAIN] : [])],
    };
  }
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID) {
    return {
      kind: "api-key",
      args: ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, ...(env.APPLE_API_ISSUER ? ["--issuer", env.APPLE_API_ISSUER] : [])],
    };
  }
  if (env.APPLE_ID && env.APPLE_TEAM_ID && env.APPLE_APP_SPECIFIC_PASSWORD) {
    return {
      kind: "apple-id",
      // "@env:" makes notarytool read the secret from the environment, so it never appears on a command line.
      args: ["--apple-id", env.APPLE_ID, "--team-id", env.APPLE_TEAM_ID, "--password", "@env:APPLE_APP_SPECIFIC_PASSWORD"],
    };
  }
  return null;
}

function resolveSigning({ env = process.env, findIdentities = defaultFindIdentities } = {}) {
  let appIdentity = env.PHONE_FARM_APP_IDENTITY || null;
  let installerIdentity = env.PHONE_FARM_INSTALLER_IDENTITY || null;
  if (!appIdentity || !installerIdentity) {
    const names = findIdentities();
    appIdentity = appIdentity || names.find(name => name.startsWith("Developer ID Application:")) || null;
    installerIdentity = installerIdentity || names.find(name => name.startsWith("Developer ID Installer:")) || null;
  }
  return { appIdentity, installerIdentity, notary: resolveNotaryCredentials(env) };
}

// Decides how much of the signing pipeline runs and whether that is acceptable.
function resolveBuildLevel({ signing, release = false, allowUnsigned = false }) {
  const { appIdentity, installerIdentity, notary } = signing;
  if (Boolean(appIdentity) !== Boolean(installerIdentity)) {
    throw new Error(
      `signing is half-configured: ${appIdentity ? "a Developer ID Application identity was found but no Developer ID Installer identity" : "a Developer ID Installer identity was found but no Developer ID Application identity"}. Provide both, or neither to build an UNSIGNED development package.`,
    );
  }
  let level = "unsigned";
  if (appIdentity && installerIdentity) level = notary ? "notarized" : "signed";
  if (release && level !== "notarized" && !allowUnsigned) {
    throw new Error(
      `a release build must be signed AND notarized (found: ${level}). Configure the Developer ID Application/Installer identities and notarization credentials, or set PHONE_FARM_ALLOW_UNSIGNED=true to publish a clearly-named ${SUFFIX[level].slice(1)} package instead.`,
    );
  }
  return level;
}

function artifactFileName({ version, arch, level }) {
  return `Phone-Farm-${version}-${arch}${SUFFIX[level]}.pkg`;
}

function levelFromFileName(fileName) {
  if (/-UNSIGNED\.pkg$/.test(fileName)) return "unsigned";
  if (/-NOT-NOTARIZED\.pkg$/.test(fileName)) return "signed";
  return "notarized";
}

function computePaths({ arch, version, level, workDir }) {
  const distDir = path.join(desktopDir, "dist");
  return {
    distDir,
    workDir,
    appPath: path.join(distDir, ARCHES[arch].outputDir, APP_BUNDLE),
    appZip: path.join(workDir, "Phone-Farm-app.zip"),
    stageRoot: path.join(workDir, "root"),
    componentPkg: path.join(workDir, "component.pkg"),
    distributionXml: path.join(workDir, "distribution.xml"),
    resourcesDir: path.join(desktopDir, "build", "pkg", "resources"),
    componentsPlist: path.join(desktopDir, "build", "pkg", "components.plist"),
    outPkg: path.join(distDir, artifactFileName({ version, arch, level })),
    expandedDir: path.join(workDir, "expanded"),
  };
}

function renderDistribution({ version, hostArchitectures }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>${PRODUCT_NAME}</title>
    <welcome file="welcome.html" mime-type="text/html"/>
    <readme file="readme.html" mime-type="text/html"/>
    <conclusion file="conclusion.html" mime-type="text/html"/>
    <options customize="never" require-scripts="false" hostArchitectures="${hostArchitectures}"/>
    <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
    <volume-check>
        <allowed-os-versions>
            <os-version min="${MIN_MACOS}"/>
        </allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="phonefarm"/>
    </choices-outline>
    <choice id="phonefarm" visible="false" title="${PRODUCT_NAME}" description="Installs ${PRODUCT_NAME}.app into Applications.">
        <pkg-ref id="${COMPONENT_ID}"/>
    </choice>
    <pkg-ref id="${COMPONENT_ID}" version="${version}" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
`;
}

// ------------------------------------------------------------------ plan

function command(id, description, cmd, args, extra = {}) {
  return { id, description, cmd, args, ...extra };
}

function action(id, description, name, params = {}) {
  return { id, description, action: name, params };
}

function stripIdentityPrefix(identity) {
  return identity.replace(/^Developer ID Application:\s*/, "");
}

// Pure: returns the ordered steps for a build. Executed by runPlan(); unit-tested
// without a Mac.
function planBuild({ arch, version, level, signing, appOnly = false, paths, nodeBin = process.execPath }) {
  const notarize = level === "notarized";
  const signed = level !== "unsigned";
  const notaryArgs = signing.notary?.args ?? [];
  const steps = [
    command("ensure-electron", "Ensure the Electron binary is installed", nodeBin, ["scripts/ensure-electron.cjs"]),
    command("prepare-runtime", "Stage the production server runtime and web client", nodeBin, ["scripts/prepare-runtime.cjs"]),
    command("prepare-wda", "Stage the pinned, unmodified WebDriverAgent", nodeBin, ["scripts/prepare-wda.cjs"]),
    command("build-app", `Build ${APP_BUNDLE} (${arch}) with electron-builder`, "npx",
      ["--no-install", "electron-builder", "--mac", "dir", ARCHES[arch].builderFlag, "--publish", "never"],
      { env: signed
        ? { CSC_NAME: stripIdentityPrefix(signing.appIdentity), CSC_IDENTITY_AUTO_DISCOVERY: "true" }
        : { CSC_IDENTITY_AUTO_DISCOVERY: "false" } }),
  ];

  if (signed) {
    steps.push(command("verify-app-signature", "Verify the app's Developer ID signature", "codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", paths.appPath]));
  } else {
    steps.push(command("adhoc-sign-app", "Ad-hoc sign the app (development only; Apple silicon refuses unsigned code)", "codesign",
      ["--force", "--deep", "--sign", "-", paths.appPath]));
  }

  if (notarize) {
    steps.push(
      command("zip-app", "Zip the app for notarization", "ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", paths.appPath, paths.appZip]),
      command("notarize-app", "Notarize the app with Apple", "xcrun", ["notarytool", "submit", paths.appZip, ...notaryArgs, "--wait", "--timeout", "45m"]),
      command("staple-app", "Staple the notarization ticket to the app", "xcrun", ["stapler", "staple", paths.appPath]),
      command("validate-app-ticket", "Validate the app's stapled ticket", "xcrun", ["stapler", "validate", paths.appPath]),
    );
  }
  if (appOnly) return steps;

  steps.push(
    action("stage-pkg-root", "Stage the installer payload", "stage-pkg-root", { stageRoot: paths.stageRoot }),
    command("copy-app", "Copy the finished app into the payload", "ditto", [paths.appPath, path.join(paths.stageRoot, APP_BUNDLE)]),
    command("pkgbuild", "Build the component package (installs to /Applications, never relocatable)", "pkgbuild", [
      "--root", paths.stageRoot,
      "--component-plist", paths.componentsPlist,
      "--identifier", COMPONENT_ID,
      "--version", version,
      "--install-location", "/Applications",
      "--ownership", "recommended",
      paths.componentPkg,
    ]),
    action("write-distribution", "Write the installer wizard definition", "write-distribution",
      { file: paths.distributionXml, version, hostArchitectures: ARCHES[arch].hostArchitectures }),
    command("productbuild", `Build the installer package ${path.basename(paths.outPkg)}`, "productbuild", [
      "--distribution", paths.distributionXml,
      "--resources", paths.resourcesDir,
      "--package-path", paths.workDir,
      ...(signed ? ["--sign", signing.installerIdentity, "--timestamp"] : []),
      paths.outPkg,
    ]),
  );
  if (notarize) {
    steps.push(
      command("notarize-pkg", "Notarize the installer package with Apple", "xcrun", ["notarytool", "submit", paths.outPkg, ...notaryArgs, "--wait", "--timeout", "45m"]),
      command("staple-pkg", "Staple the notarization ticket to the package", "xcrun", ["stapler", "staple", paths.outPkg]),
    );
  }
  steps.push(...planVerification({ arch, version, level, paths }));
  return steps;
}

function planVerification({ arch, version, level, paths }) {
  const steps = [];
  if (level !== "unsigned") {
    steps.push(command("verify-pkg-signature", "Check the installer's Developer ID Installer signature", "pkgutil", ["--check-signature", paths.outPkg], { expectOutput: /Developer ID Installer/ }));
  }
  if (level === "notarized") {
    steps.push(
      command("validate-pkg-ticket", "Validate the installer's stapled notarization ticket", "xcrun", ["stapler", "validate", paths.outPkg]),
      command("assess-pkg", "Gatekeeper assessment of the installer", "spctl", ["--assess", "--type", "install", "-vv", paths.outPkg]),
    );
  }
  steps.push(
    command("expand-pkg", "Expand the package to inspect exactly what it installs", "pkgutil", ["--expand-full", paths.outPkg, paths.expandedDir]),
    action("verify-expanded-pkg", "Verify payload, install location, dependencies, bundled WDA and a real server boot", "verify-expanded-pkg",
      { expandedDir: paths.expandedDir, version, arch, level }),
  );
  return steps;
}

// ------------------------------------------------------------- inspection

function findApp(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name === APP_BUNDLE) return target;
      if (entry.isDirectory()) stack.push(target);
    }
  }
  return null;
}

function findFile(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.name === name) return target;
    }
  }
  return null;
}

// Verifies an `pkgutil --expand-full` tree. Static checks work anywhere; the
// server boot needs the app's own executable to run (macOS).
async function inspectExpandedPkg({ expandedDir, version, arch, level, boot = process.platform === "darwin", nodeExecutable = null }) {
  const failures = [];
  const app = findApp(expandedDir);
  if (!app) return [`the package does not contain ${APP_BUNDLE}`];
  const info = fs.existsSync(path.join(app, "Contents", "Info.plist")) ? fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8") : "";
  const bundleVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(info)?.[1];
  if (bundleVersion !== version) failures.push(`Info.plist version is ${bundleVersion ?? "missing"}, expected ${version}`);
  const bundleId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(info)?.[1];
  if (bundleId !== COMPONENT_ID) failures.push(`CFBundleIdentifier is ${bundleId ?? "missing"}, expected ${COMPONENT_ID}`);

  const packageInfo = findFile(expandedDir, "PackageInfo");
  const installLocation = packageInfo ? /install-location="([^"]*)"/.exec(fs.readFileSync(packageInfo, "utf8"))?.[1] : undefined;
  if (installLocation !== "/Applications") failures.push(`install-location is ${installLocation ?? "missing"}, expected /Applications`);

  const distribution = findFile(expandedDir, "Distribution");
  const distributionText = distribution ? fs.readFileSync(distribution, "utf8") : "";
  if (!distributionText.includes(`hostArchitectures="${ARCHES[arch].hostArchitectures}"`)) {
    failures.push(`the installer wizard does not restrict hostArchitectures to ${ARCHES[arch].hostArchitectures}`);
  }
  for (const page of ["welcome", "readme", "conclusion"]) {
    if (!distributionText.includes(`<${page} `)) failures.push(`the installer wizard has no ${page} page`);
  }

  const executable = nodeExecutable || path.join(app, "Contents", "MacOS", PRODUCT_NAME);
  failures.push(...await verifyPackagedRuntime(path.join(app, "Contents", "Resources"), {
    nodeExecutable: executable,
    boot,
    requireWda: true,
  }));
  return failures;
}

// -------------------------------------------------------------- execution

function displayCommand(step) {
  return [step.cmd, ...step.args].map(value => /[\s"]/.test(value) ? JSON.stringify(value) : value).join(" ");
}

async function runAction(step, context) {
  const { params } = step;
  if (step.action === "stage-pkg-root") {
    fs.rmSync(params.stageRoot, { recursive: true, force: true });
    fs.mkdirSync(params.stageRoot, { recursive: true });
  } else if (step.action === "write-distribution") {
    fs.writeFileSync(params.file, renderDistribution(params));
  } else if (step.action === "verify-expanded-pkg") {
    const failures = await inspectExpandedPkg(params);
    if (params.level !== "unsigned") {
      const app = findApp(params.expandedDir);
      const signature = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { encoding: "utf8" });
      if (signature.status !== 0) failures.push(`codesign rejected the installed app: ${(signature.stderr || "").trim()}`);
    }
    if (params.level === "notarized") {
      const app = findApp(params.expandedDir);
      const assess = spawnSync("spctl", ["--assess", "--type", "execute", "-vv", app], { encoding: "utf8" });
      if (assess.status !== 0) failures.push(`spctl rejected the installed app: ${(assess.stderr || "").trim()}`);
      const ticket = spawnSync("xcrun", ["stapler", "validate", app], { encoding: "utf8" });
      if (ticket.status !== 0) failures.push(`the installed app has no valid stapled ticket: ${(ticket.stdout || ticket.stderr || "").trim()}`);
    }
    if (failures.length) throw new Error(`package verification failed:\n - ${failures.join("\n - ")}`);
  }
  return context;
}

async function runPlan(steps, { dryRun = false, log = console.log, env = process.env } = {}) {
  for (const step of steps) {
    log(`\n[${step.id}] ${step.description}`);
    if (step.cmd) log(`  ${displayCommand(step)}`);
    if (dryRun) continue;
    if (step.action) {
      await runAction(step, {});
      continue;
    }
    const result = spawnSync(step.cmd, step.args, {
      cwd: desktopDir,
      env: { ...env, ...(step.env || {}) },
      stdio: step.expectOutput ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (result.error) throw new Error(`${step.id}: could not start ${step.cmd} (${result.error.code || result.error.message})`);
    if (step.expectOutput) {
      process.stdout.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
      if (!step.expectOutput.test(`${result.stdout}${result.stderr}`)) throw new Error(`${step.id}: output did not match ${step.expectOutput}`);
    }
    if (result.status !== 0) throw new Error(`${step.id} failed with exit code ${result.status}`);
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const version = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8")).version;
  if (process.platform !== "darwin" && !options.dryRun) {
    throw new Error("the macOS installer can only be built on macOS (electron-builder, codesign, pkgbuild and productbuild are macOS tools). Use the GitHub Actions workflow, or --dry-run to see the plan.");
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-pkg-"));
  try {
    if (options.verifyPath) {
      const level = options.expect || levelFromFileName(path.basename(options.verifyPath));
      const paths = { ...computePaths({ arch: options.arch, version, level, workDir }), outPkg: path.resolve(options.verifyPath) };
      await runPlan(planVerification({ arch: options.arch, version, level, paths }), { dryRun: options.dryRun, env });
      console.log(`\nVERIFIED (${level}): ${paths.outPkg}`);
      return;
    }
    const signing = resolveSigning({ env });
    const release = options.release || env.PHONE_FARM_RELEASE === "true";
    const level = resolveBuildLevel({ signing, release, allowUnsigned: env.PHONE_FARM_ALLOW_UNSIGNED === "true" });
    const paths = computePaths({ arch: options.arch, version, level, workDir });
    console.log(`Phone Farm ${version} (${options.arch}) - signing level: ${level.toUpperCase()}`);
    if (level !== "notarized") {
      console.log("WARNING: this package is NOT signed and notarized. macOS Gatekeeper will warn (or refuse) when it is opened. It is a development artifact, not the seamless public installer.");
    }
    await runPlan(planBuild({ arch: options.arch, version, level, signing, appOnly: options.appOnly, paths }), { dryRun: options.dryRun, env });
    if (options.appOnly) {
      console.log(`\nApp ready: ${paths.appPath}`);
    } else {
      console.log(`\nInstaller ready: ${paths.outPkg}`);
      console.log(`PKG_PATH=${paths.outPkg}`);
      if (env.GITHUB_OUTPUT && !options.dryRun) fs.appendFileSync(env.GITHUB_OUTPUT, `pkg_path=${paths.outPkg}\nsigning_level=${level}\n`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`\nInstaller build stopped: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ARCHES,
  COMPONENT_ID,
  artifactFileName,
  computePaths,
  inspectExpandedPkg,
  levelFromFileName,
  parseArgs,
  parseIdentityNames,
  planBuild,
  planVerification,
  renderDistribution,
  resolveBuildLevel,
  resolveNotaryCredentials,
  resolveSigning,
};
