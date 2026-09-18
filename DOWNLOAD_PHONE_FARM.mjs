#!/usr/bin/env node

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
  console.log(`Phone Farm downloader and installer builder

Usage:
  node DOWNLOAD_PHONE_FARM.mjs [--dry-run] [--skip-tests]

Options:
  --dry-run      Show every command without downloading or building.
  --skip-tests   Skip the complete server test suite before packaging.
  --help         Show this help.

The generated installer is written under desktop/dist/. No credentials,
operator accounts, device configuration, or runtime storage are downloaded.`);
}

function fail(message) {
  console.error(`\nDownloader stopped: ${message}`);
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
    // Windows npm is a trusted npm.cmd shim and cannot be spawned directly
    // by current Node releases (EINVAL). Every command/argument passed here
    // is a fixed literal from this file; CLI input only selects booleans.
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
const buildScript = process.platform === "darwin" ? "dist:mac" : "dist:win";

console.log("Phone Farm downloader");
console.log(`Repository: ${repoRoot}`);
console.log(`Target: ${process.platform === "darwin" ? "macOS DMG" : "Windows installer"}`);
console.log("This uses the committed lock files and does not download local configuration or secrets.");

run(npm, ["ci"], systemDir, "Download server dependencies");
run(npm, ["ci"], desktopDir, "Download desktop-builder dependencies");
if (!skipTests) run(npm, ["test"], systemDir, "Run complete server test suite");
run(npm, ["run", buildScript], desktopDir, "Build Phone Farm installer");

if (dryRun) {
  console.log("\nDry run complete. No files were downloaded or built.");
  process.exit(0);
}

const distDir = path.join(desktopDir, "dist");
const extension = process.platform === "darwin" ? ".dmg" : ".exe";
const installers = fs.existsSync(distDir)
  ? fs.readdirSync(distDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map(entry => path.join(distDir, entry.name))
  : [];
if (installers.length === 0) fail(`packaging finished but no ${extension} installer was found in desktop/dist`);

console.log("\nDone. Installer ready:");
for (const installer of installers) console.log(`  ${installer}`);
console.log("\nUnsigned local builds can trigger an operating-system security warning. Signing and notarization require separate credentials.");
