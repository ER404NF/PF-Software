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
process.env.FILE_STORE_DIR = path.join(tmpStorageRoot, "files");
process.env.SESSION_STORE_DIR = path.join(tmpStorageRoot, "sessions");
process.env.AUDIT_LOG_PATH = path.join(tmpStorageRoot, "audit.log");
process.env.QUEUE_STORE_PATH = path.join(tmpStorageRoot, "tasks.json");
process.env.MODEL_SELECTION_STORE_PATH = path.join(tmpStorageRoot, "model-selections.json");
process.env.ASSIGNMENT_STORE_PATH = path.join(tmpStorageRoot, "assignments.json");

const { server, wss, devices, deviceHealth, deviceLease, taskQueue, assignmentStore } = await import("../../src/index.js");
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
async function openClient(username = "test-va", password = TEST_PASSWORD, existingCookie = null) {
  const cookie = existingCookie ?? await loginCookie(username, password);
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
    cookie, ws,
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
    role: "va",
  });
  operators.set("test-admin-restricted", {
    username: "test-admin-restricted",
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
  operators.delete("test-admin-restricted");
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
  for (const device of devices.values()) device.status = "idle";
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

  const busyList = await b.waitUntil((m) => m.type === "device_list"
    && m.devices.find((d) => d.id === "mock-2")?.accessState === "in_use");
  const busySummary = busyList.devices.find((d) => d.id === "mock-2");
  assert.equal(busySummary.canOpen, false);
  assert.match(busySummary.openReason, /in use/);

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
    ["window-size", "tap", "screenshot", "window-size", "tap", "screenshot"]
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

test("3 consecutive failures flip the device offline and release the human claim", async () => {
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
  const offlineSummary = offlineList.devices.find((d) => d.id === "test-wda");
  assert.equal(offlineSummary.status, "offline");
  assert.equal(offlineSummary.canOpen, false);
  assert.equal(offlineSummary.accessState, "offline");

  await fetch(`${FAKE_WDA_URL}/debug/unhang`, { method: "POST" });
  client.send({ type: "tap", x: 0.3, y: 0.3 });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(devices.get("test-wda").status, "offline", "input after the release cannot revive the device");
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
  const profile = await me.json();
  assert.equal(profile.username, "test-va");
  assert.equal(profile.role, "admin");
  assert.equal(profile.allowedDevices, null);
  assert.ok(profile.capabilities.includes("users:manage"));

  const logout = await fetch(`${httpUrl}/api/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);

  const meAfter = await fetch(`${httpUrl}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(meAfter.status, 401);
});

test("presence API and broadcasts expose safe live status, phone activity, and logout cleanup", async () => {
  const username = "presence-va";
  operators.set(username, {
    username,
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: ["mock-2"],
    allowedResearchWorkspaces: ["private-workspace"],
    role: "va",
  });

  const observer = await openClient("test-va", TEST_PASSWORD);
  const cookie = await loginCookie(username, TEST_PASSWORD);
  const client = await openClient(username, TEST_PASSWORD, cookie);
  try {
    const online = await observer.waitForNext((message) => message.type === "presence_list"
      && message.people.some(person => person.username === username && person.online));
    const publicPerson = online.people.find(person => person.username === username);
    assert.equal(publicPerson.role, "va");
    assert.equal(publicPerson.activeSessions, 1);
    for (const privateField of ["passwordHash", "allowedDevices", "allowedResearchWorkspaces", "sessionId"]) {
      assert.equal(privateField in publicPerson, false);
    }

    const response = await fetch(`${httpUrl}/api/people`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const directoryPerson = (await response.json()).people.find(person => person.username === username);
    assert.equal(directoryPerson.online, true);

    client.send({ type: "select_device", deviceId: "mock-2" });
    await client.waitForNext(message => message.type === "frame" && message.deviceId === "mock-2");
    const controlling = await observer.waitForNext((message) => message.type === "presence_list"
      && message.people.some(person => person.username === username
        && person.currentPhones?.some(phone => phone.id === "mock-2")));
    assert.equal(
      controlling.people.find(person => person.username === username).activityCategory,
      "device-control"
    );

    const logout = await fetch(`${httpUrl}/api/logout`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(logout.status, 200);
    const offline = await observer.waitForNext((message) => message.type === "presence_list"
      && message.people.some(person => person.username === username && !person.online));
    const loggedOutPerson = offline.people.find(person => person.username === username);
    assert.deepEqual(loggedOutPerson.currentPhones, []);
    assert.equal(loggedOutPerson.activeSessions, 0);
  } finally {
    client.ws.close();
    observer.ws.close();
    operators.delete(username);
  }
});

test("people directory requires authentication", async () => {
  const response = await fetch(`${httpUrl}/api/people`);
  assert.equal(response.status, 401);
});

test("durable assignments enforce role, identity, resource, visibility, and immutable-history boundaries", async () => {
  const records = [
    ["assignment-manager", "manager", ["mock-1"]],
    ["assignment-worker", "editor", ["mock-1"]],
    ["assignment-worker-2", "va", ["mock-1"]],
    ["assignment-outsider", "va", ["mock-2"]],
  ];
  for (const [username, role, allowedDevices] of records) {
    operators.set(username, {
      username,
      role,
      allowedDevices,
      allowedResearchWorkspaces: [],
      passwordHash: hashPassword(TEST_PASSWORD),
    });
  }
  const cookies = Object.fromEntries(await Promise.all(records.map(async ([username]) => [
    username, await loginCookie(username, TEST_PASSWORD),
  ])));
  const jsonRequest = (url, cookie, method = "GET", body) => fetch(`${httpUrl}${url}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    assert.equal((await jsonRequest("/api/assignments", null)).status, 401);
    assert.equal((await jsonRequest("/api/assignments", cookies["assignment-worker"], "POST", {
      assignee: "assignment-worker", instructions: "Unauthorized creation",
    })).status, 403);
    assert.equal((await jsonRequest("/api/assignments", cookies["assignment-manager"], "POST", {
      assignee: "assignment-worker", instructions: "Bad phone", deviceId: "missing-phone",
    })).status, 400);
    assert.equal((await jsonRequest("/api/assignments", cookies["assignment-manager"], "POST", {
      assignee: "assignment-outsider", instructions: "Wrong worker scope", deviceId: "mock-1",
    })).status, 403);
    assert.equal((await jsonRequest("/api/assignments", cookies["assignment-manager"], "POST", {
      assignee: "test-va", instructions: "Manager cannot assign an admin",
    })).status, 403);

    const createdResponse = await jsonRequest("/api/assignments", cookies["assignment-manager"], "POST", {
      assignee: "assignment-worker", instructions: "  Review the device export  ", deviceId: "mock-1",
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).assignment;
    assert.equal(created.instructions, "Review the device export");
    assert.equal(created.createdBy, "assignment-manager");
    assert.equal(created.history[0].actor, "assignment-manager");

    const workerList = await jsonRequest("/api/assignments", cookies["assignment-worker"]);
    assert.ok((await workerList.json()).assignments.some(item => item.id === created.id));
    const outsiderList = await jsonRequest("/api/assignments", cookies["assignment-outsider"]);
    assert.equal((await outsiderList.json()).assignments.some(item => item.id === created.id), false);
    assert.equal((await jsonRequest(`/api/assignments/${created.id}`, cookies["assignment-outsider"], "PATCH", {
      status: "in_progress",
    })).status, 403);

    const workerStatusResponse = await jsonRequest(`/api/assignments/${created.id}`, cookies["assignment-worker"], "PATCH", {
      status: "in_progress",
    });
    assert.equal(workerStatusResponse.status, 403, "non-management roles cannot mutate assignment state");
    const startedResponse = await jsonRequest(`/api/assignments/${created.id}`, cookies["assignment-manager"], "PATCH", {
      status: "in_progress",
    });
    assert.equal(startedResponse.status, 200);
    assert.equal((await startedResponse.json()).assignment.history.at(-1).actor, "assignment-manager");
    assert.equal((await jsonRequest(`/api/assignments/${created.id}`, cookies["assignment-worker"], "PATCH", {
      assignee: "assignment-worker-2",
    })).status, 403);
    assert.equal((await jsonRequest(`/api/assignments/${created.id}`, cookies["assignment-manager"], "PATCH", {
      assignee: "assignment-outsider",
    })).status, 403);

    const movedResponse = await jsonRequest(`/api/assignments/${created.id}`, cookies["assignment-manager"], "PATCH", {
      assignee: "assignment-worker-2",
    });
    assert.equal(movedResponse.status, 200);
    const moved = (await movedResponse.json()).assignment;
    assert.equal(moved.assignee, "assignment-worker-2");
    assert.equal(moved.status, "assigned");
    assert.equal(moved.history.at(-1).action, "reassigned");

    const scheduledResponse = await jsonRequest("/api/assignments", cookies["assignment-manager"], "POST", {
      assignee: "assignment-worker", instructions: "Scheduled review", deviceId: "mock-1",
      startAt: "2099-01-01T10:00:00.000Z", endAt: "2099-01-01T11:00:00.000Z", exclusive: true,
    });
    assert.equal(scheduledResponse.status, 201);
    const scheduled = (await scheduledResponse.json()).assignment;
    const overlap = await jsonRequest("/api/assignments", cookies["assignment-manager"], "POST", {
      assignee: "assignment-worker-2", instructions: "Conflicting slot", deviceId: "mock-1",
      startAt: "2099-01-01T10:30:00.000Z", endAt: "2099-01-01T11:30:00.000Z", exclusive: true,
    });
    assert.equal(overlap.status, 409);
    assert.equal((await jsonRequest(`/api/assignments/${scheduled.id}`, cookies["assignment-worker"], "PATCH", {
      startAt: "2099-01-01T12:00:00.000Z", endAt: "2099-01-01T13:00:00.000Z",
    })).status, 403);
    const rescheduledResponse = await jsonRequest(`/api/assignments/${scheduled.id}`, cookies["assignment-manager"], "PATCH", {
      startAt: "2099-01-01T12:00:00.000Z", endAt: "2099-01-01T13:00:00.000Z", exclusive: false,
    });
    assert.equal(rescheduledResponse.status, 200);
    const rescheduled = (await rescheduledResponse.json()).assignment;
    assert.equal(rescheduled.exclusive, false);
    assert.equal(rescheduled.history.at(-1).action, "rescheduled");
    assert.equal((await jsonRequest(`/api/assignments/${created.id}`, cookies["assignment-manager"], "DELETE")).status, 404);
  } finally {
    for (const [username] of records) operators.delete(username);
  }
});

test("VA profile is reported safely and normal device control remains permitted", async () => {
  const cookie = await loginCookie("test-plain-va", TEST_PASSWORD);
  const me = await fetch(`${httpUrl}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  const profile = await me.json();
  assert.equal(profile.username, "test-plain-va");
  assert.equal(profile.role, "va");
  assert.deepEqual(profile.allowedDevices, ["mock-1"]);
  assert.ok(profile.capabilities.includes("device:control"));
  assert.equal(profile.capabilities.includes("queue:manage"), false);
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
    [`${httpUrl}/api/admin/users`, {}],
    [`${httpUrl}/api/devices/mock-1/network-check`, { method: "POST" }],
    [`${httpUrl}/api/assignments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: vaCookie },
      body: JSON.stringify({ assignee: "test-plain-va", instructions: "forbidden VA mutation" }),
    }],
    [`${httpUrl}/api/queue/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: vaCookie },
      body: JSON.stringify({ text: "/queue list" }),
    }],
    [`${httpUrl}/api/queue/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: vaCookie },
      body: JSON.stringify({ text: "/model set fake --scope global" }),
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
    assert.match(err.message, /AI-controller management capability required/);
    assert.equal(deviceLease.getMode("mock-1"), "HUMAN");
  }

  for (const type of ["pause", "resume", "stop", "pause_task", "resume_task", "stop_task"]) {
    client.send({ type, deviceId: "mock-1" });
    const err = await client.waitForNext((m) => m.type === "error" && m.code === "capability_denied");
    assert.match(err.message, /Queue management capability required/);
  }
});

test("monitor contract is capability/device scoped and does not claim the input lease", async () => {
  const username = "monitor-manager";
  operators.set(username, {
    username,
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: ["mock-1"],
    role: "manager",
  });
  try {
    const managerCookie = await loginCookie(username, TEST_PASSWORD);
    const vaCookie = await loginCookie("test-plain-va", TEST_PASSWORD);
    const beforeMode = deviceLease.getMode("mock-1");
    const response = await fetch(`${httpUrl}/api/devices/mock-1/monitor`, { headers: { Cookie: managerCookie } });
    assert.equal(response.status, 200);
    const { monitor } = await response.json();
    assert.equal(monitor.available, false);
    assert.equal(monitor.readOnly, true);
    assert.equal(monitor.claimsInputLease, false);
    assert.equal(deviceLease.getMode("mock-1"), beforeMode);
    assert.equal((await fetch(`${httpUrl}/api/devices/mock-2/monitor`, { headers: { Cookie: managerCookie } })).status, 403);
    assert.equal((await fetch(`${httpUrl}/api/devices/mock-1/monitor`, { headers: { Cookie: vaCookie } })).status, 403);
    assert.equal((await fetch(`${httpUrl}/api/devices/mock-1/monitor`, {
      method: "POST", headers: { Cookie: managerCookie },
    })).status, 404, "there must be no fake start-monitor action before hardware validation");
  } finally {
    operators.delete(username);
  }

});

test("manager can perform an authorized operational handoff but remains device-scoped", async () => {
  const operator = operators.get("test-plain-va");
  operator.role = "manager";
  const client = await openClient("test-plain-va", TEST_PASSWORD);
  try {
    await client.waitFor((m) => m.type === "device_list");
    client.send({ type: "switch_to_ai", deviceId: "mock-1" });
    await client.waitForNext((m) => m.type === "device_list"
      && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "AI_IDLE");
    client.send({ type: "emergency_stop", deviceId: "mock-1" });
    await client.waitForNext((m) => m.type === "device_list"
      && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "HUMAN");

    client.send({ type: "switch_to_ai", deviceId: "mock-2" });
    const denied = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-2");
    assert.match(denied.message, /not authorized/);
  } finally {
    operator.role = "va";
    client.ws.close();
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
  assert.match(deniedFirst.message, /AI-controller management capability required/);

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
    assert.match(deniedAfterDemotion.message, /AI-controller management capability required/);
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
  const visible = await client.waitFor((m) => m.type === "device_list");
  assert.deepEqual(visible.devices.map(device => device.id).sort(), [...devices.keys()].sort());
  const assigned = visible.devices.find(device => device.id === "mock-1");
  const unassigned = visible.devices.find(device => device.id === "mock-2");
  assert.equal(assigned.assignedToViewer, true);
  assert.equal(assigned.canOpen, true);
  assert.equal(assigned.accessState, "assigned_available");
  assert.equal(unassigned.assignedToViewer, false);
  assert.equal(unassigned.canOpen, false);
  assert.equal(unassigned.accessState, "not_assigned");
  assert.equal(unassigned.assignment, null);
  assert.deepEqual(unassigned.authorizedOperators, []);
  assert.doesNotMatch(JSON.stringify(unassigned), /password|credential|token|secret/i);

  client.send({ type: "select_device", deviceId: "mock-2" });
  const err = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-2");
  assert.match(err.message, /not assigned/);

  client.send({ type: "select_device", deviceId: "mock-1" });
  const frame = await client.waitForNext((m) => m.type === "frame" && m.deviceId === "mock-1");
  assert.ok(frame);

  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );
});

test("a legacy VA with a null grant sees the safe fleet but cannot open any device", async () => {
  const username = "legacy-null-va";
  operators.set(username, {
    username,
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: null,
    role: "va",
  });
  try {
    const cookie = await loginCookie(username, TEST_PASSWORD);
    const profileResponse = await fetch(`${httpUrl}/api/me`, { headers: { Cookie: cookie } });
    const profile = await profileResponse.json();
    assert.deepEqual(profile.allowedDevices, []);
    assert.equal("passwordHash" in profile, false);

    const client = await openClient(username, TEST_PASSWORD, cookie);
    const list = await client.waitFor(message => message.type === "device_list");
    assert.equal(list.devices.length, devices.size);
    assert.equal(list.devices.every(device => device.assignedToViewer === false && device.canOpen === false), true);
    client.send({ type: "select_device", deviceId: "mock-1" });
    const denied = await client.waitForNext(message => message.type === "error" && message.deviceId === "mock-1");
    assert.equal(denied.code, "device_open_denied");
    assert.match(denied.message, /not assigned/);
  } finally {
    operators.delete(username);
  }
});

test("a durable task assignment alone never grants device access", async () => {
  const username = "task-only-va";
  operators.set(username, {
    username,
    passwordHash: hashPassword(TEST_PASSWORD),
    allowedDevices: [],
    role: "va",
  });
  assignmentStore.create({
    instructions: "Private task text must not appear in fleet summaries",
    assignee: username,
    createdBy: "test-va",
    deviceId: "mock-2",
  });
  try {
    const client = await openClient(username, TEST_PASSWORD);
    const list = await client.waitFor(message => message.type === "device_list");
    const summary = list.devices.find(device => device.id === "mock-2");
    assert.equal(summary.assignedToViewer, false);
    assert.equal(summary.canOpen, false);
    assert.equal(summary.assignment, null);
    assert.doesNotMatch(JSON.stringify(summary), /Private task text/);
    client.send({ type: "select_device", deviceId: "mock-2" });
    const denied = await client.waitForNext(message => message.type === "error" && message.deviceId === "mock-2");
    assert.match(denied.message, /not assigned/);
  } finally {
    operators.delete(username);
  }
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
  const aiSummary = aiList.devices.find((d) => d.id === "mock-1");
  assert.equal(aiSummary.controllerMode, "AI_IDLE");
  assert.equal(aiSummary.canOpen, false);
  assert.equal(aiSummary.accessState, "ai_controlled");

  client.send({ type: "select_device", deviceId: "mock-1" });
  const err = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-1");
  assert.match(err.message, /Human mode/);

  // Clean up via the real mechanism under test, not a direct reset — this
  // also doubles as the first half of the next test's scenario.
  client.send({ type: "takeover", deviceId: "mock-1" });
  await client.waitForNext((m) => m.type === "frame" && m.deviceId === "mock-1");
  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.status === "idle"
  );
  client.send({ type: "switch_to_ai", deviceId: "mock-1" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "AI_IDLE"
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
  client.send({ type: "switch_to_ai", deviceId: "mock-1" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "AI_IDLE"
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
  let finishPending;
  deviceLease.registerPendingAiAction("mock-2", new Promise(resolve => { finishPending = resolve; }));

  const start = Date.now();
  client.send({ type: "emergency_stop", deviceId: "mock-2" });
  const list = await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-2")?.controllerMode === "HUMAN"
  );
  assert.ok(Date.now() - start < 1000, "emergency_stop must not wait on the hung action");
  const mock2 = list.devices.find((d) => d.id === "mock-2");
  assert.equal(mock2.controllerMode, "HUMAN");
  assert.equal(mock2.status, "idle", "emergency_stop stops AI control but does not claim the device");

  // Immediate revocation must not grant input while the old action drains.
  client.send({ type: "select_device", deviceId: "mock-2" });
  await client.waitForNext(m => m.type === "error" && m.deviceId === "mock-2");
  finishPending();
  await new Promise(resolve => setImmediate(resolve));
  client.send({ type: "select_device", deviceId: "mock-2" });
  await client.waitForNext((m) => m.type === "frame" && m.deviceId === "mock-2");
  client.send({ type: "release_device" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-2")?.status === "idle"
  );
  client.send({ type: "switch_to_ai", deviceId: "mock-2" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-2")?.controllerMode === "AI_IDLE"
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

  const task = taskQueue.addTask({ goal: "emergency-stop regression check", createdBy: "test-va", deviceSelector: { deviceId: "mock-1" } });
  assert.equal(task.state, "RUNNING");

  client.send({ type: "emergency_stop", deviceId: "mock-1" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "HUMAN"
  );
  assert.equal(taskQueue.getTask(task.id).state, "CANCELLED");

  // Emergency stop is a durable Human-mode hold: new work can queue, but it
  // cannot silently retake the phone until an operator explicitly enables
  // AI mode again. This also proves there is no phantom RUNNING holder.
  const next = taskQueue.addTask({ goal: "wait for explicit AI enable", createdBy: "test-va", deviceSelector: { deviceId: "mock-1" } });
  assert.equal(next.state, "QUEUED");

  client.send({ type: "switch_to_ai", deviceId: "mock-1" });
  await client.waitForNext(
    (m) => m.type === "device_list" && m.devices.find((d) => d.id === "mock-1")?.controllerMode === "AI_RUNNING"
  );
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
  const client = await openClient("test-admin-restricted", TEST_PASSWORD); // only allowed on mock-1

  for (const type of ["switch_to_ai", "takeover", "emergency_stop"]) {
    client.send({ type, deviceId: "mock-2" });
    const err = await client.waitForNext((m) => m.type === "error" && m.deviceId === "mock-2");
    assert.match(err.message, /not authorized/);
  }
});

for (const action of [{ type: "tap", x: 0.2, y: 0.2 }, { type: "swipe", direction: "up" },
  { type: "home" }, { type: "type_text", text: "revoked" }]) {
  test(`revoked device access blocks ${action.type} on an existing selection`, async () => {
    const client = await openClient("test-va-restricted");
    const device = devices.get("mock-1");
    const method = { tap: "tap", swipe: "swipe", home: "pressHome", type_text: "typeText" }[action.type];
    const original = device[method];
    let calls = 0;
    try {
      client.send({ type: "select_device", deviceId: device.id });
      await client.waitFor(m => m.type === "frame");
      device[method] = () => { calls++; };
      operators.get("test-va-restricted").allowedDevices = [];
      const denied = client.waitForNext(m => m.type === "error");
      client.send(action);
      const error = await denied;
      assert.equal(error.code, "device_access_revoked");
      assert.match(error.message, /released/);
      assert.equal(calls, 0);
      await client.waitUntil(m => m.type === "device_list"
        && m.devices.find(d => d.id === device.id)?.status === "idle");
    } finally {
      device[method] = original;
      operators.get("test-va-restricted").allowedDevices = ["mock-1"];
      client.ws.close();
    }
  });
}

test("revocation during a pending action blocks the later render and queued input", async () => {
  const client = await openClient("test-va-restricted");
  const operator = operators.get("test-va-restricted");
  const device = devices.get("mock-1");
  const originalTap = device.tap;
  const originalHome = device.pressHome;
  let enterTap;
  let settleTap;
  const tapStarted = new Promise(resolve => { enterTap = resolve; });
  const tapPending = new Promise(resolve => { settleTap = resolve; });
  let homeCalls = 0;
  try {
    client.send({ type: "select_device", deviceId: device.id });
    await client.waitFor(message => message.type === "frame" && message.deviceId === device.id);
    const frameCount = client.received.filter(message => message.type === "frame").length;
    device.tap = async () => { enterTap(); await tapPending; };
    device.pressHome = () => { homeCalls++; };
    client.send({ type: "tap", deviceId: device.id, x: 0.2, y: 0.2 });
    await tapStarted;
    operator.allowedDevices = [];
    client.send({ type: "home", deviceId: device.id });
    settleTap();
    const denied = await client.waitForNext(message => message.code === "device_access_revoked");
    assert.match(denied.message, /released/);
    assert.equal(homeCalls, 0);
    assert.equal(client.received.filter(message => message.type === "frame").length, frameCount,
      "a revoked grant must block the render that would otherwise follow the pending tap");
    await client.waitUntil(message => message.type === "device_list"
      && message.devices.find(item => item.id === device.id)?.status === "idle");
  } finally {
    settleTap();
    device.tap = originalTap;
    device.pressHome = originalHome;
    operator.allowedDevices = ["mock-1"];
    client.close();
  }
});

for (const change of ["demoted", "removed"]) {
  test(`${change} operator cannot perform the next action and loses ownership`, async () => {
    const username = `operator-${change}`;
    const record = { username, passwordHash: hashPassword(TEST_PASSWORD), allowedDevices: ["mock-1"], role: "va" };
    operators.set(username, record);
    const client = await openClient(username);
    try {
      client.send({ type: "select_device", deviceId: "mock-1" });
      await client.waitFor(message => message.type === "frame" && message.deviceId === "mock-1");
      if (change === "demoted") record.role = "editor";
      else operators.delete(username);
      client.send({ type: "home", deviceId: "mock-1" });
      const denied = await client.waitForNext(message => message.code === "device_access_revoked");
      assert.match(denied.message, /released/);
      assert.equal(devices.get("mock-1").status, "idle");
    } finally {
      operators.delete(username);
      client.close();
    }
  });
}

test("human ownership survives an attempted admin takeover", async () => {
  const owner = await openClient();
  const contender = await openClient();
  const device = devices.get("mock-1");
  owner.send({ type: "select_device", deviceId: device.id });
  await owner.waitFor(m => m.type === "frame");
  const denied = contender.waitForNext(m => m.type === "error");
  contender.send({ type: "takeover", deviceId: device.id });
  assert.match((await denied).message, /already in use/);
  const released = owner.waitForNext(m => m.type === "device_list" && m.devices.find(d => d.id === device.id)?.status === "idle");
  owner.send({ type: "release_device", deviceId: device.id });
  await released;
});

test("three device failures mark it offline, release ownership, and block a new open", async () => {
  const owner = await openClient();
  const contender = await openClient();
  const device = devices.get("mock-1");
  const original = device.tap;
  try {
    owner.send({ type: "select_device", deviceId: device.id });
    await owner.waitFor(m => m.type === "frame");
    device.tap = () => { throw new Error("offline regression"); };
    for (let i = 0; i < 3; i++) {
      const failed = owner.waitForNext(m => m.type === "error");
      owner.send({ type: "tap", deviceId: device.id, x: 0.2, y: 0.2 });
      await failed;
    }
    assert.equal(device.status, "offline");
    const offlineList = await owner.waitUntil(m => m.type === "device_list"
      && m.devices.find(d => d.id === device.id)?.accessState === "offline");
    assert.equal(offlineList.devices.find(d => d.id === device.id).canOpen, false);
    for (const type of ["select_device", "takeover"]) {
      const denied = contender.waitForNext(m => m.type === "error");
      contender.send({ type, deviceId: device.id });
      assert.match((await denied).message, /offline/);
    }
  } finally {
    device.tap = original;
  }
});

test("logout closes all sockets for that session and releases its device only", async () => {
  const owner = await openClient();
  const sibling = await openClient("test-va", TEST_PASSWORD, owner.cookie);
  const independent = await openClient();
  owner.send({ type: "select_device", deviceId: "mock-1" });
  await owner.waitFor(m => m.type === "frame");
  const res = await fetch(`${httpUrl}/api/logout`, { method: "POST", headers: { Cookie: owner.cookie } });
  assert.equal(res.status, 200);
  await res.json();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.notEqual(owner.ws.readyState, WebSocket.OPEN);
  assert.notEqual(sibling.ws.readyState, WebSocket.OPEN);
  assert.equal(independent.ws.readyState, WebSocket.OPEN);
  assert.equal((await fetch(`${httpUrl}/api/me`, { headers: { Cookie: owner.cookie } })).status, 401);
  const frame = independent.waitForNext(m => m.type === "frame");
  independent.send({ type: "select_device", deviceId: "mock-1" });
  await frame;
  const released = independent.waitForNext(m => m.type === "device_list" && m.devices.find(d => d.id === "mock-1")?.status === "idle");
  independent.send({ type: "release_device" });
  await released;
});

for (const check of ["input", "heartbeat"]) {
test(`expired session is revoked on ${check}`, async () => {
  const client = await openClient();
  const device = devices.get("mock-1");
  const original = device.tap;
  let calls = 0;
  try {
    client.send({ type: "select_device", deviceId: device.id });
    await client.waitFor(m => m.type === "frame");
    device.tap = () => { calls++; };
    const sid = decodeURIComponent(client.cookie.split("=")[1]).slice(2).split(".")[0];
    const file = path.join(process.env.SESSION_STORE_DIR, `${sid}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.expires = stored.session.cookie.expires = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(stored));
    if (check === "input") client.send({ type: "tap", x: 0.2, y: 0.2 });
    else {
      const socket = [...wss.clients].find(ws => ws.sessionId === sid);
      assert.equal(await socket.validateSession(), false);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(calls, 0);
    assert.notEqual(client.ws.readyState, WebSocket.OPEN);
  } finally {
    device.tap = original;
    client.close();
  }
});

}

test("oversized messages close only the offending socket", async () => {
  const offender = await openClient();
  const healthy = await openClient();
  const closed = new Promise(resolve => offender.ws.once("close", resolve));
  offender.ws.send(Buffer.alloc(65537));
  await closed;
  assert.equal(healthy.ws.readyState, WebSocket.OPEN);
  assert.equal((await fetch(`${httpUrl}/api/me`, { headers: { Cookie: healthy.cookie } })).status, 200);
});

test("concurrent HTTP takeover commands finish without crashing", async () => {
  const cookie = await loginCookie("test-va", TEST_PASSWORD);
  deviceLease.switchToAI("mock-1");
  let finish;
  deviceLease.registerPendingAiAction("mock-1", new Promise(resolve => { finish = resolve; }));
  const command = () => fetch(`${httpUrl}/api/queue/command`, { method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ text: "/takeover mock-1" }) });
  try {
    const first = command();
    while (deviceLease.getMode("mock-1") !== "HANDOFF") await new Promise(resolve => setTimeout(resolve, 5));
    const second = command();
    await new Promise(resolve => setTimeout(resolve, 30));
    finish();
    for (const response of await Promise.all([first, second])) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).controllerMode, "HUMAN");
    }
  } finally { finish(); }
});

