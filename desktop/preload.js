const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getStartupState: () => ipcRenderer.invoke("desktop:get-startup-state"),
  startHostSetup: () => ipcRenderer.invoke("desktop:start-host-setup"),
  createAdmin: (payload) => ipcRenderer.invoke("desktop:create-admin", payload),
  connectToHost: (url) => ipcRenderer.invoke("desktop:connect-to-host", { url }),
});
