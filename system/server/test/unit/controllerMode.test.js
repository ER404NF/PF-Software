import { test } from "node:test";
import assert from "node:assert/strict";
import { MODES, TRANSITIONS, nextMode } from "../../src/controllerMode.js";

const ALL_MODES = Object.values(MODES);
const ALL_EVENTS = [
  "SWITCH_TO_AI",
  "SWITCH_TO_HUMAN",
  "HANDOFF_TO_AI_COMPLETE",
  "HANDOFF_TO_HUMAN_COMPLETE",
  "START_TASK",
  "TASK_FINISHED",
  "PAUSE_TASK",
  "RESUME_TASK",
  "EMERGENCY_STOP",
  "FAULT",
  "RECOVER",
];

test("every (mode, event) pair is either a documented legal transition or explicitly rejected", () => {
  for (const mode of ALL_MODES) {
    for (const event of ALL_EVENTS) {
      const result = nextMode(mode, event);
      const documented = TRANSITIONS[mode]?.[event] ?? null;
      assert.equal(result, documented, `nextMode(${mode}, ${event})`);
      // The two things this guarantees together: nextMode never invents a
      // transition the table doesn't list, and every entry the table does
      // list is honored exactly.
    }
  }
});

test("EMERGENCY_STOP is legal from every single state", () => {
  for (const mode of ALL_MODES) {
    assert.equal(nextMode(mode, "EMERGENCY_STOP"), MODES.HUMAN, `EMERGENCY_STOP from ${mode}`);
  }
});

test("an unknown event from a known state is illegal, not a crash", () => {
  assert.equal(nextMode(MODES.HUMAN, "NOT_A_REAL_EVENT"), null);
});

test("any event from an unknown/garbage mode is illegal", () => {
  assert.equal(nextMode("NOT_A_REAL_MODE", "SWITCH_TO_AI"), null);
});

test("the normal human -> AI -> human round trip is exactly two hops each way", () => {
  let mode = MODES.HUMAN;
  mode = nextMode(mode, "SWITCH_TO_AI");
  assert.equal(mode, MODES.HANDOFF);
  mode = nextMode(mode, "HANDOFF_TO_AI_COMPLETE");
  assert.equal(mode, MODES.AI_IDLE);

  mode = nextMode(mode, "START_TASK");
  assert.equal(mode, MODES.AI_RUNNING);

  mode = nextMode(mode, "SWITCH_TO_HUMAN");
  assert.equal(mode, MODES.HANDOFF);
  mode = nextMode(mode, "HANDOFF_TO_HUMAN_COMPLETE");
  assert.equal(mode, MODES.HUMAN);
});

test("a paused task can finish without ever resuming, freeing the device to AI_IDLE", () => {
  assert.equal(nextMode(MODES.AI_PAUSED, "TASK_FINISHED"), MODES.AI_IDLE);
});

test("HUMAN cannot jump directly to an AI_* state, skipping HANDOFF", () => {
  assert.equal(nextMode(MODES.HUMAN, "HANDOFF_TO_AI_COMPLETE"), null);
  assert.equal(nextMode(MODES.HUMAN, "START_TASK"), null);
});

test("ERROR only recovers to HUMAN, never straight back into an AI state", () => {
  assert.equal(nextMode(MODES.ERROR, "RECOVER"), MODES.HUMAN);
  assert.equal(nextMode(MODES.ERROR, "START_TASK"), null);
  assert.equal(nextMode(MODES.ERROR, "SWITCH_TO_HUMAN"), null);
});

test("AI_IDLE cannot act on a device directly (must reach AI_RUNNING first)", () => {
  // There is no device-action-relevant event from this state other than the
  // ones that change mode — this documents that expectation structurally
  // rather than leaving it implicit. AI_PAUSED is *not* included here: a
  // paused task can validly finish (be stopped/cancelled) without ever
  // resuming, which is exactly what TASK_FINISHED from AI_PAUSED means —
  // see the dedicated test for that transition above.
  assert.equal(nextMode(MODES.AI_IDLE, "TASK_FINISHED"), null);
});
