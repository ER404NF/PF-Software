import { test } from "node:test";
import assert from "node:assert/strict";
import { createPresenceStore } from "../../src/presenceStore.js";

const operators = [
  { username: "alice", role: "manager", passwordHash: "secret", allowedDevices: null },
  { username: "bob", role: "editor", passwordHash: "secret", allowedDevices: ["phone-2"] },
];

test("presence aggregates tabs and sessions without exposing private operator fields", () => {
  let time = Date.parse("2026-09-11T10:00:00.000Z");
  const store = createPresenceStore({ now: () => time, staleAfterMs: 45_000 });
  store.connect({ sessionId: "session-a", connectionId: "tab-a", username: "alice", expiresAt: time + 60_000 });
  store.connect({ sessionId: "session-a", connectionId: "tab-b", username: "alice", expiresAt: time + 60_000 });
  store.connect({ sessionId: "session-b", connectionId: "tab-c", username: "alice", expiresAt: time + 60_000 });
  store.setDevice("tab-a", "phone-1");
  store.setDevice("tab-c", "phone-2");

  const [alice, bob] = store.listPeople(operators);
  assert.deepEqual(alice, {
    username: "alice",
    role: "manager",
    online: true,
    lastSeenAt: "2026-09-11T10:00:00.000Z",
    activeSessions: 2,
    currentDeviceIds: ["phone-1", "phone-2"],
    activityCategory: "device-control",
  });
  assert.deepEqual(bob, {
    username: "bob", role: "editor", online: false, lastSeenAt: null,
    activeSessions: 0, currentDeviceIds: [], activityCategory: null,
  });
  assert.equal("passwordHash" in alice, false);
  assert.equal("allowedDevices" in alice, false);
  assert.equal("sessionId" in alice, false);
});

test("disconnect, logout, expiry, and stale heartbeat cleanup remove live presence", () => {
  let time = 1_000_000;
  const store = createPresenceStore({ now: () => time, staleAfterMs: 1_000 });
  store.connect({ sessionId: "session-a", connectionId: "tab-a", username: "alice", expiresAt: time + 10_000 });
  store.disconnect("tab-a");
  assert.equal(store.listPeople(operators)[0].online, false);

  store.connect({ sessionId: "session-b", connectionId: "tab-b", username: "alice", expiresAt: time + 500 });
  time += 501;
  assert.equal(store.listPeople(operators)[0].online, false);

  store.connect({ sessionId: "session-c", connectionId: "tab-c", username: "alice", expiresAt: time + 10_000 });
  assert.equal(store.removeSession("session-c"), true);
  assert.equal(store.listPeople(operators)[0].online, false);
});

test("one disconnected tab does not mark another tab or session offline", () => {
  const store = createPresenceStore({ now: () => 2_000_000 });
  store.connect({ sessionId: "session-a", connectionId: "tab-a", username: "alice", expiresAt: 3_000_000 });
  store.connect({ sessionId: "session-a", connectionId: "tab-b", username: "alice", expiresAt: 3_000_000 });
  store.disconnect("tab-a");
  const alice = store.listPeople(operators)[0];
  assert.equal(alice.online, true);
  assert.equal(alice.activeSessions, 1);
});
