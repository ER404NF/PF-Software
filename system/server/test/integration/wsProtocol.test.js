import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { WdaDevice } from "../../src/wdaDevice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../../fixtures/fake-wda-server.js");
// Set once the fixture actually reports its (OS-assigned, ephemeral) port in
// before() below — see the comment on spawnFakeWda() for why this isn't a
// fixed port like it used to be.
let FAKE_WDA_PORT;
let FAKE_WDA_URL;

const TEST_PASSWORD = "test-password";

// Isolate this run's session/audit files from the real storage/sessions and
// storage/audit/events.log that `npm start` actually uses — without this,
// every test run would leave real-looking session and audit data behind in
// the dev storage tree. index.js reads these env vars at import time, so
// they must be set before it's imported — which, since static imports are
// hoisted above any other code in a file, means index.js must be imported
// dynamically here rather than with a normal top-level `import`.
const tmpStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-wstest-"));
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");

const { server, wss, devices, deviceHealth, deviceLease, taskQueue } = await import("../../src/index.js");
const { operators, hashPassword } = await import("../../src/authStore.js");

let relayUrl;
let httpUrl;
let fakeWdaChild;
const openClients = [];

// Logs in over HTTP and returns the raw Set-Cookie value, trimmed to just
// `name=value` — everything the WS handshake and later requests need, none
// of the Path/HttpOnly/SameSite attributes a browser would strip anyway.
async function loginCookie(username, password) {
  const res = await fetch(`${httpUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  // fetch()'s promise resolves once headers arrive, but this server holds
  // the response's last byte back until the session is actually written to
  // disk (express-session's res.end hook, gated on FileSessionStore.set's
  // callback). Reading the body forces this to actually wait for that —
  // without it, a WS upgrade sent immediately after this call can race the
  // write and get a spurious 401 (root-caused via extensive repro; this
  // wasn't a guess). The same fix is applied in client/app.js.
  await res.json();
  return setCookie.split(";")[0];
}

// Wraps a ws client so tests can `await waitFor(predicate)` instead of
// juggling raw 'message' listeners. Logs in as `username` first (defaulting
// to the full-access test operator) since every connection now requires an
// authenticated session — see index.js's `server.on("upgrade", ...)`.
async function openClient(username = "test-va", password = TEST_PASSWORD) {
  const cookie = await loginCookie(username, password);
  const ws = new WebSocket(relayUrl, { headers: { Cookie: cookie } });
  const received = [];
  const waiters = [];

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  const client = {
    send: (msg) => ws.send(JSON.stringify(msg)),
    received,
    // Resolves with an already-received match if one exists, otherwise waits
    // for the next one. Use for "has X happened yet" checks.
    waitFor(predicate, timeoutMs = 3000) {
      const already = received.find(predicate);
      if (already) return Promise.resolve(already);
      return client.waitForNext(predicate, timeoutMs);
    },
    // Ignores anything already received — only resolves on a genuinely new
    // arrival. Required whenever a predicate shape (e.g. "any frame") may
    // already have matched an earlier message: reusing `waitFor` for that
    // would instantly resolve with the stale one instead of waiting.
    waitForNext(predicate, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`waitForNext timed out: ${predicate}`)), timeoutMs);
        waiters.push({
          predicate,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      });
    },
    // Polls `received` directly instead of reacting to message-arrival
    // events — for checks where neither waitFor nor waitForNext is safe: a
    // matching message may already be sitting in `received` (ruling out
    // waitForNext, which would then wait forever for a "new" one that never
    // comes again) *and* a stale earlier message may already satisfy the
    // same predicate shape (ruling out waitFor's "already matched"
    // shortcut, which would resolve with the wrong one). Polling sidesteps
    // both: it just checks current truth, repeatedly, regardless of when
    // any particular message happened to arrive.
    async waitUntil(predicate, timeoutMs = 3000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const match = received.find(predicate);
        if (match) return match;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitUntil timed out: ${predicate}`);
    },
    close: () => ws.close(),
  };

  openClients.push(client);
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(client));
    ws.on("error", reject);
  });
}

