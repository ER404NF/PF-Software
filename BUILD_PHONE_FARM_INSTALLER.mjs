#!/usr/bin/env node

// ============================================================================
//  DEVELOPER TOOL - NOT THE PHONE FARM INSTALLER
// ============================================================================
//  This script BUILDS the installer from a source checkout. It is for the people
//  who develop Phone Farm. Ordinary users must never run it: they download the
//  ready-made  Phone-Farm-<version>-arm64.pkg  from the GitHub Releases page and
//  double-click it (no Node.js, npm, Terminal or source code needed).
//
//  What it does, on the developer's machine:
//    1. npm ci        (server + desktop, exact lockfile versions)
//    2. server tests, desktop tests  (release builds are gated on these in CI too)
//    3. macOS:   desktop `npm run dist:mac:pkg`  -> desktop/dist/Phone-Farm-<version>-arm64[-UNSIGNED].pkg
//       Windows: desktop `npm run dist:win`      -> desktop/dist/*.exe (development only)
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const systemDir = path.join(repoRoot, "system");
const desktopDir = path.join(repoRoot, "desktop");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipTests = args.has("--skip-tests");

function usage() {
  console.log(`DEVELOPER TOOL - NOT THE PHONE FARM INSTALLER

Builds the Phone Farm installer from this source checkout.
Ordinary users download the finished .pkg from GitHub Releases instead.

Usage:
  node BUILD_PHONE_FARM_INSTALLER.mjs [--dry-run] [--skip-tests]

Options:
  --dry-run      Show every command without running it.
  --skip-tests   Skip the server and desktop test suites. Only for repeated local
                 rebuilds of an already-tested revision - NEVER for a release.
  --help         Show this help.

Output: desktop/dist/. A local build is UNSIGNED unless Apple signing and
notarization credentials are configured (see docs/MAC_RELEASE.md); an unsigned
package triggers Gatekeeper warnings and is not the public installer.`);
}

function fail(message) {
  console.error(`\nInstaller builder stopped: ${message}`);
  process.exit(1);
}

function displayCommand(command, commandArgs) {
  return [command, ...commandArgs].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}

function run(command, commandArgs, cwd, label) {
  console.log(`\n[${label}]`);
  console.log(`  ${displayCommand(command, commandArgs)}`);
  console.log(`  in ${path.relative(repoRoot, cwd) || "."}`);
  if (dryRun) return;
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: process.env,
    stdio: "inherit",
    // Windows npm is a trusted npm.cmd shim and cannot be spawned directly by
    // current Node releases (EINVAL). Every command/argument passed here is a
    // fixed literal from this file; CLI input only selects booleans.
    shell: process.platform === "win32",
  });
  if (result.error) fail(`${label} could not start (${result.error.code || result.error.name}).`);
  if (result.status !== 0) {
    if (label === "Build Phone Farm installer" && process.platform === "win32") {
      console.error("Windows note: if electron-builder reported 'Cannot create symbolic link', enable Windows Developer Mode or run the build from an elevated terminal.");
    }
    fail(`${label} failed with exit code ${result.status}.`);
  }
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) fail(`required repository file is missing: ${path.relative(repoRoot, filePath)}`);
}

if (args.has("--help")) {
  usage();
  process.exit(0);
}
for (const argument of args) {
  if (!new Set(["--dry-run", "--skip-tests"]).has(argument)) fail(`unknown option: ${argument}`);
}

if (!new Set(["darwin", "win32"]).has(process.platform) && !dryRun) {
  fail("installer builds are supported on macOS and Windows only");
}
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 20) {
  fail(`Node.js 20 or newer is required (found ${process.versions.node})`);
}

requireFile(path.join(systemDir, "package.json"));
requireFile(path.join(systemDir, "package-lock.json"));
requireFile(path.join(desktopDir, "package.json"));
requireFile(path.join(desktopDir, "package-lock.json"));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const buildScript = process.platform === "darwin" ? "dist:mac:pkg" : "dist:win";

console.log("DEVELOPER TOOL - NOT THE PHONE FARM INSTALLER");
console.log("(ordinary users download the finished .pkg from GitHub Releases and double-click it)\n");
console.log(`Repository: ${repoRoot}`);
console.log(`Target: ${process.platform === "darwin" ? "macOS .pkg installer" : "Windows installer (development only)"}`);
if (skipTests) console.log("WARNING: --skip-tests was given. Do not publish anything built this way.");

run(npm, ["ci"], systemDir, "Install server dependencies");
run(npm, ["ci"], desktopDir, "Install desktop-builder dependencies");
if (!skipTests) {
  run(npm, ["test"], systemDir, "Run complete server test suite");
  run(npm, ["test"], desktopDir, "Run desktop tests");
}
run(npm, ["run", buildScript], desktopDir, "Build Phone Farm installer");

if (dryRun) {
  console.log("\nDry run complete. Nothing was installed or built.");
  process.exit(0);
}

const distDir = path.join(desktopDir, "dist");
const extension = process.platform === "darwin" ? ".pkg" : ".exe";
const installers = fs.existsSync(distDir)
  ? fs.readdirSync(distDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map(entry => path.join(distDir, entry.name))
  : [];
if (installers.length === 0) fail(`packaging finished but no ${extension} installer was found in desktop/dist`);

console.log("\nDone. Installer built:");
for (const installer of installers) console.log(`  ${installer}`);
if (installers.some(installer => /UNSIGNED|NOT-NOTARIZED/.test(installer)) || process.platform !== "darwin") {
  console.log("\nThis build is not signed and notarized: the operating system will show a security warning. It is a development artifact, not the public installer.");
}
