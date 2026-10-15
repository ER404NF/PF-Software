import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createNotificationDrainLoop } from "../../src/notificationDrainLoop.js";

test("the recurring loop drains local and cloud outboxes without overlapping", async () => {
  let tick;
  let cleared = false;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const local = { drain: async () => { calls.push("local"); await pending; } };
  const cloud = { drain: async () => { calls.push("cloud"); await pending; } };
  const loop = createNotificationDrainLoop({
    targets: [{ name: "local", outbox: local }, { name: "cloud", outbox: cloud }],
    intervalMs: 50,
    setIntervalFn: callback => { tick = callback; return { unref() {} }; },
    clearIntervalFn: () => { cleared = true; },
  });
  loop.start();
  assert.equal(loop.running(), true);
  tick();
  tick();
  assert.deepEqual(calls, ["local", "cloud"], "ticks share the in-flight drain");
  release();
  await loop.drain();
  await loop.stop();
  assert.equal(cleared, true);
  assert.equal(loop.running(), false);
});

test("one target failure is contained and later ticks keep draining", async () => {
  let tick;
  const failures = [];
  let cloudCalls = 0;
  const loop = createNotificationDrainLoop({
    targets: [
      { name: "local", outbox: { drain: async () => { throw new Error("private transport detail"); } } },
      { name: "cloud", outbox: { drain: async () => { cloudCalls += 1; } } },
    ],
    intervalMs: 10,
    setIntervalFn: callback => { tick = callback; return {}; },
    clearIntervalFn() {},
    onFailure: name => failures.push(name),
  });
  loop.start();
  await loop.drain();
  tick();
  await loop.drain();
  assert.deepEqual(failures, ["local", "local"]);
  assert.equal(cloudCalls, 2);
  await loop.stop();
});

test("the relay wires both local and cloud outboxes into the stoppable recurring loop", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../../src/index.js", import.meta.url)), "utf8");
  assert.match(source, /notificationDrainTargets = \[\{ name: "account", outbox: accountNotificationOutbox \}\]/);
  assert.match(source, /notificationDrainTargets\.push\(\{ name: "cloud", outbox: cloudNotificationOutbox \}\)/);
  assert.match(source, /createNotificationDrainLoop\(\{[\s\S]*targets: notificationDrainTargets/);
  assert.match(source, /notificationDrainLoop\?\.stop\?\.\(\)/);
});