// Spawns with an OS-assigned ephemeral port (arg "0"), not a fixed one — a
// fixed port here previously caused real, if infrequent, flakiness: many
// rapid `npm test` runs in a row can leave enough TIME_WAIT sockets behind
// on a fixed port that a later run's bind (or a connection to it) fails.
// The fixture announces the port it actually got on stdout; parse that
// instead of polling a known port for readiness.
function spawnFakeWda() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fixturePath, "0"], { stdio: "pipe" });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/\[fake-wda\] listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        proc.stdout.off("data", onData);
        resolve({ proc, port: Number(match[1]) });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("error", reject);
  });
}

before(async () => {
  const { proc, port } = await spawnFakeWda();
  fakeWdaChild = proc;
  FAKE_WDA_PORT = port;
  FAKE_WDA_URL = `http://127.0.0.1:${port}`;

  // Test-only device, injected directly rather than via devices.config.json
  // so this never touches the config real devices load from.
  // Short timeout: the mid-session-failure test needs the tap to actually
  // time out within the test's own timeout budget, and 250ms per-request
  // delays elsewhere in this file stay well under it.
  devices.set("test-wda", new WdaDevice("test-wda", "Test WDA", { port: FAKE_WDA_PORT, timeoutMs: 500 }));

  // Test-only operators, injected directly (like the device above) rather
  // than via operators.config.json. "test-va" has full access; "test-va-
  // restricted" only reaches mock-1, for the authorization tests below.
  operators.set("test-va", {
    username: "test-va",
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: null,
    role: "admin",
  });
  operators.set("test-va-restricted", {
    username: "test-va-restricted",
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: ["mock-1"],
    role: "admin",
  });
  operators.set("test-plain-va", {
    username: "test-plain-va",
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: ["mock-1"],
    role: "va",
  });

  await new Promise((resolve) => server.listen(0, resolve));
  relayUrl = `ws://127.0.0.1:${server.address().port}`;
  httpUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const c of openClients) c.close();
  devices.delete("test-wda");
  operators.delete("test-va");
  operators.delete("test-va-restricted");
  operators.delete("test-plain-va");
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  fakeWdaChild.kill();
  fs.rmSync(tmpStorageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${FAKE_WDA_URL}/debug/reset`, { method: "POST" });
  // deviceHealth (consecutiveFailures/lastSeenAt) persists across tests in
  // this file since it's the same imported module instance — without this,
  // failures recorded in one test would bleed into the next test's
  // OFFLINE_AFTER_FAILURES threshold.
  deviceHealth.clear();
  // Same reasoning for controller-mode state — without this, a device left
  // in AI_IDLE by one test would make an unrelated later test's plain
  // select_device call fail for a reason that has nothing to do with it.
  deviceLease.reset();
});

test("select_device, tap, swipe, type_text, and release_device work end-to-end", async () => {
  const client = await openClient();

  await client.waitFor((m) => m.type === "device_list");
  client.send({ type: "select_device", deviceId: "mock-1" });
  await client.waitFor((m) => m.type === "frame" && m.deviceId === "mock-1");

  // Tap the Instagram icon (see mockDevice.js HOME_ICONS) to switch off the
  // home screen — swipe/typed text are only rendered on the app screen.
  // waitForNext (not waitFor): a "frame" already arrived from select_device
  // above, so a generic frame predicate must ignore it and wait for the new one.
  client.send({ type: "tap", x: 70 / 375, y: 120 / 667 });
  const afterOpen = await client.waitForNext((m) => m.type === "frame");
  assert.match(afterOpen.data, /Instagram \(mock\)/);

  client.send({ type: "swipe", direction: "left" });
  const afterSwipe = await client.waitFor((m) => m.type === "frame" && /last swipe/.test(m.data));
  assert.match(afterSwipe.data, /last swipe: left/);

  client.send({ type: "type_text", text: "hello" });
  const afterType = await client.waitFor((m) => m.type === "frame" && /typed:/.test(m.data));
  assert.match(afterType.data, /typed: hello/);

  // Home unconditionally returns to the springboard, unlike the in-app Back
  // control — proves it works even from deep inside an app with typed text
  // and a recorded swipe already present.
  client.send({ type: "home" });
  const afterHome = await client.waitForNext((m) => m.type === "frame");
  assert.match(afterHome.data, />Home</);
  assert.doesNotMatch(afterHome.data, /Instagram \(mock\)/);

  client.send({ type: "release_device" });
  // waitForNext: mock-1 was already "idle" in the very first device_list this
  // client received (before it selected anything) — waitFor's "already
  // matched" shortcut would find that stale message instead of the new
  // broadcast this release actually triggers.
  const list = await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );
  assert.equal(list.devices.find((d) => d.id === "mock-1").status, "idle");
});

test("selecting an unknown device returns an error, not a frame", async () => {
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");

  client.send({ type: "select_device", deviceId: "does-not-exist" });
  const err = await client.waitFor((m) => m.type === "error");
  assert.match(err.message, /Unknown device/);
});

test("a device already in use cannot be selected by a second connection", async () => {
  const a = await openClient();
  const b = await openClient();
  await a.waitFor((m) => m.type === "device_list");
  await b.waitFor((m) => m.type === "device_list");

  a.send({ type: "select_device", deviceId: "mock-2" });
  await a.waitFor((m) => m.type === "frame" && m.deviceId === "mock-2");

  b.send({ type: "select_device", deviceId: "mock-2" });
  const err = await b.waitFor((m) => m.type === "error" && m.deviceId === "mock-2");
  assert.match(err.message, /already in use/);

  a.send({ type: "release_device" });
  // waitForNext, same reasoning as the end-to-end test above.
  await a.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-2")?.status === "idle"
  );
});

test("out-of-range tap coordinates are dropped silently, never forwarded", async () => {
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");
  client.send({ type: "select_device", deviceId: "mock-1" });
  await client.waitFor((m) => m.type === "frame" && m.deviceId === "mock-1");

  const framesBefore = client.received.filter((m) => m.type === "frame").length;
  client.send({ type: "tap", x: 2, y: 0.5 }); // out of [0,1]
  client.send({ type: "tap", x: Number.NaN, y: 0.5 });

  // Prove the bad taps produced no response by sending one good action after
  // them and confirming exactly one new frame arrives, not three. Counting
  // rather than matching frame content: mock-1 carries state over from the
  // earlier end-to-end test in this file (it's the same device instance), so
  // its screen may already contain swipe/typed text from that test.
  client.send({ type: "swipe", direction: "up" });
  await client.waitForNext(() => client.received.filter((m) => m.type === "frame").length >= framesBefore + 1);
  const framesAfter = client.received.filter((m) => m.type === "frame").length;
  assert.equal(framesAfter - framesBefore, 1);

  client.send({ type: "release_device" });
});

test("concurrent messages on one connection are processed strictly in order", async () => {
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");
  client.send({ type: "select_device", deviceId: "test-wda" });
  await client.waitFor((m) => m.type === "frame" && m.deviceId === "test-wda");

  // Warm up with a real tap first — this is what actually caches the WDA
  // session AND window size on the server's WdaDevice instance (selecting a
  // device only creates the session, via its initial screenshot). Resetting
  // the fixture's history afterward means only the two measured taps below
  // show up in it, even though the cached session/window-size live on the
  // relay's device object, not the fixture, and survive the reset.
  client.send({ type: "tap", x: 0.05, y: 0.05 });
  await client.waitForNext((m) => m.type === "frame" && m.deviceId === "test-wda");
  await fetch(`${FAKE_WDA_URL}/debug/reset`, { method: "POST" });
  await fetch(`${FAKE_WDA_URL}/debug/delay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ms: 250 }),
  });

  const framesBefore = client.received.filter((m) => m.type === "frame").length;
  client.send({ type: "tap", x: 0.1, y: 0.1 });
  client.send({ type: "tap", x: 0.2, y: 0.2 });
  await client.waitForNext(
    () => client.received.filter((m) => m.type === "frame").length >= framesBefore + 2,
    5000
  );

  await fetch(`${FAKE_WDA_URL}/debug/delay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ms: 0 }),
  });

  const { history } = await fetch(`${FAKE_WDA_URL}/debug/history`).then((r) => r.json());
  // If the action queue did NOT serialize these, the second tap could have
  // been sent to the fake server before the first tap's screenshot request
  // completed. Serialized, the pattern is strictly tap -> screenshot ->
  // tap -> screenshot.
  assert.deepEqual(
    history.map((h) => h.type),
    ["tap", "screenshot", "tap", "screenshot"]
  );

  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "test-wda")?.status === "idle"
  );
});

test("a single failure reports an error but does not flip the device offline", async () => {
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");
  client.send({ type: "select_device", deviceId: "test-wda" });
  await client.waitFor((m) => m.type === "frame" && m.deviceId === "test-wda");

  await fetch(`${FAKE_WDA_URL}/debug/hang`, { method: "POST" });
  client.send({ type: "tap", x: 0.3, y: 0.3 });
  const err = await client.waitForNext((m) => m.type === "error");
  assert.equal(err.deviceId, "test-wda");
  assert.match(err.message, /Couldn't reach/);

  // One blip shouldn't alarm every other VA watching the device list, or
  // knock the active VA off their own in-progress selection — only a run of
  // failures means something is actually wrong (see OFFLINE_AFTER_FAILURES).
  await new Promise((r) => setTimeout(r, 150));
  const offlineBroadcast = client.received.find(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "test-wda")?.status === "offline"
  );
  assert.equal(offlineBroadcast, undefined);

  // No second error should follow from the same failed tap — reportError
  // must fire exactly once per failure, not once per internal retry/step.
  assert.equal(client.received.filter((m) => m.type === "error").length, 1);
  // And no frame at all — a failed tap must not also report success.
  assert.equal(client.received.filter((m) => m.type === "frame").length, 1); // only the initial selection frame

  await fetch(`${FAKE_WDA_URL}/debug/unhang`, { method: "POST" });
  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "test-wda")?.status === "idle"
  );
});

test("3 consecutive failures flip the device offline; a later success recovers it", async () => {
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");
  client.send({ type: "select_device", deviceId: "test-wda" });
  await client.waitFor((m) => m.type === "frame" && m.deviceId === "test-wda");

  await fetch(`${FAKE_WDA_URL}/debug/hang`, { method: "POST" });
  for (let i = 0; i < 3; i++) {
    client.send({ type: "tap", x: 0.3, y: 0.3 });
    await client.waitForNext((m) => m.type === "error");
  }
  const offlineList = await client.waitFor(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "test-wda")?.status === "offline"
  );
  assert.equal(offlineList.devices.find((d) => d.id === "test-wda").status, "offline");

  await fetch(`${FAKE_WDA_URL}/debug/unhang`, { method: "POST" });
  client.send({ type: "tap", x: 0.3, y: 0.3 });
  const recoveredList = await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "test-wda")?.status === "in-use"
  );
  assert.equal(recoveredList.devices.find((d) => d.id === "test-wda").status, "in-use");

  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "test-wda")?.status === "idle"
  );
});

test("login/logout HTTP flow: wrong password, right password, then me/logout", async () => {
  const bad = await fetch(`${httpUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test-va", password: "wrong" }),
  });
  assert.equal(bad.status, 401);

  const cookie = await loginCookie("test-va", TEST_PASSWORD);

  const me = await fetch(`${httpUrl}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { username: "test-va", role: "admin", allowedDevices: null });

  const logout = await fetch(`${httpUrl}/api/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);

  const meAfter = await fetch(`${httpUrl}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(meAfter.status, 401);
});

test("VA profile is reported safely and normal device control remains permitted", async () => {
  const cookie = await loginCookie("test-plain-va", TEST_PASSWORD);
  const me = await fetch(`${httpUrl}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  const profile = await me.json();
  assert.deepEqual(profile, { username: "test-plain-va", role: "va", allowedDevices: ["mock-1"] });
  assert.equal("passwordHash" in profile, false);

  const client = await openClient("test-plain-va", TEST_PASSWORD);
  await client.waitFor((m) => m.type === "device_list");
  client.send({ type: "select_device", deviceId: "mock-1" });
  await client.waitForNext((m) => m.type === "frame" && m.deviceId === "mock-1");
  client.send({ type: "tap", x: 0.2, y: 0.2 });
  await client.waitForNext((m) => m.type === "frame" && m.deviceId === "mock-1");
  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );
});

