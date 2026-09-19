// Verify-before-toggle idempotency (COMMAND_QUEUE_SPEC §10, roadmap MS9.2 / MS10.1).
//
// Save/like/vote/repost buttons are TOGGLES: pressing one twice undoes it. So a
// platform-visible action is never "just press the button". This engine reads the
// current state first, acts only if the state is positively different from what is
// wanted, verifies the result, and retries only when the state is positively
// UNCHANGED. If the state cannot be read it never acts and never retries blind,
// because a blind second press could reverse a change that actually took effect.
//
//   NOOP                 already in the wanted state; nothing was pressed
//   VERIFIED             pressed (once, or twice if the first did not take) and confirmed
//   AMBIGUOUS            the state could not be read; the caller must hand over to a human
//   FAILED_VERIFICATION  pressed the allowed number of times and it never took
//   BLOCKED              authorization was withdrawn (takeover, revoked access) before pressing

export const TOGGLE_OUTCOMES = Object.freeze({
  NOOP: "NOOP",
  VERIFIED: "VERIFIED",
  AMBIGUOUS: "AMBIGUOUS",
  FAILED_VERIFICATION: "FAILED_VERIFICATION",
  BLOCKED: "BLOCKED",
});

// desired: "on" | "off"
// readState(observation) -> "on" | "off" | "unknown"
// act() presses the control; reobserve() returns a fresh observation.
export async function idempotentToggle({
  desired, observation, readState, act, reobserve, canContinue = () => true, maxAttempts = 2,
} = {}) {
  if (desired !== "on" && desired !== "off") throw new TypeError('desired must be "on" or "off"');
  for (const [name, value] of Object.entries({ readState, act, reobserve })) {
    if (typeof value !== "function") throw new TypeError(`${name} is required`);
  }
  let before = readState(observation);
  if (before === "unknown") {
    const fresh = await reobserve(); // look again before deciding anything
    before = readState(fresh);
    if (before === "unknown") {
      return { outcome: TOGGLE_OUTCOMES.AMBIGUOUS, acted: 0, reason: "the current state could not be read, so nothing was pressed" };
    }
  }
  if (before === desired) return { outcome: TOGGLE_OUTCOMES.NOOP, acted: 0, before, after: before };

  let acted = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!canContinue()) return { outcome: TOGGLE_OUTCOMES.BLOCKED, acted, before, reason: "authorization was withdrawn before the action" };
    await act();
    acted += 1;
    let after = readState(await reobserve());
    if (after === "unknown") after = readState(await reobserve()); // one settle look
    if (after === desired) return { outcome: TOGGLE_OUTCOMES.VERIFIED, acted, before, after };
    if (after === "unknown") {
      return { outcome: TOGGLE_OUTCOMES.AMBIGUOUS, acted, before, reason: "the state was unreadable after pressing; not pressing again in case it took effect" };
    }
    // `after` is positively the old state: the press did not take, so trying again is safe.
  }
  return { outcome: TOGGLE_OUTCOMES.FAILED_VERIFICATION, acted, before, reason: `the state did not change after ${acted} attempt(s)` };
}
