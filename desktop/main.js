// Phone Farm desktop wrapper. Local setup is intentionally isolated from
// server/client web content: only the packaged first-run page receives the
// privileged preload API. The normal Phone Farm window has no preload.

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, powerSaveBlocker, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const { buildHostEnvironment, resolveMacHostDependencies } = require("./hostEnvironment");
const {
  agentEntryPath, parseAgentStatus, siteAgentEnvironment, validateSiteSettings,
} = require("./siteAgentConfig");
const {
  detectDevelopmentTeams,
  ensureManagedWdaSource,
  isValidTeamId,
  resolveWdaDevelopmentTeam,
} = require("./wdaSource");
const {
  appWebPreferences,
  isAllowedAppNavigation,
  isAllowedSetupNavigation,
  isTrustedSetupSender,
  normalizedOrigin,
  setupWebPreferences,
} = require("./windowSecurity");
const { applyFix } = require("./hostFixes");
const { createRestartPolicy, findFreePort } = require("./serverSupervisor");
const { buildDiagnosticsReport, createLogger } = require("./diagnostics");

// The app is opened from Finder, so console output is invisible. Everything worth knowing goes to a rotating
// log file (~/Library/Logs/Phone Farm on a Mac) that "Help > Copy Diagnostics" can hand to whoever is helping.
const logger = createLogger({ dir: app.getPath("logs") });
process.on("uncaughtExceptionMonitor", error => logger.error(`uncaught exception: ${error?.stack || error}`));

const configPath = path.join(app.getPath("userData"), "desktop-config.json");
const storageRoot = path.join(app.getPath("userData"), "host-storage");
const setupFilePath = path.join(__dirname, "first-run.html");

let setupWindow = null;
let appWindow = null;
let serverProcess = null;
let agentProcess = null;
let agentStatus = { state: "stopped", detail: "" };
let activeHostSecrets = null;
let activeHostResolution = null;
let startupState = { mode: "choice", preflight: null, error: null };

// Supervision: a farm host has to ride out a crash, a sleep and a reboot without anyone noticing.
let hostServerWanted = false;       // true while the local server should be running
let hostServerEnv = null;           // what to start it with again after a crash
let hostServerRestartTimer = null;
const hostServerRestarts = createRestartPolicy();
let agentWanted = null;             // the site settings while the site agent should be running
let agentRestartTimer = null;
const agentRestarts = createRestartPolicy();
let keepAwakeId = null;
const recentServerOutput = [];       // last few lines the server printed, to explain a failed start

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch { return null; }
}

function writeConfig(next) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, configPath);
}

function resolveServerEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "system", "server", "src", "index.js")
    : path.join(__dirname, "..", "system", "server", "src", "index.js");
}

// A new host listens on 4173 unless PHONE_FARM_PORT says otherwise (and moves on by itself if that is taken).
function defaultHostPort() {
  const configured = Number(process.env.PHONE_FARM_PORT);
  return Number.isInteger(configured) && configured >= 1024 && configured <= 65535 ? configured : 4173;
}

function hostSecrets() {
  const existing = readConfig();
  if (existing?.mode === "host" && existing.sessionSecret && existing.twoFactorMasterKey) return existing;
  return {
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    twoFactorMasterKey: crypto.randomBytes(32).toString("hex"),
    port: defaultHostPort(),
  };
}

function waitForServerReady(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (!serverProcess) return reject(new Error("Phone Farm server exited during startup"));
      const req = http.get({ host: "127.0.0.1", port, path: "/api/me", timeout: 1500 }, res => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) return reject(new Error("Phone Farm server did not start in time"));
        setTimeout(poll, 400);
      });
      req.on("timeout", () => req.destroy());
    })();
  });
}