test("VA receives 403 on admin HTTP surfaces while admin can use them", async () => {
  const vaCookie = await loginCookie("test-plain-va", TEST_PASSWORD);
  const adminCookie = await loginCookie("test-va", TEST_PASSWORD);

  for (const [url, options] of [
    [`${httpUrl}/api/audit`, {}],
    [`${httpUrl}/api/queue`, {}],
    [`${httpUrl}/api/queue/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: vaCookie },
      body: JSON.stringify({ text: "/queue list" }),
    }],
  ]) {
    const headers = options.headers || { Cookie: vaCookie };
    const res = await fetch(url, { ...options, headers });
    assert.equal(res.status, 403, url);
  }

  const audit = await fetch(`${httpUrl}/api/audit?limit=1`, { headers: { Cookie: adminCookie } });
  assert.equal(audit.status, 200);
  const queue = await fetch(`${httpUrl}/api/queue`, { headers: { Cookie: adminCookie } });
  assert.equal(queue.status, 200);
  const command = await fetch(`${httpUrl}/api/queue/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ text: "/queue list" }),
  });
  assert.equal(command.status, 200);
});

test("VA cannot invoke direct AI-mode WebSocket controls", async () => {
  const client = await openClient("test-plain-va", TEST_PASSWORD);
  await client.waitFor((m) => m.type === "device_list");

  for (const type of ["switch_to_ai", "takeover", "emergency_stop"]) {
    client.send({ type, deviceId: "mock-1" });
    const err = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-1");
    assert.match(err.message, /Admin role required/);
    assert.equal(deviceLease.getMode("mock-1"), "HUMAN");
  }
});

