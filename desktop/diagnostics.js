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
  [/((?:secret|token|password|passwd|pass|smtp[_-]?pass|api[_-]?key|master[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1[hidden]"],
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

// "a1b2c3d, built 2026-10-07" for an installed build; a development run has no build record.
function describeBuild(build) {
  if (!build) return "development build";
  const built = build.builtAt ? `, built ${String(build.builtAt).slice(0, 10)}` : "";
  return build.commit && build.commit !== "unknown" ? `${build.commit}${built}` : `unknown commit${built}`;
}

// Reads the record the installer left beside the server, or null when there is none (a development run).
function readBuildRecord(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof raw?.commit === "string" ? { commit: raw.commit, builtAt: typeof raw.builtAt === "string" ? raw.builtAt : null } : null;
  } catch {
    return null;
  }
}

// What automatic phone setup is doing, as reported by the Bodun server in a small status file in Bodun's own storage. It names
// the record file and its folder, never a full path. `current` says whether the process that wrote it is still running.
function describeAutomaticSetup(setup) {
  if (!setup) return ["Automatic phone setup: no report yet (setup is off, or Bodun has not started it)"];
  const lines = [`Automatic phone setup: ${setup.state} (${setup.code})`, `  ${setup.message}`];
  if (setup.recordFile) lines.push(`  Record file: ${setup.recordFile}, in the folder ${setup.folder ?? "Bodun's storage"}`);
  lines.push(setup.current
    ? `  (reported by the running Bodun server at ${setup.writtenAt})`
    : `  (last reported at ${setup.writtenAt}; the server is not running)`);
  return lines;
}

// Reads the status file; only the fields that belong in a report are kept. `runningPids` are the processes this app is running,
// so a file written by a process that is gone is recognised. null when there is no usable file.
function readSetupStatusFile(file, runningPids = []) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof raw?.state !== "string" || typeof raw?.code !== "string" || typeof raw?.message !== "string") return null;
    return {
      state: raw.state, code: raw.code, message: raw.message,
      recordFile: typeof raw.recordFile === "string" ? raw.recordFile : null, folder: typeof raw.folder === "string" ? raw.folder : null,
      pid: Number.isSafeInteger(raw.pid) ? raw.pid : null, writtenAt: typeof raw.writtenAt === "string" ? raw.writtenAt : "an unknown time",
      current: Number.isSafeInteger(raw.pid) && runningPids.includes(raw.pid),
    };
  } catch {
    return null;
  }
}

function buildDiagnosticsReport({
  appVersion, build, electronVersion, nodeVersion, mode, preflight, config, wda, tools = {}, serverState, agentState, logLines = [], logFile,
  automaticSetup = null, processRecords = null,
  platform = process.platform, arch = process.arch, osRelease = os.release(), now = new Date(),
} = {}) {
  const lines = [
    "Bodun diagnostics",
    `Created: ${now.toISOString()}`,
    `App version: ${appVersion ?? "unknown"} (Electron ${electronVersion ?? "?"}, Node ${nodeVersion ?? "?"})`,
    `Build: ${describeBuild(build)}`,
    `System: ${platform} ${arch}, release ${osRelease}`,
    `Mode: ${mode ?? "not chosen yet"}`,
    `Server: ${serverState ?? "not running"}`,
    ...(agentState ? [`Site agent: ${agentState}`] : []),
    ...describeAutomaticSetup(automaticSetup),
    ...(processRecords ? [`Process record of Bodun's own server and site agent: ${processRecords}`] : []),
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

module.exports = { buildDiagnosticsReport, createLogger, describeAutomaticSetup, describeBuild, describeConfig, readBuildRecord, readSetupStatusFile, redact };