function publicPreflight(resolution) {
  if (!resolution) return null;
  return {
    ok: resolution.ok,
    autoProvision: resolution.autoProvision,
    checks: resolution.checks.map(({ id, label, ok, optional, message, needsInput, fixable }) => ({
      id, label, ok, optional: Boolean(optional), message,
      ...(needsInput ? { needsInput } : {}),
      ...(fixable ? { fixable } : {}),
    })),
  };
}

// Phone Farm ships WebDriverAgent inside the app (Contents/Resources/wda).
// The signed bundle is never written to: the source is copied once to a
// versioned folder under userData and that copy is what xcodebuild uses.
function bundledWdaRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "wda")
    : path.join(__dirname, "build", "runtime", "wda");
}

function prepareManagedWda() {
  if (process.platform !== "darwin") return null;
  try {
    return ensureManagedWdaSource({
      bundledRoot: bundledWdaRoot(),
      managedRoot: path.join(app.getPath("userData"), "wda-source"),
      log: message => logger.info(message),
    });
  } catch (error) {
    logger.error(`Could not prepare the bundled WebDriverAgent: ${error.message}`);
    return null;
  }
}

function resolveHostSetup(config) {
  // Development and test switch: start the server on a computer that is not a farm host (no Xcode, no phones)
  // without the Mac prerequisite checks. Never set in the installed app; the automated tests set it so they pass
  // the same on a clean CI Mac as on any other machine.
  if (process.env.PHONE_FARM_SKIP_HOST_PREFLIGHT === "1") return resolveMacHostDependencies({ platform: "linux" });
  const routingEnabled = config?.autoRouteProxyTunnels === true || process.env.AUTO_ROUTE_PROXY_TUNNELS === "true";
  const managedWda = prepareManagedWda();
  // Keychain inspection only when neither the environment nor a saved value names a team.
  let team = { teamId: null, candidates: [] };
  if (managedWda) {
    team = resolveWdaDevelopmentTeam({ env: process.env, savedTeam: config?.wdaDevelopmentTeam, detected: [] });
    if (!team.teamId) team = resolveWdaDevelopmentTeam({ env: process.env, savedTeam: null, detected: detectDevelopmentTeams() });
  }
  return resolveMacHostDependencies({
    persistedWdaPath: config?.wdaRepoPath,
    managedWdaPath: managedWda?.path,
    developmentTeam: team.teamId,
    signingCandidates: team.candidates,
    routingEnabled,
  });
}

function hostStorageEnvironment(secrets) {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(secrets.port),
    HOST: "127.0.0.1",
    SESSION_SECRET: secrets.sessionSecret,
    TWO_FACTOR_MASTER_KEY: secrets.twoFactorMasterKey,
    OPERATORS_CONFIG_PATH: path.join(storageRoot, "operators.json"),
    SESSION_STORE_DIR: path.join(storageRoot, "sessions"),
    AUDIT_LOG_PATH: path.join(storageRoot, "audit.log"),
    QUEUE_STORE_PATH: path.join(storageRoot, "queue.json"),
    MODEL_SELECTION_STORE_PATH: path.join(storageRoot, "models.json"),
    ASSIGNMENT_STORE_PATH: path.join(storageRoot, "assignments.json"),
    RESEARCH_STORE_DIR: path.join(storageRoot, "research"),
    RESEARCH_EVIDENCE_DIR: path.join(storageRoot, "evidence"),
    FILE_STORE_DIR: path.join(storageRoot, "files"),
    ACCOUNT_NOTIFICATION_STORE_PATH: path.join(storageRoot, "notifications.json"),
    DEVICE_PROVISIONING_STORE_PATH: path.join(storageRoot, "device-provisioning.json"),
    WDA_DERIVED_DATA_ROOT: path.join(storageRoot, "wda-derived-data"),
    PROXY_POOL_STORE_PATH: path.join(storageRoot, "proxy-pool.json"),
    USB_NETWORK_STORE_PATH: path.join(storageRoot, "usb-network.json"),
  };
}

