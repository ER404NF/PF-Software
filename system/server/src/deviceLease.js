// Per-device controller-mode registry: applies controllerMode.js's rules to
// real devices, and owns the async handoff sequencing between Human and AI
// control. This is the "exclusive input lease" Architecture Baseline.md §2
// describes — exactly one of a human or an AI worker may act on a device at
// a time, enforced here rather than left to convention.
//
// The bounded MS8 worker plugs into this module via registerPendingAiAction;
// the production research runner owns queue subscription and task looping.
// Nothing here performs AI reasoning or actions
// itself (Architecture Baseline.md §2: device adapters, and by extension this
// control-plane layer, execute primitives — they don't decide what to do).

import { MODES, nextMode } from "./controllerMode.js";

const registry = new Map(); // deviceId -> { mode, pendingAiAction: Promise|null }

function entry(deviceId) {
  if (!registry.has(deviceId)) registry.set(deviceId, { mode: MODES.HUMAN, pendingAiAction: null, token: Symbol("lease") });
  return registry.get(deviceId);
}

function getMode(deviceId) {
  return entry(deviceId).mode;
}

function canHumanSelect(deviceId) {
  return getMode(deviceId) === MODES.HUMAN && !entry(deviceId).pendingAiAction;
}

function getAiToken(deviceId) {
  return entry(deviceId).token;
}

function canAiAct(deviceId, token) {
  return getMode(deviceId) === MODES.AI_RUNNING && (token === undefined || token === getAiToken(deviceId));
}

function applyEvent(deviceId, event) {
  const e = entry(deviceId);
  const next = nextMode(e.mode, event);
  if (!next) throw new Error(`Illegal controller-mode transition: ${e.mode} + ${event} (device ${deviceId})`);
  e.token = Symbol("lease");
  e.mode = next;
  return next;
}

// A future real AI worker calls this before every device action, so a human
// takeover mid-action knows what to wait for. Overwrites any previous value
// deliberately — only the most recent in-flight action is ever relevant.
function registerPendingAiAction(deviceId, promise) {
  entry(deviceId).pendingAiAction = promise;
}

// Conditional clear prevents an older action's finally block from erasing a
// newer action that started on the same device before the older callback ran.
function clearPendingAiAction(deviceId, promise) {
  const e = entry(deviceId);
  if (e.pendingAiAction === promise) e.pendingAiAction = null;
}

// Stop new input immediately, retaining exclusive ownership until the
// submitted action settles. No timeout may silently grant overlapping input.
function finishAiTask(deviceId) {
  const e = entry(deviceId);
  if (!e.pendingAiAction) {
    applyEvent(deviceId, "TASK_FINISHED");
    return null;
  }
  if (e.mode === MODES.AI_RUNNING) applyEvent(deviceId, "PAUSE_TASK");
  else e.token = Symbol("lease");
  const token = e.token;
  const pending = e.pendingAiAction;
  return pending.catch(() => {}).then(() => {
    clearPendingAiAction(deviceId, pending);
    if (e.token !== token) return;
    applyEvent(deviceId, "TASK_FINISHED");
  });
}

function hasPendingAiAction(deviceId) { return !!entry(deviceId).pendingAiAction; }

function switchToAI(deviceId) {
  if (hasPendingAiAction(deviceId)) throw new Error("Device input is still draining");
  applyEvent(deviceId, "SWITCH_TO_AI"); // HUMAN -> HANDOFF
  applyEvent(deviceId, "HANDOFF_TO_AI_COMPLETE"); // HANDOFF -> AI_IDLE
  return getMode(deviceId);
}

// The graceful path (Architecture Baseline.md §4 "Switch to Human VA Mode"):
// block new AI actions immediately — the mode leaves AI_RUNNING/AI_IDLE the
// instant this is called, so canAiAct() already returns false before we
// await anything — then wait (bounded) for whatever action was already in
// flight, so the device isn't left mid-gesture when a human takes over.
async function switchToHuman(deviceId, { timeoutMs = 5000 } = {}) {
  const e = entry(deviceId);
  if (e.mode === MODES.HUMAN) return MODES.HUMAN;
  if (e.handoff?.token === e.token) return e.handoff.promise;

  applyEvent(deviceId, "SWITCH_TO_HUMAN");
  const token = e.token;
  const pending = e.pendingAiAction;
  const handoff = { token, promise: null };
  handoff.promise = (async () => {
    let timer;
    try {
      if (pending) {
        const settled = pending.then(() => true, () => true);
        const finished = await Promise.race([
          settled,
          new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
        if (!finished && e.token === token) {
          e.mode = MODES.ERROR;
          void settled.then(() => {
            if (e.token !== token || e.mode !== MODES.ERROR) return;
            clearPendingAiAction(deviceId, pending);
            applyEvent(deviceId, "RECOVER");
          });
          throw new Error("Handoff timed out; device input is still pending");
        }
      }
      // Emergency stop or another mode change can supersede this handoff.
      if (e.token !== token) return e.mode;
      e.pendingAiAction = null;
      applyEvent(deviceId, "HANDOFF_TO_HUMAN_COMPLETE");
      return MODES.HUMAN;
    } finally {
      clearTimeout(timer);
    }
  })();
  e.handoff = handoff;
  try { return await handoff.promise; }
  finally { if (e.handoff === handoff) e.handoff = null; }
}

// The one operation that must never wait on anything, from any state,
// including a hung pending action that will never resolve on its own —
// that's the entire point of an emergency stop.
function emergencyStop(deviceId) {
  applyEvent(deviceId, "EMERGENCY_STOP");
  const pending = entry(deviceId).pendingAiAction;
  if (pending) void pending.then(() => {}, () => {}).then(() => clearPendingAiAction(deviceId, pending));
  return MODES.HUMAN;
}

function markError(deviceId) {
  entry(deviceId).token = Symbol("lease");
  entry(deviceId).mode = MODES.ERROR; // direct set: a fault can happen from any state, including ones without a FAULT transition listed
}

function recoverFromError(deviceId) {
  return applyEvent(deviceId, "RECOVER");
}

// Test-only: clears all tracked state so one test's devices don't leak mode
// into the next.
function reset() {
  registry.clear();
}

export {
  MODES,
  getMode,
  canHumanSelect,
  canAiAct,
  getAiToken,
  finishAiTask,
  hasPendingAiAction,
  applyEvent,
  registerPendingAiAction,
  clearPendingAiAction,
  switchToAI,
  switchToHuman,
  emergencyStop,
  markError,
  recoverFromError,
  reset,
};
