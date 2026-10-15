const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const main = read("main.js");
const preload = read("preload.js");
const firstRun = read("first-run.html");

test("every site-mode IPC channel the setup page can call exists in the main process and is sender-checked", () => {
  const channels = [...preload.matchAll(/"(desktop:[a-z-]*site[a-z-]*)"/g)].map(match => match[1]);
  assert.deepEqual(channels.sort(), ["desktop:get-site-status", "desktop:start-site-agent", "desktop:stop-site-agent"]);
  for (const channel of channels) {
    const start = main.indexOf(`ipcMain.handle("${channel}"`);
    assert.ok(start >= 0, `${channel} is handled`);
    const body = main.slice(start, start + 400);
    assert.match(body, /authorizedSetupRequest\(event\)/, `${channel} only answers the trusted setup page`);
  }
});

test("the site token is validated before use, never logged, and stored only in the private settings file", () => {
  assert.match(main, /validateSiteSettings\(input\)/);
  assert.match(main, /validateSiteSettings\(existing\)/, "a saved configuration is re-validated on launch");
  for (const line of main.split("\n").filter(text => /console\.(log|error)|logger\./.test(text))) {
    assert.doesNotMatch(line, /siteToken|SITE_TOKEN|settings\.token/, `a log line must not include the token: ${line.trim()}`);
  }
  assert.match(main, /mode: 0o600/, "settings are written owner-only");
  assert.match(firstRun, /id="site-token" type="password"/);
  assert.match(firstRun, /getElementById\("site-token"\)\.value = ""/, "the token field is emptied after saving");
});

test("stopping site mode forgets the token and the app quits cleanly with it", () => {
  assert.match(main, /siteToken: undefined/);
  assert.match(main, /before-quit[\s\S]*topologyTransition\.stopAll\(\)/);
  assert.match(main, /function stopSiteAgent\(\) \{[\s\S]*agentWanted = null;[\s\S]*child\.intentionalStop = true;[\s\S]*shutdownChildren\(/, "stopping is deliberate, so the agent is not restarted, and it is stopped with the bounded wait");
});

test("the setup page offers the third mode without weakening its Content-Security-Policy", () => {
  assert.match(firstRun, /id="site-choice"/);
  assert.match(firstRun, /connect-src 'none'/);
  assert.doesNotMatch(firstRun, /https?:\/\/[^"'\s]*\.(js|css)/, "no remote scripts or styles");
});

test("first-run topology copy distinguishes local host, hub operator, and site agent authority", () => {
  assert.match(firstRun, /Standalone host on this Mac/);
  assert.match(firstRun, /Railway accounts, database and email settings are not used/);
  assert.match(firstRun, /Connect as an operator/);
  assert.match(firstRun, /Accounts, approvals and email are managed by that hub/);
  assert.match(firstRun, /Link this Mac's phones to the company hub/);
  assert.match(firstRun, /no local operator account is created/);
});

test("switching from a standalone host preserves local data and persists site mode only after hub acceptance", () => {
  assert.match(firstRun, /local accounts stay on this Mac and will not automatically appear on the hub/);
  assert.match(main, /previous\?\.mode === "host" && input\.confirmSwitch !== true/);
  const handler = main.slice(main.indexOf('ipcMain.handle("desktop:start-site-agent"'), main.indexOf('ipcMain.handle("desktop:get-site-status"'));
  assert.match(handler, /topologyTransition\.transitionTo\("site"/);
  assert.ok(handler.indexOf("await waitForSiteAcceptance()") < handler.indexOf('writeConfig({ ...readConfig(), mode: "site"'));
  assert.match(handler, /restore: mode => restoreTopology\(mode, readConfig\(\) \|\| previous\)/);
  assert.doesNotMatch(handler, /rmSync|unlinkSync|OPERATORS_CONFIG_PATH/);
  assert.match(main, /if \(existing\?\.sessionSecret && existing\.twoFactorMasterKey\) return existing/,
    "returning to the preserved standalone host reuses its encryption keys");
});