// The Mac must not fall asleep while it is running phones: a sleeping Mac drops every USB phone and WebDriverAgent.
function syncKeepAwake() {
  const needed = Boolean(serverProcess || agentProcess || hostServerRestartTimer || agentRestartTimer);
  if (needed && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start("prevent-app-suspension");
    logger.info("keeping this Mac awake while Phone Farm is running phones");
  } else if (!needed && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
    logger.info("no longer keeping this Mac awake");
  }
}

// Start again after a reboot or power cut. Only the installed app: a development run must never register itself.
function launchAtLoginEnabled(config = readConfig()) {
  if (typeof config?.launchAtLogin === "boolean") return config.launchAtLogin;
  return config?.mode === "host" || config?.mode === "site"; // an operator workstation is not a farm host
}

function applyLaunchAtLogin(enabled = launchAtLoginEnabled()) {
  if (!app.isPackaged || !["darwin", "win32"].includes(process.platform)) return;
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  } catch (error) {
    logger.warn(`could not change the start-at-login setting: ${error.message}`);
  }
}

function setLaunchAtLogin(enabled) {
  writeConfig({ ...(readConfig() ?? {}), launchAtLogin: Boolean(enabled) });
  applyLaunchAtLogin(enabled);
  buildMenu();
}

function rememberServerOutput(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    recentServerOutput.push(line.trim());
    if (recentServerOutput.length > 8) recentServerOutput.shift();
  }
}

// One line that says why the server would not start (a port in use, a bad setting), for the setup screen.
function startupFailureDetail() {
  const informative = [...recentServerOutput].reverse().find(line => /error|EADDR|cannot|failed|refus|must|invalid/i.test(line));
  return informative ?? recentServerOutput.at(-1) ?? "";
}

function spawnHostServer() {
  const child = spawn(process.execPath, [resolveServerEntry()], { env: hostServerEnv, stdio: "pipe" });
  serverProcess = child;
  recentServerOutput.length = 0;
  child.stdout.on("data", chunk => { rememberServerOutput(chunk); logger.info(`[server] ${String(chunk).trimEnd()}`); });
  child.stderr.on("data", chunk => { rememberServerOutput(chunk); logger.warn(`[server] ${String(chunk).trimEnd()}`); });
  child.on("error", error => {
    logger.error(`[server] failed to start: ${error?.stack || error}`);
    if (serverProcess === child) serverProcess = null;
    syncKeepAwake();
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) logger.error(`[server] exited with code ${code}`);
    if (serverProcess === child) serverProcess = null;
    // Only a server that had finished starting, and that we did not stop ourselves, is restarted.
    if (child.supervised && hostServerWanted && !child.intentionalStop) {
      logger.error(`[server] stopped unexpectedly (code ${code}, signal ${signal})`);
      scheduleHostServerRestart();
    }
    syncKeepAwake();
  });
  return child;
}

function scheduleHostServerRestart() {
  if (hostServerRestartTimer || serverProcess || !hostServerWanted) return;
  const delay = hostServerRestarts.next();
  if (delay === null) {
    logger.error("[server] keeps stopping; not restarting it again");
    startupState = { ...startupState, error: "The Phone Farm server keeps stopping. Choose Help > Copy Diagnostics and send the result to whoever supports you." };
    syncKeepAwake();
    return;
  }
  logger.warn(`[server] restarting in ${Math.round(delay / 100) / 10}s`);
  hostServerRestartTimer = setTimeout(async () => {
    hostServerRestartTimer = null;
    if (!hostServerWanted || serverProcess) return;
    const child = spawnHostServer();
    try {
      await waitForServerReady(activeHostSecrets.port);
      child.supervised = true;
      logger.info("[server] running again");
    } catch (error) {
      logger.error(`[server] did not come back: ${error.message}`);
      child.intentionalStop = true;
      if (serverProcess === child) serverProcess = null; // the exit event arrives later; do not wait for it to try again
      child.kill();
      scheduleHostServerRestart();
    }
    syncKeepAwake();
  }, delay);
  syncKeepAwake();
}

