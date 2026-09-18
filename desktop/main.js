// Phone Farm desktop wrapper — one download, two first-run modes:
//   "host"   — spawns the real system/server on this machine and shows the
//              one-time local create-admin screen (POST /api/setup/create-admin,
//              see system/server/src/index.js) before handing off to the
//              normal login page.
//   "client" — just a window pointed at an existing host's URL; no server
//              code ever runs on this machine.
// system/client and system/server are reused unchanged — this is a shell,
// not a rewrite. The spawned "Node" process is actually this Electron
// binary running with ELECTRON_RUN_AS_NODE=1, so a host machine does not
// need a separate system Node.js install.

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");

const configPath = path.join(app.getPath("userData"), "desktop-config.json");
const storageRoot = path.join(app.getPath("userData"), "host-storage");

let mainWindow = null;
let serverProcess = null;
// Set once by startHostServer() and reused by the create-admin handler below
// — generating secrets a second time here would persist a DIFFERENT
// sessionSecret/twoFactorMasterKey than the one the already-running server
// process was actually launched with, silently breaking 2FA decryption
// (twoFactor.js) for the very admin this flow just created on the next
// restart.
let activeHostSecrets = null;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch { return null; }
}

function writeConfig(next) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
}

function resolveServerEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "system", "server", "src", "index.js")
    : path.join(__dirname, "..", "system", "server", "src", "index.js");
}

// Persisted once on first host setup and reused on every later launch —
// sessions and 2FA secrets must survive a restart of this app, exactly like
// a normal server restart already needs to (see fileSessionStore.js).
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

async function startHostServer() {
  if (serverProcess) return { port: activeHostSecrets.port, secrets: activeHostSecrets };
  const secrets = hostSecrets();
  activeHostSecrets = secrets;
  const env = {
    ...process.env,
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
    DEVICE_CONFIG_PATH: path.join(storageRoot, "devices.config.json"),
  };
  serverProcess = spawn(process.execPath, [resolveServerEntry()], { env, stdio: "pipe" });
  serverProcess.stdout.on("data", chunk => console.log(`[phone-farm-server] ${chunk}`));
  serverProcess.stderr.on("data", chunk => console.error(`[phone-farm-server] ${chunk}`));
  serverProcess.on("exit", code => {
    console.error(`[phone-farm-server] exited with code ${code}`);
    serverProcess = null;
  });
  app.on("before-quit", () => { if (serverProcess) serverProcess.kill(); });
  await waitForServerReady(secrets.port);
  return { port: secrets.port, secrets };
}

ipcMain.handle("desktop:start-host-setup", async () => {
  try {
    const { port, secrets } = await startHostServer();
    return { ok: true, port, alreadyConfigured: readConfig()?.mode === "host" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("desktop:create-admin", async (_event, { port, username, password, fullName, email }) => {
  try {
    const body = JSON.stringify({ username, password, fullName: fullName || undefined, email: email || undefined });
    const response = await fetch(`http://127.0.0.1:${port}/api/setup/create-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const payload = await response.json();
    if (!response.ok) return { ok: false, error: payload?.error || `HTTP ${response.status}` };
    writeConfig({
      mode: "host", port,
      sessionSecret: activeHostSecrets.sessionSecret,
      twoFactorMasterKey: activeHostSecrets.twoFactorMasterKey,
    });
    await mainWindow.loadURL(`http://127.0.0.1:${port}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("desktop:connect-to-host", async (_event, { url }) => {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("host URL must be http or https");
    writeConfig({ mode: "client", serverUrl: parsed.toString() });
    await mainWindow.loadURL(parsed.toString());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

async function launch() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });

  const existing = readConfig();
  if (existing?.mode === "client" && existing.serverUrl) {
    await mainWindow.loadURL(existing.serverUrl);
    return;
  }
  if (existing?.mode === "host") {
    try {
      const { port } = await startHostServer();
      await mainWindow.loadURL(`http://127.0.0.1:${port}`);
      return;
    } catch (error) {
      console.error("Failed to restart host server:", error);
      // Fall through to first-run so the operator sees a clear error state
      // instead of a blank window.
    }
  }
  await mainWindow.loadFile(path.join(__dirname, "first-run.html"));
}

app.whenReady().then(launch);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) launch(); });