test("rejected HTTP commands return JSON without crashing", async () => {
  const cookie = await loginCookie("test-va", TEST_PASSWORD);
  const original = taskQueue.takeoverDevice;
  taskQueue.takeoverDevice = async () => { throw new Error("handoff unavailable"); };
  try {
    const response = await fetch(`${httpUrl}/api/queue/command`, { method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ text: "/takeover mock-1" }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /handoff unavailable/);
  } finally { taskQueue.takeoverDevice = original; }
});

test("rejected replacement upload preserves existing bytes and leaves no staging files", async () => {
  const cookie = await loginCookie("test-va", TEST_PASSWORD);
  const endpoint = `${httpUrl}/api/devices/mock-1/files`;
  async function upload(body, extra = false) {
    const form = new FormData();
    form.append("file", new Blob([body]), "original.txt");
    if (extra) form.append("unexpected", new Blob(["extra"]), "extra.txt");
    const response = await fetch(endpoint, { method: "POST", headers: { Cookie: cookie }, body: form });
    await response.json();
    return response.status;
  }
  assert.equal(await upload("original bytes"), 200);
  assert.equal(await upload("rejected replacement", true), 400);
  const download = await fetch(`${endpoint}/original.txt`, { headers: { Cookie: cookie } });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "original bytes");
  assert.deepEqual(fs.readdirSync(path.join(process.env.FILE_STORE_DIR, "devices", "mock-1")), ["original.txt"]);
  assert.equal(await upload("valid replacement"), 200);
  assert.equal(await (await fetch(`${endpoint}/original.txt`, { headers: { Cookie: cookie } })).text(), "valid replacement");
});