// Stops the local server on purpose (switching mode, quitting): it must NOT be restarted.
function stopHostServer() {
  hostServerWanted = false;
  clearTimeout(hostServerRestartTimer);
  hostServerRestartTimer = null;
  if (serverProcess) {
    const child = serverProcess;
    serverProcess = null;
    child.intentionalStop = true;
    child.kill();
  }
  syncKeepAwake();
}

async function startHostServer() {
  if (serverProcess) return { port: activeHostSecrets.port, preflight: publicPreflight(activeHostResolution) };
  const config = readConfig();
  const resolution = resolveHostSetup(config);
  activeHostResolution = resolution;
  if (!resolution.ok) {
    const error = new Error("Host prerequisites need attention before automatic iPhone setup can start.");
    error.preflight = publicPreflight(resolution);
    throw error;
  }

  const secrets = hostSecrets();
  // The usual port may already be taken (another tool, a second Phone Farm on a shared Mac): use the next free one.
  const freePort = await findFreePort(secrets.port);
  if (freePort !== secrets.port) {
    logger.warn(`port ${secrets.port} is already in use; using ${freePort} instead`);
    secrets.port = freePort;
  }
  activeHostSecrets = secrets;
  const env = buildHostEnvironment({
    ...process.env,
    ...hostStorageEnvironment(secrets),
  }, resolution);
  // A fresh desktop install intentionally has no DEVICE_CONFIG_PATH. Auto
  // discovery is independent of manual pinned-device configuration. An
  // advanced operator can still opt in with an existing explicit path.
  if (config?.manualDeviceConfigPath && fs.existsSync(config.manualDeviceConfigPath)) {
    env.DEVICE_CONFIG_PATH = config.manualDeviceConfigPath;
  } else if (!process.env.DEVICE_CONFIG_PATH) {
    delete env.DEVICE_CONFIG_PATH;
  }

  hostServerEnv = env;
  const child = spawnHostServer();
  try {
    await waitForServerReady(secrets.port);
  } catch (error) {
    if (serverProcess === child) serverProcess = null;
    child.intentionalStop = true;
    child.kill();
    syncKeepAwake();
    const detail = startupFailureDetail();
    logger.error(`host server did not start: ${error.message}${detail ? ` (${detail})` : ""}`);
    if (detail) error.message = `${error.message}: ${detail}`;
    throw error;
  }
  child.supervised = true;
  hostServerWanted = true;
  hostServerRestarts.reset();
  syncKeepAwake();
  logger.info(`host server running on port ${secrets.port}`);
  return { port: secrets.port, preflight: publicPreflight(resolution) };
}

// ---- Site mode: this Mac mini is one location of a multi-site Phone Farm ----------------
// It runs the site agent (no operator UI) which links its USB phones to the hub.
function startSiteAgent(settings) {
  if (agentProcess) return { ok: true, status: agentStatus };
  const config = readConfig();
  const resolution = resolveHostSetup(config);
  activeHostResolution = resolution;
  if (!resolution.ok) {
    const error = new Error("This Mac needs attention before it can set up iPhones automatically.");
    error.preflight = publicPreflight(resolution);
    throw error;
  }
  // The same prerequisites as a host (Xcode, signing, WebDriverAgent), plus the site identity.
  const env = {
    ...buildHostEnvironment({ ...process.env }, resolution),
    ...siteAgentEnvironment(settings, { storageRoot, path }),
  };
  delete env.DEVICE_CONFIG_PATH;
  env.AUTO_PROVISION_WDA = "true";
  const child = spawn(process.execPath, [agentEntryPath({
    packaged: app.isPackaged, resourcesPath: process.resourcesPath, dirname: __dirname, path,
  })], { env, stdio: "pipe" });
  agentProcess = child;
  agentWanted = settings;
  syncKeepAwake();
  agentStatus = { state: "starting", detail: "Starting the site agent…" };
  const onOutput = chunk => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      logger.info(`[agent] ${line}`);
      const parsed = parseAgentStatus(line);
      if (parsed && agentProcess === child) agentStatus = parsed;
    }
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);
  child.on("error", error => {
    if (agentProcess === child) { agentProcess = null; agentStatus = { state: "error", detail: error.message }; }
    syncKeepAwake();
  });
  child.on("exit", code => {
    if (agentProcess === child) {
      agentProcess = null;
      agentStatus = { state: "stopped", detail: code ? `The site agent stopped (code ${code}).` : "" };
      if (agentWanted && !child.intentionalStop) scheduleAgentRestart();
    }
    syncKeepAwake();
  });
  return { ok: true, status: agentStatus, preflight: publicPreflight(resolution) };
}

