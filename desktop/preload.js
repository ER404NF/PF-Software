const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  startHostSetup: () => ipcRenderer.invoke("desktop:start-host-setup"),
  createAdmin: (payload) => ipcRenderer.invoke("desktop:create-admin", payload),
  connectToHost: (url) => ipcRenderer.invoke("desktop:connect-to-host", { url }),
});
