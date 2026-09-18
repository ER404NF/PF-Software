const { pathToFileURL } = require("url");

function normalizedOrigin(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isTrustedSetupSender(event, setupWindow, setupFilePath) {
  if (!setupWindow || setupWindow.isDestroyed?.()) return false;
  const expected = pathToFileURL(setupFilePath).toString();
  return event?.sender === setupWindow.webContents && event?.senderFrame?.url === expected;
}

function isAllowedSetupNavigation(targetUrl, setupFilePath) {
  return targetUrl === pathToFileURL(setupFilePath).toString();
}

function isAllowedAppNavigation(targetUrl, allowedOrigin) {
  return normalizedOrigin(targetUrl) === allowedOrigin;
}

function setupWebPreferences(preload) {
  return { preload, contextIsolation: true, nodeIntegration: false, sandbox: true };
}

function appWebPreferences() {
  return { contextIsolation: true, nodeIntegration: false, sandbox: true };
}

module.exports = {
  appWebPreferences,
  isAllowedAppNavigation,
  isAllowedSetupNavigation,
  isTrustedSetupSender,
  normalizedOrigin,
  setupWebPreferences,
};