function scheduleAgentRestart() {
  if (agentRestartTimer || agentProcess || !agentWanted) return;
  const delay = agentRestarts.next();
  if (delay === null) {
    logger.error("[agent] keeps stopping; not restarting it again");
    agentStatus = { state: "error", detail: "The site agent keeps stopping. Choose Help > Copy Diagnostics and send the result to whoever supports you." };
    return;
  }
  logger.warn(`[agent] restarting in ${Math.round(delay / 100) / 10}s`);
  agentRestartTimer = setTimeout(() => {
    agentRestartTimer = null;
    if (!agentWanted || agentProcess) return;
    try {
      startSiteAgent(agentWanted);
    } catch (error) {
      logger.error(`[agent] could not restart: ${error.message}`);
      scheduleAgentRestart();
    }
  }, delay);
  syncKeepAwake();
}

function stopSiteAgent() {
  agentWanted = null;
  clearTimeout(agentRestartTimer);
  agentRestartTimer = null;
  if (agentProcess) {
    const child = agentProcess;
    agentProcess = null;
    child.intentionalStop = true;
    child.kill();
  }
  agentStatus = { state: "stopped", detail: "" };
  syncKeepAwake();
}

function protectWindowNavigation(window, isAllowed) {
  const guard = (event, targetUrl) => {
    if (!isAllowed(targetUrl)) event.preventDefault();
  };
  window.webContents.on("will-navigate", guard);
  window.webContents.on("will-redirect", guard);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

async function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return setupWindow;
  }
  const window = new BrowserWindow({
    width: 760,
    height: 760,
    webPreferences: setupWebPreferences(path.join(__dirname, "preload.js")),
  });
  setupWindow = window;
  protectWindowNavigation(window, url => isAllowedSetupNavigation(url, setupFilePath));
  window.on("closed", () => { if (setupWindow === window) setupWindow = null; });
  await window.loadFile(setupFilePath);
  return window;
}

async function openAppWindow(rawUrl) {
  const allowedOrigin = normalizedOrigin(rawUrl);
  if (!allowedOrigin) throw new Error("host URL must be http or https and must not contain credentials");
  if (appWindow && !appWindow.isDestroyed()) appWindow.close();
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    webPreferences: appWebPreferences(),
  });
  appWindow = window;
  protectWindowNavigation(window, url => isAllowedAppNavigation(url, allowedOrigin));
  window.on("closed", () => { if (appWindow === window) appWindow = null; });
  try {
    await window.loadURL(rawUrl);
  } catch (error) {
    if (!window.isDestroyed()) window.close();
    throw error;
  }
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  return window;
}

function authorizedSetupRequest(event) {
  return isTrustedSetupSender(event, setupWindow, setupFilePath);
}

function unauthorizedResult() {
  return { ok: false, error: "Unauthorized desktop setup request." };
}

ipcMain.handle("desktop:get-startup-state", event => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  return { ok: true, ...startupState, launchAtLogin: readConfig()?.launchAtLogin !== false };
});

