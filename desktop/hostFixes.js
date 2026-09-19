// One-click fixes for the two host prerequisites a non-technical person cannot be expected to fix
// in Terminal:
//
//   "xcode"     Full Xcode is installed but macOS still points at the Command Line Tools, or its licence /
//               first-launch components were never finished. Fixed with the standard macOS administrator
//               password dialog (the same one System Settings uses) - no Terminal, no sudo typed by anyone.
//   "ios-tools" libimobiledevice / libusbmuxd (idevice_id, ideviceinfo, iproxy) are not installed. Installed
//               through Homebrew when Homebrew is already on this Mac.
//
// Nothing here takes user-supplied text: the only inputs are the fix id (checked against an allow-list) and
// paths this module reads from the disk itself. Every command is run without a shell.

const fs = require("fs");
const { spawn, execFile } = require("child_process");

const HOMEBREW_CANDIDATES = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
const XCODE_DEVELOPER_DIR = /^\/Applications\/[A-Za-z0-9][A-Za-z0-9 ._-]*\.app\/Contents\/Developer$/;
const FIXES = Object.freeze(["xcode", "ios-tools"]);
const BREW_FORMULAE = Object.freeze(["libimobiledevice", "libusbmuxd"]);

function findHomebrew({ existsSync = fs.existsSync } = {}) {
  return HOMEBREW_CANDIDATES.find(candidate => existsSync(candidate)) ?? null;
}

// Xcode.app first, then other Xcode*.app folders (a beta is the last resort). Returns the path xcode-select needs.
function findXcodeDeveloperDir({ readdirSync = fs.readdirSync, existsSync = fs.existsSync } = {}) {
  let names = [];
  try { names = readdirSync("/Applications"); } catch { return null; }
  const candidates = names
    .filter(name => /^Xcode[A-Za-z0-9 ._-]*\.app$/.test(name))
    .sort((a, b) => {
      const rank = name => (name === "Xcode.app" ? 0 : /beta/i.test(name) ? 2 : 1);
      return rank(a) - rank(b) || a.localeCompare(b);
    })
    .map(name => `/Applications/${name}/Contents/Developer`)
    .filter(dir => XCODE_DEVELOPER_DIR.test(dir) && existsSync(dir));
  return candidates[0] ?? null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Select Xcode, accept its licence and finish its first-launch install in one administrator prompt.
// A failed first-launch step must not hide a successful selection, so it is allowed to fail.
function buildXcodeAdminScript(developerDir) {
  if (!XCODE_DEVELOPER_DIR.test(developerDir)) throw new Error("refusing an unexpected Xcode location");
  const commands = [
    `/usr/bin/xcode-select -s ${shellQuote(developerDir)}`,
    "/usr/bin/xcodebuild -license accept",
    "(/usr/bin/xcodebuild -runFirstLaunch || true)",
  ].join(" && ");
  return `do shell script ${appleScriptString(commands)} with administrator privileges`;
}

function friendlyAdminError(error) {
  const text = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
  if (/-128|User canceled|user cancelled/i.test(text)) return "The password prompt was cancelled. Click Fix it again when you are ready.";
  if (/-60007|-1743|not allowed/i.test(text)) return "macOS did not allow the request. Open System Settings > Privacy & Security and allow Phone Farm to control this Mac, then try again.";
  const last = String(error?.stderr || error?.message || "").trim().split(/\r?\n/).filter(Boolean).pop();
  return last ? `macOS reported: ${last}` : "macOS could not finish the change.";
}

function fixXcode({ execFileImpl = execFile, readdirSync, existsSync, onOutput = () => {} } = {}) {
  const developerDir = findXcodeDeveloperDir({ readdirSync, existsSync });
  if (!developerDir) {
    return Promise.resolve({ ok: false, message: "Xcode was not found in Applications. Install Xcode from the App Store first, then click Check again." });
  }
  onOutput(`Selecting ${developerDir} and finishing Xcode's first-time setup. macOS will ask for your Mac password.`);
  return new Promise(resolve => {
    execFileImpl("/usr/bin/osascript", ["-e", buildXcodeAdminScript(developerDir)],
      { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return resolve({ ok: false, message: friendlyAdminError({ ...error, stderr }) });
        onOutput("Xcode is ready.");
        resolve({ ok: true, message: "Xcode is ready." });
      });
  });
}

function fixIosTools({ spawnImpl = spawn, existsSync, env = process.env, onOutput = () => {} } = {}) {
  const brew = findHomebrew({ existsSync });
  if (!brew) {
    return Promise.resolve({
      ok: false,
      message: "Homebrew is not installed on this Mac. Install it from https://brew.sh (it is free), then click Check again.",
    });
  }
  onOutput(`Installing ${BREW_FORMULAE.join(" and ")} with Homebrew. This can take a few minutes.`);
  return new Promise(resolve => {
    const child = spawnImpl(brew, ["install", ...BREW_FORMULAE], {
      env: {
        ...env,
        PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
        HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_ENV_HINTS: "1", NONINTERACTIVE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const relay = chunk => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail = line.trim();
        onOutput(tail);
      }
    };
    child.stdout?.on("data", relay);
    child.stderr?.on("data", relay);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 25 * 60_000);
    child.on("error", error => { clearTimeout(timer); resolve({ ok: false, message: `Could not start Homebrew: ${error.message}` }); });
    child.on("close", code => {
      clearTimeout(timer);
      resolve(code === 0
        ? { ok: true, message: "The iPhone tools are installed." }
        : { ok: false, message: `Homebrew could not install the iPhone tools (exit ${code}${tail ? `: ${tail}` : ""}).` });
    });
  });
}

// One fix at a time: two Homebrew installs, or two password prompts, at once would only fight each other.
let running = null;

async function applyFix(id, options = {}) {
  if (!FIXES.includes(id)) return { ok: false, message: "That fix is not available." };
  if ((options.platform ?? process.platform) !== "darwin") return { ok: false, message: "These fixes only apply on a Mac." };
  if (running) return { ok: false, message: "Another fix is still running. Wait for it to finish." };
  running = id;
  try {
    return id === "xcode" ? await fixXcode(options) : await fixIosTools(options);
  } finally {
    running = null;
  }
}

module.exports = {
  BREW_FORMULAE,
  FIXES,
  XCODE_DEVELOPER_DIR,
  applyFix,
  buildXcodeAdminScript,
  findHomebrew,
  findXcodeDeveloperDir,
  friendlyAdminError,
};
