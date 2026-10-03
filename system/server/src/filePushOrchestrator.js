// P4 build (docs/productionization/P4_DEVICE_PUSH_BUILD.md): drives
// filePushSkill.js's perceive -> plan -> act -> verify loop against a real
// (or fixture) device until the one-time download link actually finishes
// downloading, reporting one specific, per-file success/failure outcome —
// never a silent fire-and-forget, and never "we sent a tap and assumed it
// worked" (see filePushSkill.js's own header for why this can't be run
// through the shared executeSkillAction() engine).

import { captureObservation } from "./observationPackage.js";
import { createFilePushSkill, FILE_PUSH_STATES } from "./platformSkills/filePushSkill.js";
import { operationalErrorKind } from "./safeOperationalLog.js";

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const OBSERVATION_GOAL = "push a staged file to this phone via Safari";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// captureObservation() throws this exact message when its own canObserve()
// check fails — it re-checks internally on every call (twice per call: once
// before the UI-tree capture, once before the screenshot fallback), so this
// can surface from ANY observe() in the loop below, not just the first, and
// even from a canExecute() that only just turned false a moment ago. It must
// always be reported as a clean BLOCKED outcome, never routed into
// skill.recover() the way a real device/UI failure is.
const AUTHORIZATION_REVOKED_MESSAGE = "Observation authorization was revoked";
function isAuthorizationRevoked(error) {
  return error instanceof Error && error.message === AUTHORIZATION_REVOKED_MESSAGE;
}

// Returns one of: SUCCESS | FAILED | NEEDS_HUMAN | TIMED_OUT | BLOCKED — a
// caller (index.js's push route) turns this directly into a clear per-file
// result, never a generic 500 or a bare boolean.
export async function pushFileToDevice({
  device,
  url,
  skill = createFilePushSkill(),
  maxSteps = DEFAULT_MAX_STEPS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  canExecute = () => true,
  sleep = defaultSleep,
} = {}) {
  if (!device) throw new Error("pushFileToDevice requires a device");
  if (typeof url !== "string" || !url) throw new Error("pushFileToDevice requires a url");

  async function requireExecutionAuthorization() {
    if (!await canExecute()) throw new Error(AUTHORIZATION_REVOKED_MESSAGE);
  }

  async function observe() {
    return captureObservation(device, {
      goal: OBSERVATION_GOAL,
      canObserve: async () => {
        await requireExecutionAuthorization();
        return true;
      },
    });
  }

  let lastState = null;
  let steps = 0;

  try {
    let observation = await observe();

    for (; steps < maxSteps; steps += 1) {
      const state = await skill.detectState(observation);
      lastState = state;

      if (state === FILE_PUSH_STATES.DOWNLOAD_COMPLETE) return { outcome: "SUCCESS", state, steps };
      if (state === FILE_PUSH_STATES.ERROR) return { outcome: "FAILED", state, reason: "Safari reported an error", steps };

      // Purely passive: nothing to execute, just wait and look again.
      if (state === FILE_PUSH_STATES.DOWNLOAD_IN_PROGRESS) {
        await sleep(pollIntervalMs);
        observation = await observe();
        continue;
      }

      const available = await skill.availableActions(state);
      const action = available[0];
      if (!action) return { outcome: "FAILED", state, reason: `no available action from state "${state}"`, steps };

      try {
        await requireExecutionAuthorization();
        await skill.execute(action, { device, observation, url, authorize: requireExecutionAuthorization });
        observation = await observe();
        const verified = await skill.verify(action, observation, { state });
        if (verified?.outcome === "NEEDS_HUMAN") return { outcome: "NEEDS_HUMAN", state, reason: verified.reason, steps };
        if (!verified) {
          const recovery = await skill.recover(new Error(`${action} did not verify`), {
            device, state, authorize: requireExecutionAuthorization,
          });
          if (!recovery?.recovered) return { outcome: "FAILED", state, reason: `${action} did not verify, and recovery failed`, steps };
          observation = await observe();
        }
      } catch (error) {
        if (isAuthorizationRevoked(error)) throw error;
        const recovery = await skill.recover(error, { device, state, authorize: requireExecutionAuthorization });
        if (!recovery?.recovered) {
          return { outcome: "FAILED", state, reason: `device file-push action failed (${operationalErrorKind(error)})`, steps };
        }
        observation = await observe();
      }
    }
  } catch (error) {
    if (isAuthorizationRevoked(error)) return { outcome: "BLOCKED", state: lastState, reason: "device input authorization is no longer active", steps };
    throw error;
  }

  return {
    outcome: "TIMED_OUT",
    state: lastState,
    reason: `did not reach ${FILE_PUSH_STATES.DOWNLOAD_COMPLETE} within ${maxSteps} steps`,
    steps: maxSteps,
  };
}
