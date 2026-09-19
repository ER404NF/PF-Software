import { test } from "node:test";
import assert from "node:assert/strict";
import { idempotentToggle, TOGGLE_OUTCOMES } from "../../src/stateToggle.js";

// A tiny simulated control. `takes` decides whether a press actually changes the state.
function control({ state = "off", readings = null, takes = () => true } = {}) {
  const sim = { state, presses: 0, looks: 0 };
  const queue = readings ? [...readings] : null;
  sim.readState = () => {
    if (queue && queue.length) return queue.shift();
    return sim.state;
  };
  sim.act = async () => { sim.presses += 1; if (takes(sim.presses)) sim.state = sim.state === "on" ? "off" : "on"; };
  sim.reobserve = async () => { sim.looks += 1; return { look: sim.looks }; };
  return sim;
}

const run = (sim, extra = {}) => idempotentToggle({ desired: "on", observation: {}, readState: sim.readState, act: sim.act, reobserve: sim.reobserve, ...extra });

test("already in the wanted state: nothing is pressed (the re-run of an identical task is a no-op)", async () => {
  const sim = control({ state: "on" });
  const result = await run(sim);
  assert.equal(result.outcome, TOGGLE_OUTCOMES.NOOP);
  assert.equal(sim.presses, 0);
  assert.equal(sim.looks, 0);
});

test("not yet in the wanted state: pressed exactly once and verified", async () => {
  const sim = control({ state: "off" });
  const result = await run(sim);
  assert.equal(result.outcome, TOGGLE_OUTCOMES.VERIFIED);
  assert.equal(result.acted, 1);
  assert.equal(sim.presses, 1);
  assert.equal(sim.state, "on");
});

test("an unreadable state is looked at again, and never acted on blindly", async () => {
  const blind = control({ state: "off", readings: ["unknown", "unknown"] });
  const result = await run(blind);
  assert.equal(result.outcome, TOGGLE_OUTCOMES.AMBIGUOUS);
  assert.equal(blind.presses, 0, "no blind press");

  const recovers = control({ state: "off", readings: ["unknown", "off"] });
  assert.equal((await run(recovers)).outcome, TOGGLE_OUTCOMES.VERIFIED, "readable on the second look, so it proceeds");
  assert.equal(recovers.presses, 1);
});

test("an ambiguous result after pressing is never pressed again (a blind second press could undo a success)", async () => {
  const sim = control({ state: "off", readings: ["off", "unknown", "unknown"] });
  sim.act = async () => { sim.presses += 1; sim.state = "on"; }; // it DID take, but the screen is unreadable
  const result = await run(sim);
  assert.equal(result.outcome, TOGGLE_OUTCOMES.AMBIGUOUS);
  assert.equal(sim.presses, 1, "exactly one press");
  assert.equal(sim.state, "on", "and the account is left as the press made it, for a human to check");
});

test("a press that positively did not take is retried once, then succeeds", async () => {
  const sim = control({ state: "off", takes: attempt => attempt >= 2 });
  const result = await run(sim);
  assert.equal(result.outcome, TOGGLE_OUTCOMES.VERIFIED);
  assert.equal(result.acted, 2);
});

test("a press that never takes ends as FAILED_VERIFICATION after the allowed attempts, not an endless loop", async () => {
  const sim = control({ state: "off", takes: () => false });
  const result = await run(sim, { maxAttempts: 3 });
  assert.equal(result.outcome, TOGGLE_OUTCOMES.FAILED_VERIFICATION);
  assert.equal(sim.presses, 3);
});

test("withdrawn authorization stops the toggle before any press, and between attempts", async () => {
  const sim = control({ state: "off" });
  assert.equal((await run(sim, { canContinue: () => false })).outcome, TOGGLE_OUTCOMES.BLOCKED);
  assert.equal(sim.presses, 0);

  const later = control({ state: "off", takes: () => false });
  let calls = 0;
  const result = await run(later, { canContinue: () => (calls += 1) === 1 });
  assert.equal(result.outcome, TOGGLE_OUTCOMES.BLOCKED);
  assert.equal(later.presses, 1, "the human took over between attempts");
});

test("turning something off works the same way", async () => {
  const sim = control({ state: "on" });
  const result = await idempotentToggle({ desired: "off", observation: {}, readState: sim.readState, act: sim.act, reobserve: sim.reobserve });
  assert.equal(result.outcome, TOGGLE_OUTCOMES.VERIFIED);
  assert.equal(sim.state, "off");
});

test("invalid use is rejected loudly", async () => {
  await assert.rejects(() => idempotentToggle({ desired: "maybe" }), TypeError);
  await assert.rejects(() => idempotentToggle({ desired: "on" }), /readState is required/);
});