// Regression guard for a real bug: role/allowedDevices were only ever read
// off the operator object express-session cached at login time. An
// already-open session (or, worse, an already-open WS connection, which can
// live for hours) kept its OLD privileges no matter what operators.config.json
// said, until it happened to log out — a promotion never took effect early,
// and a demotion/revocation never took effect AT ALL for that session. Fixed
// by re-resolving the operator from the live registry (authStore.js's
// resolveOperator) on every request/message, the same way researchAccess.js's
// researchWorkspaceFor already did for research grants specifically.
test("an operator's role change takes effect on their next request, without needing to re-login (HTTP)", async () => {
  const cookie = await loginCookie("test-plain-va", TEST_PASSWORD);
  const deniedFirst = await fetch(`${httpUrl}/api/queue`, { headers: { Cookie: cookie } });
  assert.equal(deniedFirst.status, 403);

  const operator = operators.get("test-plain-va");
  try {
    operator.role = "admin";
    const allowedAfterPromotion = await fetch(`${httpUrl}/api/queue`, { headers: { Cookie: cookie } });
    assert.equal(allowedAfterPromotion.status, 200, "a promotion must take effect on the very next request, same session");

    operator.role = "va";
    const deniedAfterDemotion = await fetch(`${httpUrl}/api/queue`, { headers: { Cookie: cookie } });
    assert.equal(deniedAfterDemotion.status, 403, "a demotion must take effect immediately too — this is the security-critical direction");
  } finally {
    operator.role = "va";
  }
});