for (const failure of [false, true]) {
  test(`disconnect retains ownership until pending input settles (failure: ${failure})`, async () => {
    const owner = await openClient();
    const other = await openClient();
    const device = devices.get("mock-1");
    const original = device.tap;
    let settle, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { settle = resolve; });
    let active = 0, maximum = 0;
    device.tap = async () => {
      active++;
      maximum = Math.max(maximum, active);
      entered();
      try { await pending; if (failure) throw new Error("device failure"); }
      finally { active--; }
    };
    try {
      owner.send({ type: "select_device", deviceId: device.id });
      await owner.waitFor(m => m.type === "frame");
      owner.send({ type: "tap", x: 0.1, y: 0.1 });
      await started;
      const closed = new Promise(resolve => owner.ws.once("close", resolve));
      owner.close();
      await closed;
      const response = other.waitForNext(m => m.type === "error" || m.type === "frame");
      other.send({ type: "select_device", deviceId: device.id });
      const denied = await response;
      assert.equal(denied.type, "error");
      assert.match(denied.message, /already in use/);
      const released = other.waitForNext(m => m.type === "device_list" && m.devices.find(d => d.id === device.id)?.status === "idle");
      settle();
      await released;
      const frame = other.waitForNext(m => m.type === "frame");
      other.send({ type: "select_device", deviceId: device.id });
      await frame;
      const result = other.waitForNext(m => m.type === (failure ? "error" : "frame"));
      other.send({ type: "tap", x: 0.2, y: 0.2 });
      await result;
      assert.equal(maximum, 1);
    } finally {
      settle();
      device.tap = original;
      const released = other.waitForNext(m => m.type === "device_list" && m.devices.find(d => d.id === device.id)?.status === "idle").catch(() => {});
      other.send({ type: "release_device" });
      await released;
      other.close();
    }
  });
}

