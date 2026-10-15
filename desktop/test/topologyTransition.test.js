const test = require("node:test");
const assert = require("node:assert/strict");
const { createTopologyTransition } = require("../topologyTransition.js");

function setup(initial = null) {
  let active = initial;
  const events = [];
  const stop = mode => async () => { events.push(`stop:${mode}`); if (active === mode) active = null; };
  const controller = createTopologyTransition({
    activeMode: () => active,
    stopHost: stop("host"), stopSite: stop("site"), stopClient: stop("client"),
  });
  const switchTo = (target, { fail = false } = {}) => controller.transitionTo(target, {
    current: async () => { events.push(`current:${target}`); return target; },
    start: async () => {
      events.push(`start:${target}`);
      if (fail) throw new Error(`failed:${target}`);
      active = target;
      return target;
    },
    restore: async previous => {
      events.push(`restore:${previous}`);
      active = previous;
    },
  });
  return { controller, switchTo, events, active: () => active };
}

for (const [from, to] of [["host", "site"], ["site", "host"], ["site", "client"], ["client", "host"], ["client", "site"]]) {
  test(`${from} to ${to} stops incompatible modes before starting`, async () => {
    const state = setup(from);
    await state.switchTo(to);
    assert.equal(state.active(), to);
    assert.ok(state.events.indexOf(`stop:${from}`) < state.events.indexOf(`start:${to}`));
    assert.equal(state.events.filter(event => event.startsWith("start:")).length, 1);
  });
}

test("reselecting the active mode is idempotent", async () => {
  const state = setup("site");
  await state.switchTo("site");
  assert.deepEqual(state.events, ["current:site"]);
  assert.equal(state.active(), "site");
});

test("failed startup stops the partial target and restores the previous mode", async () => {
  const state = setup("host");
  await assert.rejects(state.switchTo("site", { fail: true }), /failed:site/);
  assert.equal(state.active(), "host");
  assert.deepEqual(state.events.slice(-3), ["start:site", "stop:site", "restore:host"]);
});

test("application shutdown waits for every mode to stop", async () => {
  const state = setup("site");
  await state.controller.stopAll();
  assert.equal(state.active(), null);
  assert.deepEqual(state.events, ["stop:host", "stop:site", "stop:client"]);
});