test("an operator's role change takes effect on an already-open WebSocket connection", async () => {
  const client = await openClient("test-plain-va", TEST_PASSWORD);
  await client.waitFor((m) => m.type === "device_list");

  client.send({ type: "switch_to_ai", deviceId: "mock-1" });
  const deniedFirst = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-1");
  assert.match(deniedFirst.message, /Admin role required/);

  const operator = operators.get("test-plain-va");
  try {
    operator.role = "admin";
    client.send({ type: "switch_to_ai", deviceId: "mock-1" });
    await client.waitForNext(
      (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "AI_IDLE"
    );
    assert.equal(deviceLease.getMode("mock-1"), "AI_IDLE", "the promotion must take effect on this same, already-open connection");

    operator.role = "va";
    client.send({ type: "emergency_stop", deviceId: "mock-1" });
    const deniedAfterDemotion = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-1");
    assert.match(deniedAfterDemotion.message, /Admin role required/);
    assert.equal(deviceLease.getMode("mock-1"), "AI_IDLE", "the demotion must also take effect immediately — the stale check would have let this through");
  } finally {
    operator.role = "va";
    deviceLease.reset();
  }
});

test("device and research HTTP routes require authentication", async () => {
  const files = await fetch(`${httpUrl}/api/devices/mock-1/files`);
  assert.equal(files.status, 401);

  const runs = await fetch(`${httpUrl}/api/research/some-account/runs`);
  assert.equal(runs.status, 401);

  const cookie = await loginCookie("test-va", TEST_PASSWORD);
  const filesAuthed = await fetch(`${httpUrl}/api/devices/mock-1/files`, { headers: { Cookie: cookie } });
  assert.equal(filesAuthed.status, 200);
});

test("an unauthenticated WebSocket upgrade is rejected before any messages are possible", async () => {
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(relayUrl); // no login, no cookie
        ws.on("open", resolve);
        ws.on("error", reject);
      }),
    /Unexpected server response: 401/
  );
});

