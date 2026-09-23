// Loads the real desktop/main.js against a stand-in for Electron. Real child processes are used (and remembered) so a
// test can start the real Phone Farm server, crash it, and watch what the app does. One harness per test FILE: main.js
// keeps module-level state, so each file runs in its own process.
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const childProcess = require("node:child_process");
const { pathToFileURL } = require("node:url");

const desktopDir = path.resolve(__dirname, "..", "..");

function loadMain(options = {}) {
  // The real prerequisite checks (Xcode, iPhone tools) depend on the machine the tests run on: a clean macOS CI runner
  // has no iPhone tools and would refuse to start the host. The tests are about the app's behaviour, not that machine.
  process.env.PHONE_FARM_SKIP_HOST_PREFLIGHT = "1";
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-userdata-"));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-logs-"));
  const handlers = new Map();
  const appEvents = new Map();
  const windows = [];
  const clipboardWrites = [];
  const blockers = { started: [], stopped: [] };
  const menus = [];
  const shown = [];
  const loginItems = [];
  const spawned = [];
  const quitCalls = [];
  const openedPaths = [];
  const dialogResponses = [...(options.dialogResponses || [])];

  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.webContents = { on() {}, setWindowOpenHandler() {}, send() {}, isDestroyed: () => false };
      windows.push(this);
    }
    on() {}
    async loadFile(file) { this.file = file; }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    focus() {}
    close() { this.destroyed = true; }
    static getAllWindows() { return windows.filter(window => !window.destroyed); }
  }

  const fakeElectron = {
    app: {
      isPackaged: options.isPackaged === true,
      getPath: name => (name === "logs" ? logsDir : name === "temp" ? os.tmpdir() : userData),
      getVersion: () => options.version || "0.2.0",
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: (name, handler) => { appEvents.set(name, handler); },
      quit: () => quitCalls.push(Date.now()),
      setLoginItemSettings: settings => loginItems.push(settings),
    },
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: template => { menus.push(template); return template; }, setApplicationMenu() {} },
    clipboard: { writeText: text => clipboardWrites.push(text) },
    dialog: { showMessageBox: async settings => { shown.push(settings); return dialogResponses.shift() || { response: 0 }; } },
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    powerSaveBlocker: { start: type => { blockers.started.push(type); return blockers.started.length; }, stop: id => { blockers.stopped.push(id); } },
    shell: { showItemInFolder() {}, openPath: async target => { openedPaths.push(target); return ""; } },
  };

  const realSpawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = realSpawn(...args);
    spawned.push(child);
    return child;
  };
  const originalLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === "electron") return fakeElectron;
    if (request === "./autoUpdate" && options.autoUpdate) return options.autoUpdate;
    return originalLoad.call(this, request, ...rest);
  };
  require("../../main.js");
  Module._load = originalLoad;

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  return {
    desktopDir, userData, logsDir, handlers, appEvents, windows, clipboardWrites, blockers, menus, shown, loginItems, spawned, quitCalls, openedPaths, wait,
    // An event as Electron would deliver it from the first-run page / from anywhere else.
    trusted: () => ({ sender: windows[0].webContents, senderFrame: { url: pathToFileURL(path.join(desktopDir, "first-run.html")).toString() } }),
    stranger: { sender: { not: "the setup window" }, senderFrame: { url: "https://example.com/" } },
    readLog: () => fs.readFileSync(path.join(logsDir, "phone-farm.log"), "utf8"),
    configPath: () => path.join(userData, "desktop-config.json"),
    async until(condition, { timeoutMs = 20_000, everyMs = 100, what = "condition" } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await condition()) return;
        await wait(everyMs);
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    responds: port => new Promise(resolve => {
      const request = http.get({ host: "127.0.0.1", port, path: "/api/me", timeout: 1000 }, response => { response.resume(); resolve(true); });
      request.on("error", () => resolve(false));
      request.on("timeout", () => { request.destroy(); resolve(false); });
    }),
    cleanup() {
      for (const child of spawned) { try { child.kill(); } catch { /* already gone */ } }
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(logsDir, { recursive: true, force: true });
      // A real server was started and stopped: if a stray handle ever keeps the process alive, do not hang the suite.
      setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
    },
  };
}

module.exports = { loadMain };
