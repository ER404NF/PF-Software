// Log file and diagnostics report. The app is launched from Finder, so console output goes nowhere; this keeps a
// small rotating log in the user's Application Support folder and can produce a plain-text report to send to
// whoever is helping. Secrets are never written: known token shapes are scrubbed from every line, and the
// report only ever lists which settings exist, not their values.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SECRET_PATTERNS = [
  [/\bpfs_[A-Za-z0-9_-]{8,}/g, "pfs_[hidden]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [hidden]"],
  [/((?:secret|token|password|passwd|api[_-]?key|master[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1[hidden]"],
  [/\b[0-9a-f]{64}\b/gi, "[hidden]"],
];

function redact(text) {
  return SECRET_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text));
}

function createLogger({ dir, maxBytes = 2 * 1024 * 1024, keep = 2, now = () => new Date() } = {}) {
  if (!dir) throw new TypeError("a log directory is required");
  const file = path.join(dir, "phone-farm.log");
  let ready = false;

  function ensure() {
    if (ready) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      ready = true;
    } catch {
      /* logging must never take the app down */
    }
    return ready;
  }

  function rotate() {
    try {
      if (fs.statSync(file).size < maxBytes) return;
    } catch {
      return;
    }
    for (let index = keep - 1; index >= 1; index -= 1) {
      try { fs.renameSync(index === 1 ? file : `${file}.${index - 1}`, `${file}.${index}`); } catch { /* nothing to rotate */ }
    }
  }

  function write(level, message) {
    if (!ensure()) return;
    const line = `${now().toISOString()} ${level.padEnd(5)} ${redact(message).replace(/\r?\n/g, "\n  ")}\n`;
    try {
      rotate();
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }

  return {
    file,
    info: message => write("INFO", message),
    warn: message => write("WARN", message),
    error: message => write("ERROR", message),
    tail(lines = 200) {
      try {
        return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-lines);
      } catch {
        return [];
      }
    },
  };
}

function describeChecks(preflight) {
  if (!preflight?.checks) return ["  (not checked yet)"];
  return preflight.checks.map(check => `  [${check.ok ? "ok" : check.optional ? "n/a" : "PROBLEM"}] ${check.label || check.id}: ${check.message || ""}`);
}

// Names of settings that exist, never their values.
function describeConfig(config) {
  if (!config) return "none saved yet";
  const keys = Object.keys(config).filter(key => config[key] !== undefined).sort();
  return keys.length ? keys.join(", ") : "empty";
}

function buildDiagnosticsReport({
  appVersion, electronVersion, nodeVersion, mode, preflight, config, wda, tools = {}, serverState, agentState, logLines = [], logFile,
  platform = process.platform, arch = process.arch, osRelease = os.release(), now = new Date(),
} = {}) {
  const lines = [
    "Phone Farm diagnostics",
    `Created: ${now.toISOString()}`,
    `App version: ${appVersion ?? "unknown"} (Electron ${electronVersion ?? "?"}, Node ${nodeVersion ?? "?"})`,
    `System: ${platform} ${arch}, release ${osRelease}`,
    `Mode: ${mode ?? "not chosen yet"}`,
    `Server: ${serverState ?? "not running"}`,
    ...(agentState ? [`Site agent: ${agentState}`] : []),
    `Saved settings: ${describeConfig(config)}`,
    "",
    "Prerequisites:",
    ...describeChecks(preflight),
    "",
    `WebDriverAgent: ${wda ? `${wda.source ?? "?"} at ${wda.path ?? "?"}` : "not found"}`,
    "Tools:",
    ...Object.entries(tools).map(([name, location]) => `  ${name}: ${location || "not found"}`),
    "",
    `Log file: ${logFile ?? "n/a"}`,
    "Recent log:",
    ...(logLines.length ? logLines.map(line => `  ${redact(line)}`) : ["  (empty)"]),
    "",
  ];
  return lines.join("\n");
}

module.exports = { buildDiagnosticsReport, createLogger, describeConfig, redact };
