// Loads the real main.js against a stand-in for Electron (test/helpers/mainHarness.js) and drives it: every IPC channel,
// the menu, the log, and the supervision of a real (Node) Phone Farm server process. main.js cannot run without
// Electron, so without this a typo in it would only show up on the first launch on a Mac.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { loadMain } = require("./helpers/mainHarness.js");
const desktopVersion = require("../package.json").version.replaceAll(".", "\\.");

const app = loadMain();
const { handlers, appEvents, windows, clipboardWrites, blockers, menus, shown, loginItems, spawned, trusted, stranger, wait, until, responds, readLog } = app;
const configFile = app.configPath();

test.before(async () => { await wait(50); }); // whenReady().then(launch) runs in a microtask
test.after(() => app.cleanup());

async function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test("the setup window opens on a fresh install and the log records the start", () => {
  assert.equal(windows.length, 1);
  assert.match(windows[0].file, /first-run\.html$/);
  assert.match(readLog(), new RegExp(`Phone Farm ${desktopVersion} starting`));
});

test("every desktop channel the page can call is handled, and none answers anyone but the setup page", async () => {
  const preload = fs.readFileSync(path.join(app.desktopDir, "preload.js"), "utf8");
  const exposed = [...preload.matchAll(/"(desktop:[a-z-]+)"/g)].map(match => match[1]).filter(channel => channel !== "desktop:fix-progress");
  assert.deepEqual([...handlers.keys()].sort(), [...new Set(exposed)].sort(), "the preload and the main process agree on the channels");
  for (const [channel, handler] of handlers) {
    assert.deepEqual(await handler(stranger, {}), { ok: false, error: "Unauthorized desktop setup request." }, `${channel} must refuse other pages`);
  }
});

test("fixes: only the two known fixes exist, and none runs off a Mac", async () => {
  const fix = handlers.get("desktop:fix-check");
  assert.deepEqual(await fix(trusted(), { id: "rm -rf /" }), { ok: false, message: "That fix is not available." });
  assert.deepEqual(await fix(trusted(), {}), { ok: false, message: "That fix is not available." });
  if (process.platform !== "darwin") assert.match((await fix(trusted(), { id: "xcode" })).message, /only apply on a Mac/);
});

test("diagnostics are copied to the clipboard and hold no secret", async () => {
  fs.writeFileSync(configFile, JSON.stringify({ sessionSecret: "MUST-NOT-LEAK-1234567", siteToken: "pfs_MUSTNOTLEAKTOKEN", launchAtLogin: true }));
  assert.deepEqual(await handlers.get("desktop:copy-diagnostics")(trusted()), { ok: true });
  const report = clipboardWrites.at(-1);
  assert.match(report, /^Phone Farm diagnostics/);
  assert.match(report, /Saved settings: launchAtLogin, sessionSecret, siteToken/);
  assert.doesNotMatch(report, /MUST-NOT-LEAK|MUSTNOTLEAK/);
  assert.match(report, new RegExp(`Phone Farm ${desktopVersion} starting`), "the recent log is included");
  fs.rmSync(configFile);
});

test("the Help menu offers diagnostics, the log folder and start-at-login", () => {
  const help = menus.at(-1).find(item => item.label === "Help");
  assert.deepEqual(help.submenu.filter(item => item.label).map(item => item.label),
    ["Copy Diagnostics", "Show Log Folder", "Start Phone Farm When This Mac Starts"]);
  assert.equal(help.submenu.at(-1).type, "checkbox");
  help.submenu[0].click();
  assert.match(clipboardWrites.at(-1), /^Phone Farm diagnostics/);
  assert.equal(shown.at(-1).message, "Diagnostics copied");
});

test("start-at-login is remembered, defaults on for a host, and a development run never registers a login item", async () => {
  assert.equal((await handlers.get("desktop:get-startup-state")(trusted())).launchAtLogin, true, "the page shows it ticked by default");
  assert.deepEqual(await handlers.get("desktop:set-launch-at-login")(trusted(), { enabled: false }), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).launchAtLogin, false);
  assert.equal((await handlers.get("desktop:get-startup-state")(trusted())).launchAtLogin, false);
  await handlers.get("desktop:set-launch-at-login")(trusted(), { enabled: "yes please" });
  assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).launchAtLogin, false, "only a real true turns it on");
  assert.deepEqual(loginItems, [], "app.isPackaged is false here");
  await handlers.get("desktop:set-launch-at-login")(trusted(), { enabled: true });
  fs.rmSync(configFile);
});

test("when the usual port is taken by something else the host starts on the next free port instead of failing", { timeout: 60_000 }, async () => {
  // A fresh install uses one default port. Point that default at a port this test then occupies.
  const busy = await freePort();
  process.env.PHONE_FARM_PORT = String(busy);
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(busy, "127.0.0.1", resolve));
  try {
    const started = await handlers.get("desktop:start-host-setup")(trusted());
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.notEqual(started.port, busy, "did not try to share the busy port");
    assert.equal(await responds(started.port), true, "the server answers on the port it moved to");
    assert.match(readLog(), new RegExp(`port ${busy} is already in use; using ${started.port} instead`));
  } finally {
    delete process.env.PHONE_FARM_PORT;
    appEvents.get("before-quit")();
    await new Promise(resolve => blocker.close(resolve));
  }
});

test("a host that crashes comes back by itself, keeps the Mac awake meanwhile, and stays stopped when it is quit", { timeout: 90_000 }, async () => {
  const port = await freePort();
  // A configured host: the same secrets and port on every start.
  fs.writeFileSync(configFile, JSON.stringify({
    mode: "host", port, sessionSecret: "s".repeat(64), twoFactorMasterKey: "k".repeat(64),
  }));
  const before = spawned.length;
  const awakeBefore = blockers.started.length;
  const asleepBefore = blockers.stopped.length;

  const started = await handlers.get("desktop:start-host-setup")(trusted());
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.port, port);
  assert.equal(spawned.length, before + 1);
  assert.equal(await responds(port), true, "the real server is up");
  assert.equal(blockers.started.length, awakeBefore + 1, "the Mac is kept awake while phones are being run");
  assert.equal(blockers.started.at(-1), "prevent-app-suspension");

  // Crash it, as an out-of-memory kill or a bug would.
  spawned[before].kill();
  await until(() => spawned.length === before + 2, { what: "the supervisor to start it again" });
  await until(() => responds(port), { what: "the restarted server to answer" });
  await until(() => /running again/.test(readLog()), { what: "the supervisor to record that the server is back" });
  assert.equal(blockers.started.length, awakeBefore + 1, "still one awake-assertion across the restart");
  assert.match(readLog(), /stopped unexpectedly[\s\S]*restarting in 1s[\s\S]*running again/);

  // Quitting on purpose must not be treated as a crash.
  appEvents.get("before-quit")();
  await until(async () => !(await responds(port)), { what: "the server to stop" });
  await wait(2500);
  assert.equal(spawned.length, before + 2, "no restart after a deliberate quit");
  assert.equal(blockers.stopped.length, asleepBefore + 1, "the Mac may sleep again");
  fs.rmSync(configFile, { force: true });
});