test("a restricted operator can only select devices on their allow list", async () => {
  const client = await openClient("test-va-restricted", TEST_PASSWORD);
  await client.waitFor((m) => m.type === "device_list");

  client.send({ type: "select_device", deviceId: "mock-2" });
  const err = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-2");
  assert.match(err.message, /not authorized/);

  client.send({ type: "select_device", deviceId: "mock-1" });
  const frame = await client.waitForNext((m) => m.type === "frame" && m.deviceId === "mock-1");
  assert.ok(frame);

  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );
});

test("a restricted operator gets 403 (not 404) on a file route for a device they can't reach", async () => {
  const cookie = await loginCookie("test-va-restricted", TEST_PASSWORD);
  const res = await fetch(`${httpUrl}/api/devices/mock-2/files`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 403);

  const allowed = await fetch(`${httpUrl}/api/devices/mock-1/files`, { headers: { Cookie: cookie } });
  assert.equal(allowed.status, 200);
});

test("typed text is audited by length only — the actual text never reaches the audit log", async () => {
  const SECRET_TEXT = "supersecretpassword123";
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");
  client.send({ type: "select_device", deviceId: "mock-1" });
  await client.waitFor((m) => m.type === "frame" && m.deviceId === "mock-1");

  client.send({ type: "type_text", text: SECRET_TEXT });
  await client.waitForNext((m) => m.type === "frame");
  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );

  const cookie = await loginCookie("test-va", TEST_PASSWORD);
  const { events } = await fetch(`${httpUrl}/api/audit?deviceId=mock-1`, { headers: { Cookie: cookie } }).then((r) =>
    r.json()
  );

  const typeEvent = events.find((e) => e.type === "action_type_text");
  assert.ok(typeEvent, "expected an action_type_text audit event");
  // Not a full deepEqual against a fixed shape — detail legitimately grows
  // fields over time (e.g. networkEgress, Phase 0 network isolation); what
  // this test actually guards is that the length is right and the text
  // itself is never present in any field, which the check below still
  // covers regardless of what else is in detail.
  assert.equal(typeEvent.detail.length, SECRET_TEXT.length);

  // Belt and suspenders: the secret text must not appear anywhere in the
  // returned audit events at all, regardless of which field it might have
  // ended up in.
  assert.doesNotMatch(JSON.stringify(events), new RegExp(SECRET_TEXT));
});

