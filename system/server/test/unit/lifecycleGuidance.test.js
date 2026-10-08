import { test } from "node:test";
import assert from "node:assert/strict";
import { lifecycleGuidance } from "../../src/deviceProvisioner.js";
import { assertPlainOperatorText } from "../helpers/plainText.js";

const STATES = ["stopped", "starting", "restarting", "ready", "enabled", "failed", "detached"];

// state × running × in-use matrix: [state, anyRunning, inUse] → expected [canStart, canStop, canRestart]
const MATRIX = [
  ["stopped", false, false, [true, false, false]],
  ["starting", true, false, [false, true, false]],
  ["restarting", true, false, [false, true, false]],
  ["ready", true, false, [false, true, true]],
  ["enabled", true, false, [false, true, true]],
  ["failed", false, false, [true, true, true]],   // failed with nothing running: Start is allowed
  ["failed", true, false, [false, true, true]],   // failed but still running: use Restart
  ["detached", false, false, [false, true, false]],
  ["ready", true, true, [false, false, false]],   // a human is driving the phone
  ["failed", false, true, [true, false, false]],
  ["starting", true, true, [false, false, false]],
];

test("the enablement matrix", () => {
  for (const [state, anyRunning, inUse, [start, stop, restart]] of MATRIX) {
    const attached = state !== "detached";
    const g = lifecycleGuidance({ state, anyRunning, inUse, attached });
    assert.deepEqual([g.canStart, g.canStop, g.canRestart], [start, stop, restart], `${state} running=${anyRunning} inUse=${inUse}`);
  }
});

test("an unplugged phone that is in use can still be stopped (nobody can be driving it)", () => {
  const g = lifecycleGuidance({ state: "detached", attached: false, inUse: true });
  assert.equal(g.canStop, true);
  assert.equal(g.canStart, false);
});

test("every disabled button carries its exact plain reason, and enabled ones carry none", () => {
  const expect = {
    start: { stopped: null, starting: "Already running.", restarting: "Already running.", ready: "Already running.", enabled: "Already running.", detached: "Plug the phone in first." },
    stop: { stopped: "Already stopped.", starting: null, ready: null, failed: null },
    restart: { stopped: "Start it first.", starting: "Wait for it to finish starting.", restarting: "Wait for it to finish starting.", ready: null, detached: "Plug the phone in first." },
  };
  for (const [state, reason] of Object.entries(expect.start)) assert.equal(lifecycleGuidance({ state, anyRunning: true, attached: state !== "detached" }).startReason, reason, `start ${state}`);
  for (const [state, reason] of Object.entries(expect.stop)) assert.equal(lifecycleGuidance({ state, anyRunning: true }).stopReason, reason, `stop ${state}`);
  for (const [state, reason] of Object.entries(expect.restart)) assert.equal(lifecycleGuidance({ state, anyRunning: true, attached: state !== "detached" }).restartReason, reason, `restart ${state}`);
  assert.equal(lifecycleGuidance({ state: "failed", anyRunning: true }).startReason, "Control is running but not responding. Use Restart WDA.");
  const busy = lifecycleGuidance({ state: "ready", anyRunning: true, inUse: true });
  assert.equal(busy.stopReason, "Release the phone first.");
  assert.equal(busy.restartReason, "Release the phone first.");
});

test("a phone Bodun does not manage gets one explanation for all three", () => {
  const g = lifecycleGuidance({ managed: false });
  assert.deepEqual([g.canStart, g.canStop, g.canRestart], [false, false, false]);
  for (const reason of [g.startReason, g.stopReason, g.restartReason]) assert.equal(reason, "Bodun is not managing this phone's control service.");
});

test("all reason sentences are plain language", () => {
  for (const state of STATES) {
    for (const inUse of [false, true]) {
      for (const anyRunning of [false, true]) {
        const g = lifecycleGuidance({ state, anyRunning, inUse, attached: state !== "detached" });
        for (const reason of [g.startReason, g.stopReason, g.restartReason].filter(Boolean)) assertPlainOperatorText(reason, `${state} reason`);
      }
    }
  }
});