test("restricted admins cannot cancel, prioritize or reorder inaccessible tasks", async () => {
  const first = taskQueue.addTask({ goal: "restricted target", createdBy: "test-va", deviceSelector: { deviceId: "mock-2" } });
  const second = taskQueue.addTask({ goal: "queued target", createdBy: "test-va", deviceSelector: { deviceId: "mock-2" } });
  const cookie = await loginCookie("test-admin-restricted", TEST_PASSWORD);
  try {
    for (const text of [`/queue cancel ${first.id}`, `/queue priority ${first.id} high`, `/queue move ${first.id} before ${second.id}`]) {
      const response = await fetch(`${httpUrl}/api/queue/command`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /not authorized/);
    }
    assert.equal(first.state, "RUNNING");
    assert.equal(first.priority, "normal");
  } finally { taskQueue.cancelTask(second.id); taskQueue.cancelTask(first.id); }
});

test("reserved media names cannot replace session records through uploads", async () => {
  devices.set("sessions", { id: "sessions", label: "reserved", status: "idle" });
  const protectedFile = path.join(process.env.SESSION_STORE_DIR, "protected.json");
  fs.writeFileSync(protectedFile, "original session fixture");
  try {
    const cookie = await loginCookie("test-va", TEST_PASSWORD);
    const form = new FormData();
    form.append("file", new Blob(["replacement"]), "protected.json");
    const response = await fetch(`${httpUrl}/api/devices/sessions/files`, { method: "POST", headers: { Cookie: cookie }, body: form });
    assert.equal(response.status, 400);
    await response.json();
    assert.equal(fs.readFileSync(protectedFile, "utf8"), "original session fixture");
  } finally { devices.delete("sessions"); }
});
test("emergency stop bypasses an unrelated pending human input", async () => {
  const client = await openClient();
  const device = devices.get("mock-1"), original = device.tap;
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  device.tap = async () => { entered(); await pending; };
  try {
    client.send({ type: "select_device", deviceId: "mock-1" });
    await client.waitFor(m => m.type === "frame");
    deviceLease.switchToAI("mock-2"); deviceLease.applyEvent("mock-2", "START_TASK");
    client.send({ type: "tap", deviceId: "mock-1", x: 0.2, y: 0.2 });
    await started;
    const stopped = client.waitForNext(m => m.type === "device_list" && m.devices.find(d => d.id === "mock-2")?.controllerMode === "HUMAN");
    client.send({ type: "emergency_stop", deviceId: "mock-2" });
    await stopped;
    assert.equal(deviceLease.canAiAct("mock-2"), false);
  } finally {
    finish(); device.tap = original;
    const released = client.waitForNext(m => m.type === "device_list" && m.devices.find(d => d.id === "mock-1")?.status === "idle");
    client.send({ type: "release_device" }); await released;
  }
});
test("input scoped to a previously selected device is rejected", async () => {
  const client = await openClient();
  const device = devices.get("mock-1"), original = device.tap;
  let taps = 0;
  try {
    client.send({ type: "select_device", deviceId: "mock-1" });
    await client.waitFor(m => m.type === "frame");
    device.tap = async () => { taps++; };
    const denied = client.waitForNext(m => m.type === "error");
    client.send({ type: "tap", deviceId: "mock-2", x: 0.2, y: 0.2 });
    assert.match((await denied).message, /Stale/);
    assert.equal(taps, 0);
  } finally {
    device.tap = original;
    const released = client.waitForNext(m => m.type === "device_list" && m.devices.find(d => d.id === "mock-1")?.status === "idle");
    client.send({ type: "release_device" }); await released;
  }
});
