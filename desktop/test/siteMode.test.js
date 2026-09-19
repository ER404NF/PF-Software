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
  assert.match(main, /before-quit[\s\S]*stopSiteAgent\(\)/);
  assert.match(main, /function stopSiteAgent\(\) \{[\s\S]*agentWanted = null;[\s\S]*child\.kill\(\)/, "stopping is deliberate, so the agent is not restarted");
});

test("the setup page offers the third mode without weakening its Content-Security-Policy", () => {
  assert.match(firstRun, /id="site-choice"/);
  assert.match(firstRun, /connect-src 'none'/);
  assert.doesNotMatch(firstRun, /https?:\/\/[^"'\s]*\.(js|css)/, "no remote scripts or styles");
});
