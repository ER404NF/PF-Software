import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../../client/liveViewController.js", import.meta.url), "utf8");

function createHarness({ initiallyHidden = false, maxFailures = 3 } = {}) {
  let hidden = initiallyHidden;
  let inputPending = false;
  let nextTimerId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  const clearedIntervals = [];
  const sent = [];
  const statuses = [];
  const fatalErrors = [];
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const controller = new context.LiveViewController({
    intervalMs: 1000,
    requestTimeoutMs: 5000,
    maxFailures,
    sendRequest(message) { sent.push(message); return true; },
    isEligible(deviceId) { return deviceId === "wda-1"; },
    isHidden() { return hidden; },
    isInputPending() { return inputPending; },
    onStatus(label, state) { statuses.push({ label, state }); },
    onFatalError(message) { fatalErrors.push(message); },
    setIntervalFn(callback, delay) {
      const id = nextTimerId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearIntervalFn(id) { clearedIntervals.push(id); intervals.delete(id); },
    setTimeoutFn(callback, delay) {
      const id = nextTimerId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) { timeouts.delete(id); },
  });
  return {
    controller, intervals, timeouts, clearedIntervals, sent, statuses, fatalErrors,
    setHidden(value) { hidden = value; },
    setInputPending(value) { inputPending = value; },
  };
}

test("live polling starts at one second, refreshes after completion, and stops cleanly", () => {
  const harness = createHarness();
  assert.equal(harness.controller.start("wda-1"), true);
  assert.equal([...harness.intervals.values()][0].delay, 1000);
  assert.equal(harness.sent.length, 1, "start should request the first frame immediately");
  assert.equal(harness.sent[0].type, "refresh_live_frame");
  assert.equal(harness.sent[0].deviceId, "wda-1");
  assert.equal(harness.sent[0].requestId, 1);
  assert.equal(harness.controller.acceptFrame({ type: "live_frame", deviceId: "wda-1", requestId: 1 }), true);

  [...harness.intervals.values()][0].callback();
  assert.equal(harness.sent.length, 2);
  harness.controller.stop();
  assert.equal(harness.intervals.size, 0);
  assert.equal(harness.timeouts.size, 0);
  assert.equal(harness.clearedIntervals.length, 1);
  assert.equal(harness.controller.isActiveFor("wda-1"), false);
});

test("live polling never overlaps screenshot requests and reports delay", () => {
  const harness = createHarness();
  harness.controller.start("wda-1");
  assert.equal(harness.controller.tick(), false);
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.statuses.at(-1), { label: "Live delayed", state: "delayed" });

  harness.controller.acceptFrame({ deviceId: "wda-1", requestId: 1 });
  harness.setInputPending(true);
  assert.equal(harness.controller.tick(), false);
  assert.equal(harness.sent.length, 1, "polling must yield while a device command is pending");
  harness.setInputPending(false);
  assert.equal(harness.controller.tick(), true);
  assert.equal(harness.sent.length, 2);
});

test("hidden tabs pause polling and resume with an immediate refresh", () => {
  const harness = createHarness({ initiallyHidden: true });
  harness.controller.start("wda-1");
  assert.equal(harness.sent.length, 0);
  assert.deepEqual(harness.statuses.at(-1), { label: "Live paused", state: "paused" });

  harness.setHidden(false);
  harness.controller.visibilityChanged();
  assert.equal(harness.sent.length, 1);
  harness.setHidden(true);
  assert.equal(harness.controller.acceptFrame({ deviceId: "wda-1", requestId: 1 }), false,
    "a frame completed while hidden must not repaint the screen");
  assert.deepEqual(harness.statuses.at(-1), { label: "Live paused", state: "paused" });
  assert.equal(harness.controller.tick(), false);
  assert.equal(harness.sent.length, 1);
});

test("three repeated screenshot failures stop polling with a clear live error", () => {
  const harness = createHarness({ maxFailures: 3 });
  harness.controller.start("wda-1");
  for (let requestId = 1; requestId <= 3; requestId++) {
    harness.controller.acceptError({ deviceId: "wda-1", requestId, message: "WDA unavailable" });
    if (requestId < 3) harness.controller.tick();
  }
  assert.equal(harness.controller.isActiveFor("wda-1"), false);
  assert.equal(harness.intervals.size, 0);
  assert.deepEqual(harness.statuses.at(-1), { label: "Live error", state: "error" });
  assert.match(harness.fatalErrors[0], /stopped after 3 screenshot failures.*WDA unavailable/);
});