test("home is audited like every other device action", async () => {
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");
  client.send({ type: "select_device", deviceId: "mock-1" });
  await client.waitFor((m) => m.type === "frame" && m.deviceId === "mock-1");

  client.send({ type: "home" });
  await client.waitForNext((m) => m.type === "frame");
  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );

  const cookie = await loginCookie("test-va", TEST_PASSWORD);
  const { events } = await fetch(`${httpUrl}/api/audit?deviceId=mock-1`, { headers: { Cookie: cookie } }).then((r) =>
    r.json()
  );
  const homeEvent = events.find((e) => e.type === "action_home");
  assert.ok(homeEvent, "expected an action_home audit event");
});

test("switch_to_ai moves a device out of HUMAN mode and blocks human selection", async () => {
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");

  client.send({ type: "switch_to_ai", deviceId: "mock-1" });
  const aiList = await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "AI_IDLE"
  );
  assert.equal(aiList.devices.find((d) => d.id === "mock-1").controllerMode, "AI_IDLE");

  client.send({ type: "select_device", deviceId: "mock-1" });
  const err = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-1");
  assert.match(err.message, /AI mode/);

  // Clean up via the real mechanism under test, not a direct reset — this
  // also doubles as the first half of the next test's scenario.
  client.send({ type: "takeover", deviceId: "mock-1" });
  await client.waitForNext((m) => m.type === "frame" && m.deviceId === "mock-1");
  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );
});

test("takeover on an AI-mode device switches it back to HUMAN and claims it for the caller", async () => {
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");

  client.send({ type: "switch_to_ai", deviceId: "mock-1" });
  await client.waitForNext((m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "AI_IDLE");

  client.send({ type: "takeover", deviceId: "mock-1" });
  const frame = await client.waitForNext((m) => m.type === "frame" && m.deviceId === "mock-1");
  assert.ok(frame);

  // waitUntil (polling), not waitFor/waitForNext: this specific check is
  // caught between two races — the very first device_list this client ever
  // received (before switch_to_ai) already showed controllerMode "HUMAN",
  // which rules out waitFor's "already matched" shortcut (it would grab
  // that stale one); but the real post-takeover device_list may also have
  // already arrived by the time this line runs (claimDevice sends it right
  // after the frame we just awaited), which rules out waitForNext (it
  // would then wait forever for a message that already came and went).
  // Polling for the fully-specific condition (both fields at once, which
  // the stale snapshot never satisfied) sidesteps both races.
  const list = await client.waitUntil(
    (m) =>
      m.type === "device_list" &&
      m.devices.find((d) => d.id === "mock-1")?.controllerMode === "HUMAN" &&
      m.devices.find((d) => d.id === "mock-1")?.status === "in-use"
  );
  const mock1 = list.devices.find((d) => d.id === "mock-1");
  assert.equal(mock1.controllerMode, "HUMAN");
  assert.equal(mock1.status, "in-use");

  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );
});

test("emergency_stop works immediately even with a hung simulated AI action, and does not claim the device", async () => {
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");

  client.send({ type: "switch_to_ai", deviceId: "mock-2" });
  await client.waitForNext((m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-2")?.controllerMode === "AI_IDLE");

  // Simulates a stuck AI worker — an action it registered but that will
  // never resolve on its own. A graceful takeover would wait on this (and
  // time out); emergency_stop must not wait on it at all.
  deviceLease.registerPendingAiAction("mock-2", new Promise(() => {}));

  const start = Date.now();
  client.send({ type: "emergency_stop", deviceId: "mock-2" });
  const list = await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-2")?.controllerMode === "HUMAN"
  );
  assert.ok(Date.now() - start < 1000, "emergency_stop must not wait on the hung action");
  const mock2 = list.devices.find((d) => d.id === "mock-2");
  assert.equal(mock2.controllerMode, "HUMAN");
  assert.equal(mock2.status, "idle", "emergency_stop stops AI control but does not claim the device");

  // Confirm it's genuinely usable again, not just labeled HUMAN.
  client.send({ type: "select_device", deviceId: "mock-2" });
  await client.waitForNext((m) => m.type === "frame" && m.deviceId === "mock-2");
  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-2")?.status === "idle"
  );
});

