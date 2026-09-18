// Phone Farm desktop wrapper. Local setup is intentionally isolated from
// server/client web content: only the packaged first-run page receives the
// privileged preload API. The normal Phone Farm window has no preload.

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const { buildHostEnvironment, resolveMacHostDependencies } = require("./hostEnvironment");
const {
  appWebPreferences,
  isAllowedAppNavigation,
  isAllowedSetupNavigation,
  isTrustedSetupSender,
  normalizedOrigin,
  setupWebPreferences,
} = require("./windowSecurity");

const configPath = path.join(app.getPath("userData"), "desktop-config.json");
const storageRoot = path.join(app.getPath("userData"), "host-storage");
const setupFilePath = path.join(__dirname, "first-run.html");

let setupWindow = null;
let appWindow = null;
let serverProcess = null;
let activeHostSecrets = null;
let activeHostResolution = null;
let startupState = { mode: "choice", preflight: null, error: null };

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

function hostSecrets() {
  const existing = readConfig();
  if (existing?.mode === "host" && existing.sessionSecret && existing.twoFactorMasterKey) return existing;
  return {
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    twoFactorMasterKey: crypto.randomBytes(32).toString("hex"),
    port: 4173,
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
    checks: resolution.checks.map(({ id, label, ok, optional, message }) => ({
      id, label, ok, optional: Boolean(optional), message,
    })),
  };
}

function resolveHostSetup(config) {
  const routingEnabled = config?.autoRouteProxyTunnels === true || process.env.AUTO_ROUTE_PROXY_TUNNELS === "true";
  return resolveMacHostDependencies({ persistedWdaPath: config?.wdaRepoPath, routingEnabled });
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

  const child = spawn(process.execPath, [resolveServerEntry()], { env, stdio: "pipe" });
  serverProcess = child;
  child.stdout.on("data", chunk => console.log(`[phone-farm-server] ${chunk}`));
  child.stderr.on("data", chunk => console.error(`[phone-farm-server] ${chunk}`));
  child.on("error", error => {
    console.error("[phone-farm-server] failed to start:", error);
    if (serverProcess === child) serverProcess = null;
  });
  child.on("exit", code => {
    if (code !== 0 && code !== null) console.error(`[phone-farm-server] exited with code ${code}`);
    if (serverProcess === child) serverProcess = null;
  });
  try {
    await waitForServerReady(secrets.port);
  } catch (error) {
    if (serverProcess === child) serverProcess = null;
    child.kill();
    throw error;
  }
  return { port: secrets.port, preflight: publicPreflight(resolution) };
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
  return { ok: true, ...startupState };
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
      wdaRepoPath: activeHostResolution?.wdaRepoPath,
    });
    await openAppWindow(`http://127.0.0.1:${port}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("desktop:connect-to-host", async (event, { url } = {}) => {
  if (!authorizedSetupRequest(event)) return unauthorizedResult();
  try {
    const parsed = new URL(url);
    if (!normalizedOrigin(parsed.toString())) throw new Error("host URL must be http or https and must not contain credentials");
    if (serverProcess) {
      const child = serverProcess;
      serverProcess = null;
      child.kill();
    }
    writeConfig({ mode: "client", serverUrl: parsed.toString() });
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
  if (existing?.mode === "host") {
    try {
      const { port } = await startHostServer();
      await openAppWindow(`http://127.0.0.1:${port}`);
      return;
    } catch (error) {
      startupState = { mode: "host", preflight: error.preflight || publicPreflight(activeHostResolution), error: error.message };
      console.error("Failed to restart host server:", error.message);
    }
  }
  await createSetupWindow();
}

app.whenReady().then(launch);
app.on("before-quit", () => { if (serverProcess) serverProcess.kill(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void launch(); });
