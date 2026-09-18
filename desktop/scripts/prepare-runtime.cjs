const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const desktopDir = path.resolve(__dirname, "..");
const systemDir = path.resolve(desktopDir, "..", "system");

function verifyRuntime() {
  const required = [
    path.join(systemDir, "server", "src", "index.js"),
    path.join(systemDir, "client", "index.html"),
    path.join(systemDir, "node_modules", "express", "package.json"),
    path.join(systemDir, "node_modules", "express-session", "package.json"),
    path.join(systemDir, "node_modules", "multer", "package.json"),
    path.join(systemDir, "node_modules", "nodemailer", "package.json"),
    path.join(systemDir, "node_modules", "ws", "package.json"),
  ];
  const missing = required.filter(file => !fs.existsSync(file));
  if (missing.length) throw new Error(`Packaged server runtime is incomplete:\n${missing.join("\n")}`);
  return required;
}

function installRuntime() {
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd", "ci", "--omit=dev"]
    : ["ci", "--omit=dev"];
  const result = spawnSync(command, args, {
    cwd: systemDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`system npm ci --omit=dev failed with exit code ${result.status}`);
}

if (require.main === module) {
  try {
    installRuntime();
    verifyRuntime();
    console.log("Phone Farm server runtime is ready for packaging.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { installRuntime, verifyRuntime };