test("emergency_stop cancels a real RUNNING task in the queue, instead of leaving a zombie holder on the device", async () => {
  // Regression guard for a real bug: the WS emergency_stop handler used to
  // call deviceLease.emergencyStop() directly, bypassing the task queue
  // entirely — a RUNNING task would still believe it held the device even
  // after emergency_stop forced controller mode back to HUMAN underneath
  // it, permanently blocking that device from ever being dispatched to
  // again. Fixed by routing through taskQueue.emergencyStopDevice(), the
  // same fix already applied to the `takeover` handler in an earlier
  // milestone.
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");

  const task = taskQueue.addTask({ goal: "emergency-stop regression check", deviceSelector: { deviceId: "mock-1" } });
  assert.equal(task.state, "RUNNING");

  client.send({ type: "emergency_stop", deviceId: "mock-1" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "HUMAN"
  );
  assert.equal(taskQueue.getTask(task.id).state, "CANCELLED");

  // The real proof: the device must be genuinely free, not just relabeled —
  // a fresh task targeting it should dispatch immediately, not sit QUEUED
  // behind a phantom holder.
  const next = taskQueue.addTask({ goal: "should dispatch cleanly", deviceSelector: { deviceId: "mock-1" } });
  assert.equal(next.state, "RUNNING");
  taskQueue.cancelTask(next.id); // clean up — don't leave mock-1 occupied for later tests in this file
});

test("a task dispatched via the HTTP command console reaches connected WS clients with no WS action of their own", async () => {
  // Regression guard for a real gap: broadcastDeviceList() was only ever
  // called from inside WS message handlers, so a device changing mode via
  // the command console (POST /api/queue/command) or the background queue
  // tick — anything that isn't itself a WS message — never told anyone
  // watching the device list. A connected operator would only see it
  // eventually, by coincidence, if they happened to perform an unrelated WS
  // action of their own afterward.
  const client = await openClient();
  await client.waitFor((m) => m.type === "device_list");

  const cookie = await loginCookie("test-va", TEST_PASSWORD);
  const res = await fetch(`${httpUrl}/api/queue/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ text: "/time 00:00-23:59 broadcast regression check" }),
  });
  const { task } = await res.json();
  assert.equal(task.state, "RUNNING");

  // waitFor, not waitForNext: the broadcast (fired synchronously inside the
  // HTTP handler, before its response body was even sent) has very likely
  // already arrived by the time we get here — deviceLease.reset() in
  // beforeEach rules out a stale match from an earlier test.
  const list = await client.waitFor(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === task.deviceSelector.deviceId)?.controllerMode === "AI_RUNNING"
  );
  assert.ok(list, "the WS client should have received a device_list update without sending anything itself");

  taskQueue.cancelTask(task.id); // clean up — don't leave the device occupied for later tests
});

test("switch_to_ai is rejected while the device is claimed by a human", async () => {
  const a = await openClient();
  const b = await openClient();
  await a.waitFor((m) => m.type === "device_list");
  await b.waitFor((m) => m.type === "device_list");

  a.send({ type: "select_device", deviceId: "mock-1" });
  await a.waitFor((m) => m.type === "frame" && m.deviceId === "mock-1");

  b.send({ type: "switch_to_ai", deviceId: "mock-1" });
  const err = await b.waitForNext((m) => m.type === "error" && m.deviceId === "mock-1");
  assert.match(err.message, /must be idle/);

  a.send({ type: "release_device" });
  await a.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );
});

test("switch_to_ai, takeover, and emergency_stop are all blocked by device RBAC", async () => {
  const client = await openClient("test-va-restricted", TEST_PASSWORD); // only allowed on mock-1

  for (const type of ["switch_to_ai", "takeover", "emergency_stop"]) {
    client.send({ type, deviceId: "mock-2" });
    const err = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-2");
    assert.match(err.message, /not authorized/);
  }
});
