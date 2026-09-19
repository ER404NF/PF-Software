const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getStartupState: () => ipcRenderer.invoke("desktop:get-startup-state"),
  startHostSetup: () => ipcRenderer.invoke("desktop:start-host-setup"),
  saveHostSettings: (settings) => ipcRenderer.invoke("desktop:save-host-settings", settings),
  createAdmin: (payload) => ipcRenderer.invoke("desktop:create-admin", payload),
  connectToHost: (url) => ipcRenderer.invoke("desktop:connect-to-host", { url }),
  startSiteAgent: (settings) => ipcRenderer.invoke("desktop:start-site-agent", settings),
  getSiteStatus: () => ipcRenderer.invoke("desktop:get-site-status"),
  stopSiteAgent: () => ipcRenderer.invoke("desktop:stop-site-agent"),
  // One-click fixes for a failed prerequisite row ("xcode" or "ios-tools"); progress lines stream back.
  fixPrerequisite: (id) => ipcRenderer.invoke("desktop:fix-check", { id }),
  onFixProgress: (callback) => {
    const handler = (_event, line) => callback(String(line));
    ipcRenderer.on("desktop:fix-progress", handler);
    return () => ipcRenderer.removeListener("desktop:fix-progress", handler);
  },
  copyDiagnostics: () => ipcRenderer.invoke("desktop:copy-diagnostics"),
  showLogs: () => ipcRenderer.invoke("desktop:show-logs"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("desktop:set-launch-at-login", { enabled }),
});
