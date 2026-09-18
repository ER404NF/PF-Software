const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  appWebPreferences,
  isAllowedAppNavigation,
  isAllowedSetupNavigation,
  isTrustedSetupSender,
  normalizedOrigin,
  setupWebPreferences,
} = require("../windowSecurity");

test("only the exact packaged setup frame can call privileged IPC", () => {
  const setupFile = path.resolve("desktop/first-run.html");
  const webContents = {};
  const setupWindow = { webContents, isDestroyed: () => false };
  const trusted = { sender: webContents, senderFrame: { url: pathToFileURL(setupFile).toString() } };
  assert.equal(isTrustedSetupSender(trusted, setupWindow, setupFile), true);
  assert.equal(isTrustedSetupSender({ ...trusted, senderFrame: { url: "https://evil.example/" } }, setupWindow, setupFile), false);
  assert.equal(isTrustedSetupSender({ ...trusted, sender: {} }, setupWindow, setupFile), false);
});

test("setup navigation is local-file-only and app navigation stays on its configured origin", () => {
  const setupFile = path.resolve("desktop/first-run.html");
  assert.equal(isAllowedSetupNavigation(pathToFileURL(setupFile).toString(), setupFile), true);
  assert.equal(isAllowedSetupNavigation("https://example.com/", setupFile), false);
  assert.equal(isAllowedAppNavigation("https://host.example/devices", "https://host.example"), true);
  assert.equal(isAllowedAppNavigation("https://other.example/", "https://host.example"), false);
  assert.equal(isAllowedAppNavigation("file:///tmp/attack.html", "https://host.example"), false);
});

test("remote URLs with embedded credentials are rejected", () => {
  assert.equal(normalizedOrigin("https://host.example/path"), "https://host.example");
  assert.equal(normalizedOrigin("https://user:secret@host.example/"), null);
  assert.equal(normalizedOrigin("javascript:alert(1)"), null);
});

test("only the local setup window receives a preload", () => {
  const privileged = setupWebPreferences("/app/preload.js");
  const remote = appWebPreferences();
  assert.equal(privileged.preload, "/app/preload.js");
  assert.equal(Object.hasOwn(remote, "preload"), false);
  assert.equal(remote.contextIsolation, true);
  assert.equal(remote.nodeIntegration, false);
  assert.equal(remote.sandbox, true);
});
