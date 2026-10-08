// While Bodun's own server is running, "Move Aside Damaged Process Records…" must refuse and change nothing: the server may be
// using the very records the action would move. This runs the real server through main.js, as mainLifecycle.test.js does.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { loadMain } = require("./helpers/mainHarness.js");

const app = loadMain({});
const { handlers, appEvents, menus, shown, spawned, trusted, wait, until, responds, userData, dialogResponses } = app;
const storage = path.join(userData, "host-storage");
const childrenFile = path.join(storage, "desktop-children.json");
const DAMAGED = "{\"version\":1,\"chil";

test.before(async () => { await wait(50); });
test.after(() => app.cleanup());

async function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test("with Bodun's own server running the action refuses, says why, and leaves the damaged record exactly where it was", { timeout: 90_000 }, async () => {
  const port = await freePort();
  fs.writeFileSync(app.configPath(), JSON.stringify({ mode: "host", port, sessionSecret: "s".repeat(64), twoFactorMasterKey: "k".repeat(64) }));
  // Rebuild the menu for a host first: once a configured host starts, the setup page is replaced by the app window.
  assert.deepEqual(await handlers.get("desktop:set-launch-at-login")(trusted(), { enabled: true }), { ok: true });
  const started = await handlers.get("desktop:start-host-setup")(trusted());
  assert.equal(started.ok, true, JSON.stringify(started));
  await until(() => responds(started.port), { what: "the real server to answer" });
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(childrenFile, DAMAGED);

  const item = menus.at(-1).find(entry => entry.label === "Bodun").submenu.find(entry => entry.label === "Move Aside Damaged Process Records…");
  assert.ok(item, "a host Mac has the action");
  const before = shown.length;
  dialogResponses.push({ response: 1 }); // if it wrongly asked "Move aside?", this answer would go through
  item.click();
  await until(() => shown.length > before, { what: "the refusal" });
  await wait(100);
  const dialogs = shown.slice(before);
  assert.equal(dialogs.length, 1, "one dialog, and it is the refusal");
  assert.match(dialogs[0].message, /Bodun's own server is running/);
  assert.match(dialogs[0].detail, /Quit Bodun and open it again/);
  assert.deepEqual([...dialogs[0].buttons], ["OK"]);
  assert.equal(fs.readFileSync(childrenFile, "utf8"), DAMAGED, "not a byte changed");
  assert.deepEqual(fs.readdirSync(storage).filter(name => name.includes(".damaged-")), []);
  assert.equal(spawned.length >= 1, true);

  appEvents.get("before-quit")();
  await until(async () => !(await responds(started.port)), { what: "the server to stop" });
});
