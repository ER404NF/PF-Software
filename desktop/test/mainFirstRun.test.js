// The first run, end to end, on the real code: choose "Set up a new host", create the first admin from the setup page,
// then sign in to the real server the way the operator window does. Only Electron is faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadMain } = require("./helpers/mainHarness.js");

const net = require("node:net");

const app = loadMain();
test.before(async () => {
  // Never fight another test (or another program) for the default port.
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
  });
  process.env.PHONE_FARM_PORT = String(port);
  await app.wait(50);
});
test.after(() => app.cleanup());

async function login(port, username, password) {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

test("a fresh install: host setup starts the real server, the first admin is created, and that admin can sign in", { timeout: 90_000 }, async () => {
  assert.match(app.windows[0].file, /first-run\.html$/, "the setup page opens on a fresh install");

  const started = await app.handlers.get("desktop:start-host-setup")(app.trusted());
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.alreadyConfigured, false, "nothing is configured yet, so the page moves on to the admin form");
  assert.equal(await app.responds(started.port), true);

  // Before the first admin exists nobody can sign in.
  assert.equal((await login(started.port, "owner1", "a-long-password-123")).status, 401);

  const created = await app.handlers.get("desktop:create-admin")(app.trusted(), {
    username: "owner1", password: "a-long-password-123", fullName: "Farm Owner", email: "owner@gmail.com",
  });
  assert.deepEqual(created, { ok: true }, JSON.stringify(created));

  // The choice is remembered, with secrets only in the owner-only settings file.
  const config = JSON.parse(fs.readFileSync(app.configPath(), "utf8"));
  assert.equal(config.mode, "host");
  assert.equal(config.port, started.port);
  assert.match(config.sessionSecret, /^[0-9a-f]{64}$/);

  // The operator window opened on the local server and is a separate, unprivileged window.
  const operatorWindow = app.windows.find(window => window.url);
  assert.equal(operatorWindow.url, `http://127.0.0.1:${started.port}`);
  assert.equal(operatorWindow.options.webPreferences.preload, undefined, "the operator page has no privileged bridge");
  assert.equal(app.windows[0].destroyed, true, "the setup page is closed");

  // The new admin signs in with the password they just chose. Administrators must set up two-factor sign-in, so the
  // first sign-in is answered with "set up your authenticator" (202) rather than a full session.
  const signedIn = await login(started.port, "owner1", "a-long-password-123");
  assert.equal(signedIn.status, 202, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.requiresTwoFactorSetup, true);
  assert.equal((await login(started.port, "owner1", "the-wrong-password-1")).status, 401, "a wrong password is still refused");

  // A second first-admin request must not create another admin (the setup is one-time).
  const again = await app.handlers.get("desktop:create-admin")({ ...app.trusted(), sender: app.windows[0].webContents }, {
    username: "intruder", password: "another-long-password-1", email: "x@gmail.com",
  });
  assert.equal(again.ok, false, "the setup page is closed, so its channel no longer answers");

  app.appEvents.get("before-quit")();
  await app.until(async () => !(await app.responds(started.port)), { what: "the server to stop" });
});
