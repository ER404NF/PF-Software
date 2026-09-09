// The per-device controller-mode state machine (Architecture Baseline.md §3).
// Pure and stateless on purpose — no device state lives here, just the rules
// for what transitions are legal. server/src/deviceLease.js is the stateful
// registry that actually applies these against real devices.
//
// Every device defaults to HUMAN and stays there unless something explicitly
// switches it — nothing about this module changes today's Human VA Mode
// behavior on its own.

const MODES = Object.freeze({
  HUMAN: "HUMAN",
  AI_IDLE: "AI_IDLE",
  AI_RUNNING: "AI_RUNNING",
  AI_PAUSED: "AI_PAUSED",
  HANDOFF: "HANDOFF",
  ERROR: "ERROR",
});

// state -> { event: nextState }. Anything not listed is an illegal
// transition — callers must check (nextMode returns null), never assume.
//
// EMERGENCY_STOP is valid from every state on purpose: CLAUDE.md §4 requires
// it be able to "revoke AI input immediately at the control-plane boundary,"
// which only means something if it can't itself be blocked by whatever state
// things happen to be stuck in.
const TRANSITIONS = Object.freeze({
  [MODES.HUMAN]: {
    SWITCH_TO_AI: MODES.HANDOFF,
    EMERGENCY_STOP: MODES.HUMAN, // no-op, but never an error to call
    FAULT: MODES.ERROR,
  },
  [MODES.HANDOFF]: {
    HANDOFF_TO_AI_COMPLETE: MODES.AI_IDLE,
    HANDOFF_TO_HUMAN_COMPLETE: MODES.HUMAN,
    EMERGENCY_STOP: MODES.HUMAN,
    FAULT: MODES.ERROR,
  },
  [MODES.AI_IDLE]: {
    START_TASK: MODES.AI_RUNNING,
    SWITCH_TO_HUMAN: MODES.HANDOFF,
    EMERGENCY_STOP: MODES.HUMAN,
    FAULT: MODES.ERROR,
  },
  [MODES.AI_RUNNING]: {
    TASK_FINISHED: MODES.AI_IDLE,
    PAUSE_TASK: MODES.AI_PAUSED,
    SWITCH_TO_HUMAN: MODES.HANDOFF,
    EMERGENCY_STOP: MODES.HUMAN,
    FAULT: MODES.ERROR,
  },
  [MODES.AI_PAUSED]: {
    RESUME_TASK: MODES.AI_RUNNING,
    // A paused task can still end (stopped, cancelled) without ever being
    // resumed — without this, the device would be stuck in AI_PAUSED with
    // no way back to AI_IDLE short of a full human handoff or emergency stop.
    TASK_FINISHED: MODES.AI_IDLE,
    SWITCH_TO_HUMAN: MODES.HANDOFF,
    EMERGENCY_STOP: MODES.HUMAN,
    FAULT: MODES.ERROR,
  },
  [MODES.ERROR]: {
    RECOVER: MODES.HUMAN,
    EMERGENCY_STOP: MODES.HUMAN,
  },
});

// Returns the next mode, or null if (mode, event) isn't a legal transition.
function nextMode(mode, event) {
  const forState = TRANSITIONS[mode];
  if (!forState || !(event in forState)) return null;
  return forState[event];
}

export { MODES, TRANSITIONS, nextMode };
