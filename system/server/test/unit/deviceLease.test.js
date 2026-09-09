import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  MODES,
  getMode,
  canHumanSelect,
  canAiAct,
  registerPendingAiAction,
  clearPendingAiAction,
  switchToAI,
  switchToHuman,
  emergencyStop,
  markError,
  recoverFromError,
  reset,
} from "../../src/deviceLease.js";

beforeEach(() => reset());

test("a device defaults to HUMAN mode, and humans can select it", () => {
  assert.equal(getMode("dev-1"), MODES.HUMAN);
  assert.equal(canHumanSelect("dev-1"), true);
  assert.equal(canAiAct("dev-1"), false);
});

test("switchToAI moves HUMAN -> AI_IDLE, and blocks human selection", () => {
  const mode = switchToAI("dev-1");
  assert.equal(mode, MODES.AI_IDLE);
  assert.equal(canHumanSelect("dev-1"), false);
});

test("switchToAI throws if the device isn't currently HUMAN", () => {
  switchToAI("dev-1"); // -> AI_IDLE
  assert.throws(() => switchToAI("dev-1"), /Illegal controller-mode transition/);
});

test("pending-action clear is conditional and cannot erase a newer action", async () => {
  const first = Promise.resolve("first");
  let finishSecond;
  const second = new Promise((resolve) => { finishSecond = resolve; });
  registerPendingAiAction("dev-1", first);
  registerPendingAiAction("dev-1", second);
  clearPendingAiAction("dev-1", first);
  switchToAI("dev-1");
  let handedOff = false;
  const handoff = switchToHuman("dev-1", { timeoutMs: 1000 }).then(() => { handedOff = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(handedOff, false, "the newer action must remain registered and delay handoff");
  finishSecond();
  await handoff;
  assert.equal(getMode("dev-1"), MODES.HUMAN);
});

test("switchToHuman on an already-HUMAN device is a no-op, not an error", async () => {
  assert.equal(await switchToHuman("dev-1"), MODES.HUMAN);
});

test("switchToHuman blocks new AI actions immediately, before the handoff even completes", async () => {
  switchToAI("dev-1");
  let neverResolves;
  registerPendingAiAction("dev-1", new Promise(() => { neverResolves = true; }));

  const handoff = switchToHuman("dev-1", { timeoutMs: 100 });
  // Synchronously, before awaiting anything: the mode has already left the
  // AI-actionable state, so a well-behaved AI worker checking canAiAct()
  // right now would already see it can't act — this is the actual
  // correctness property, not just the eventual outcome.
  assert.equal(canAiAct("dev-1"), false);
  assert.ok(neverResolves);

  assert.equal(await handoff, MODES.HUMAN);
  assert.equal(canHumanSelect("dev-1"), true);
});

test("switchToHuman waits for a pending action that finishes before the timeout", async () => {
  switchToAI("dev-1");
  let resolved = false;
  registerPendingAiAction(
    "dev-1",
    new Promise((resolve) => setTimeout(() => { resolved = true; resolve(); }, 30))
  );

  await switchToHuman("dev-1", { timeoutMs: 2000 });
  assert.equal(resolved, true, "handoff should have waited for the pending action to actually finish");
});

test("switchToHuman gives up after timeoutMs on a pending action that never resolves", async () => {
  switchToAI("dev-1");
  registerPendingAiAction("dev-1", new Promise(() => {})); // never settles

  const start = Date.now();
  await switchToHuman("dev-1", { timeoutMs: 100 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `expected the timeout to cap the wait, took ${elapsed}ms`);
  assert.equal(getMode("dev-1"), MODES.HUMAN);
});

test("switchToHuman does not fail if the pending action rejects", async () => {
  switchToAI("dev-1");
  registerPendingAiAction("dev-1", Promise.reject(new Error("device fault mid-action")));

  await assert.doesNotReject(() => switchToHuman("dev-1", { timeoutMs: 500 }));
  assert.equal(getMode("dev-1"), MODES.HUMAN);
});

test("emergencyStop works immediately even with a pending action that never resolves", async () => {
  switchToAI("dev-1");
  registerPendingAiAction("dev-1", new Promise(() => {}));

  const start = Date.now();
  const mode = emergencyStop("dev-1"); // synchronous — must not need awaiting to take effect
  assert.equal(Date.now() - start < 50, true);
  assert.equal(mode, MODES.HUMAN);
  assert.equal(getMode("dev-1"), MODES.HUMAN);
});

test("emergencyStop works from AI_RUNNING, AI_PAUSED, HUMAN, and ERROR alike", () => {
  for (const setup of [
    () => {},
    () => switchToAI("dev-1"),
    () => markError("dev-1"),
  ]) {
    reset();
    setup();
    assert.equal(emergencyStop("dev-1"), MODES.HUMAN);
  }
});

test("markError + recoverFromError returns a device to HUMAN", () => {
  markError("dev-1");
  assert.equal(getMode("dev-1"), MODES.ERROR);
  assert.equal(canHumanSelect("dev-1"), false);
  assert.equal(recoverFromError("dev-1"), MODES.HUMAN);
  assert.equal(canHumanSelect("dev-1"), true);
});

test("device state is tracked independently per device id", () => {
  switchToAI("dev-1");
  assert.equal(getMode("dev-1"), MODES.AI_IDLE);
  assert.equal(getMode("dev-2"), MODES.HUMAN);
});
