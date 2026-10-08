"use strict";

// The application menu, as plain data so it can be tested without Electron.
//
//   Bodun menu  - the settings for this Mac (start at login, proxy routing, automatic network enrollment,
//                 automatic Internet Sharing). The last three apply after Bodun is reopened, so their labels say so
//                 and the handler offers "Restart now". On a host or a site Mac it also has "Move Aside Damaged
//                 Process Records", which moves (never deletes) a damaged record of earlier processes.
//   Help menu   - Copy Diagnostics and Show Log Folder only.
//   View menu   - one Toggle Full Screen. Reload, Force Reload and Toggle Developer Tools exist only in a
//                 development run, never in the installed app.

function settingsItems({ config, isPackaged, launchAtLogin, handlers }) {
  const isHost = config?.mode === "host";
  const isSite = config?.mode === "site";
  const items = [
    {
      label: "Start Bodun When This Mac Starts",
      type: "checkbox",
      checked: Boolean(launchAtLogin),
      enabled: isPackaged,
      click: item => handlers.setLaunchAtLogin(item.checked),
    },
  ];
  if (isHost) {
    items.push(
      {
        label: "Enable Proxy Routing on This Mac (restart required)",
        type: "checkbox",
        checked: config?.autoRouteProxyTunnels === true,
        click: item => handlers.setProxyRouting(item.checked),
      },
      {
        label: "Automatic Network Enrollment (restart required)",
        type: "checkbox",
        checked: config?.autoNetworkEnrollment === true,
        enabled: config?.autoRouteProxyTunnels === true,
        click: item => handlers.setAutomation("autoNetworkEnrollment", item.checked),
      },
      {
        label: "Automatic Internet Sharing (restart required)",
        type: "checkbox",
        checked: config?.autoInternetSharing === true,
        enabled: config?.autoRouteProxyTunnels === true,
        click: item => handlers.setAutomation("autoInternetSharing", item.checked),
      },
    );
  }
  if (isHost || isSite) {
    items.push({
      label: "Move Aside Damaged Process Records…",
      click: () => handlers.moveAsideDamagedRecords(),
    });
  }
  return items;
}

function viewMenu({ isPackaged }) {
  const submenu = [];
  if (!isPackaged) {
    submenu.push({ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" });
  }
  submenu.push(
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  );
  return { label: "View", submenu };
}

function buildMenuTemplate({ isMac, isPackaged, config, launchAtLogin, appName = "Bodun", handlers }) {
  const settings = settingsItems({ config, isPackaged, launchAtLogin, handlers });
  const appMenu = {
    label: appName,
    submenu: [
      { role: "about" },
      { type: "separator" },
      ...settings,
      { type: "separator" },
      ...(isMac ? [{ role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }] : []),
      { role: "quit" },
    ],
  };
  return [
    appMenu,
    { role: "editMenu" },
    viewMenu({ isPackaged }),
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        { label: "Copy Diagnostics", click: () => handlers.copyDiagnostics() },
        { label: "Show Log Folder", click: () => handlers.showLogFolder() },
      ],
    },
  ];
}

module.exports = { buildMenuTemplate, settingsItems, viewMenu };