ipcMain.handle("desktop:fix-check", async (event, { id } = {}) => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  const result = await applyFix(id, {
    onOutput: line => {
      logger.info(`[fix ${id}] ${line}`);
      if (!event.sender.isDestroyed()) event.sender.send("desktop:fix-progress", line);
    },
  });
  logger.info(`fix ${id}: ${result.ok ? "done" : "failed"} - ${result.message}`);
  return result;
});

ipcMain.handle("desktop:copy-diagnostics", event => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  clipboard.writeText(collectDiagnostics());
  return { ok: true };
});

ipcMain.handle("desktop:show-logs", event => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  shell.showItemInFolder(logger.file);
  return { ok: true };
});

ipcMain.handle("desktop:set-launch-at-login", (event, { enabled } = {}) => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  try {
    setLaunchAtLogin(enabled === true);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("desktop:start-host-setup", async event => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  try {
    const { port, preflight } = await startHostServer();
    const alreadyConfigured = readConfig()?.mode === "host";
    startupState = { mode: "host", preflight, error: null };
    if (alreadyConfigured) setImmediate(() => { void openAppWindow(`http://127.0.0.1:${port}`); });
    return { ok: true, port, alreadyConfigured, preflight };
  } catch (error) {
    startupState = { mode: "host", preflight: error.preflight || publicPreflight(activeHostResolution), error: error.message };
    return { ok: false, error: error.message, preflight: startupState.preflight };
  }
});

ipcMain.handle("desktop:save-host-settings", async (event, { wdaDevelopmentTeam } = {}) => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  const team = typeof wdaDevelopmentTeam === "string" ? wdaDevelopmentTeam.trim().toUpperCase() : "";
  if (!isValidTeamId(team)) {
    return { ok: false, error: "An Apple Team ID is exactly 10 letters and digits (for example ABCDE12345)." };
  }
  try {
    writeConfig({ ...readConfig(), wdaDevelopmentTeam: team });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("desktop:create-admin", async (event, { username, password, fullName, email } = {}) => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  try {
    if (!serverProcess || !activeHostSecrets) throw new Error("The local host server is not running.");
    const port = activeHostSecrets.port;
    const body = JSON.stringify({ username, password, fullName: fullName || undefined, email: email || undefined });
    const response = await fetch(`http://127.0.0.1:${port}/api/setup/create-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const payload = await response.json();
    if (!response.ok) return { ok: false, error: payload?.error || `HTTP ${response.status}` };
    writeConfig({
      ...readConfig(),
      mode: "host",
      port,
      sessionSecret: activeHostSecrets.sessionSecret,
      twoFactorMasterKey: activeHostSecrets.twoFactorMasterKey,
      // Only an operator-chosen checkout is remembered; the bundled copy is
      // re-derived on every launch so app updates can replace it.
      wdaRepoPath: activeHostResolution?.wdaSource === "managed" ? undefined : activeHostResolution?.wdaRepoPath,
    });
    applyLaunchAtLogin();
    await openAppWindow(`http://127.0.0.1:${port}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("desktop:start-site-agent", async (event, input = {}) => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  const checked = validateSiteSettings(input);
  if (!checked.ok) return { ok: false, error: checked.error };
  try {
    stopHostServer();
    const started = startSiteAgent(checked.settings);
    writeConfig({ ...readConfig(), mode: "site", ...checked.settings });
    applyLaunchAtLogin();
    startupState = { mode: "site", preflight: started.preflight ?? null, error: null };
    return { ok: true, status: agentStatus, preflight: started.preflight ?? null };
  } catch (error) {
    startupState = { mode: "site", preflight: error.preflight || publicPreflight(activeHostResolution), error: error.message };
    return { ok: false, error: error.message, preflight: startupState.preflight };
  }
});

ipcMain.handle("desktop:get-site-status", event => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  return { ok: true, status: agentStatus };
});

ipcMain.handle("desktop:stop-site-agent", event => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  stopSiteAgent();
  const config = readConfig();
  if (config?.mode === "site") writeConfig({ ...config, mode: undefined, siteToken: undefined });
  return { ok: true };
});

ipcMain.handle("desktop:connect-to-host", async (event, { url } = {}) => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  try {
    const parsed = new URL(url);
    if (!normalizedOrigin(parsed.toString())) throw new Error("host URL must be http or https and must not contain credentials");
    stopHostServer();
    writeConfig({ mode: "client", serverUrl: parsed.toString() });
    applyLaunchAtLogin();
    await openAppWindow(parsed.toString());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

async function launch() {
  const existing = readConfig();
  if (existing?.mode === "client" && existing.serverUrl) {
    try {
      await openAppWindow(existing.serverUrl);
      return;
    } catch (error) {
      startupState = { mode: "client", preflight: null, error: error.message };
    }
  }
  if (existing?.mode === "site") {
    const checked = validateSiteSettings(existing);
    if (checked.ok) {
      try {
        const started = startSiteAgent(checked.settings);
        applyLaunchAtLogin();
        startupState = { mode: "site", preflight: started.preflight ?? null, error: null };
      } catch (error) {
        startupState = { mode: "site", preflight: error.preflight || publicPreflight(activeHostResolution), error: error.message };
        logger.error(`Failed to restart the site agent: ${error.message}`);
      }
      await createSetupWindow(); // shows the agent's status; there is no operator UI in this mode
      return;
    }
  }
  if (existing?.mode === "host") {
    try {
      const { port } = await startHostServer();
      applyLaunchAtLogin();
      await openAppWindow(`http://127.0.0.1:${port}`);
      return;
    } catch (error) {
      startupState = { mode: "host", preflight: error.preflight || publicPreflight(activeHostResolution), error: error.message };
      logger.error(`Failed to restart host server: ${error.message}`);
    }
  }
  await createSetupWindow();
}

function collectDiagnostics() {
  const config = readConfig();
  const resolution = activeHostResolution;
  return buildDiagnosticsReport({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    mode: config?.mode ?? startupState.mode,
    preflight: publicPreflight(resolution),
    config,
    wda: resolution?.wdaRepoPath ? { source: resolution.wdaSource, path: resolution.wdaRepoPath } : null,
    tools: resolution?.tools ?? {},
    serverState: serverProcess ? "running" : hostServerRestartTimer ? "restarting" : "stopped",
    agentState: agentProcess || agentWanted ? agentStatus.state : null,
    logLines: logger.tail(250),
    logFile: logger.file,
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        {
          label: "Copy Diagnostics",
          click: () => {
            clipboard.writeText(collectDiagnostics());
            void dialog.showMessageBox({
              type: "info",
              message: "Diagnostics copied",
              detail: "Paste them into a message to whoever is helping you. They contain no passwords or keys.",
            });
          },
        },
        { label: "Show Log Folder", click: () => shell.showItemInFolder(logger.file) },
        { type: "separator" },
        {
          label: "Start Phone Farm When This Mac Starts",
          type: "checkbox",
          checked: launchAtLoginEnabled(),
          enabled: app.isPackaged,
          click: item => setLaunchAtLogin(item.checked),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One Phone Farm per Mac: a second copy (a double-click, or the login item firing while the app is already open)
// would fight the first one for the server's port and the phones.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = [appWindow, setupWindow].find(candidate => candidate && !candidate.isDestroyed());
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    } else {
      void launch();
    }
  });
  app.whenReady().then(() => {
    buildMenu();
    logger.info(`Phone Farm ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`);
    return launch();
  });
}
app.on("before-quit", () => {
  hostServerWanted = false;
  stopHostServer();
  stopSiteAgent();
  logger.info("Phone Farm quitting");
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void launch(); });
