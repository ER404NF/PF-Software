// npm can install the electron package without running its postinstall
// (locked-down npm configs, `--ignore-scripts`, "allow-scripts" policies), which
// leaves no Electron binary and makes every later build fail obscurely. This
// runs Electron's own downloader if - and only if - the binary is missing.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const electronDir = path.resolve(__dirname, "..", "node_modules", "electron");

function electronBinaryPresent() {
  return fs.existsSync(path.join(electronDir, "path.txt")) && fs.existsSync(path.join(electronDir, "dist"));
}

function ensureElectron() {
  if (!fs.existsSync(path.join(electronDir, "install.js"))) {
    throw new Error("electron is not installed; run npm ci in desktop/ first");
  }
  if (electronBinaryPresent()) return false;
  console.log("Electron binary missing; running electron's install script...");
  const result = spawnSync(process.execPath, [path.join(electronDir, "install.js")], { cwd: electronDir, stdio: "inherit" });
  if (result.status !== 0 || !electronBinaryPresent()) throw new Error("could not download the Electron binary");
  return true;
}

if (require.main === module) {
  try {
    ensureElectron();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { ensureElectron, electronBinaryPresent };
