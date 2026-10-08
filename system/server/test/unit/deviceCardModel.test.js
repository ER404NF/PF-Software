import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Client scripts are plain browser scripts; load one the way a browser would.
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { lifecycleButtons, describeLifecycle, PROVISIONING_OFF, BUSY } = context.window.deviceCardModel;
const { lifecycleGuidance } = await import("../../src/deviceProvisioner.js");

const attach = (state, extra = {}) => ({
  managed: true, attached: true, enabled: state !== "stopped", state,
  ...lifecycleGuidance({ state, anyRunning: !["stopped", "failed"].includes(state), ...extra }),
});
const states = lifecycle => Object.fromEntries(lifecycleButtons(lifecycle).buttons.map(button => [button.key, !button.disabled]));

test("there are three separate WDA buttons plus the control check, in order", () => {
  const { buttons } = lifecycleButtons(attach("ready"));
  assert.deepEqual(Array.from(buttons, button => button.label), ["Start WDA", "Stop WDA", "Restart WDA", "Check control"]);
});

test("Start is enabled only when stopped or failed with nothing running", () => {
  assert.equal(states(attach("stopped")).start, true);
  assert.equal(states(attach("failed")).start, true);
  for (const state of ["starting", "restarting", "ready", "enabled"]) assert.equal(states(attach(state)).start, false, state);
});

test("Stop is enabled when starting, running, failed, and not when stopped", () => {
  for (const state of ["starting", "restarting", "ready", "enabled", "failed"]) assert.equal(states(attach(state)).stop, true, state);
  assert.equal(states(attach("stopped")).stop, false);
});

test("Restart is enabled when running or failed", () => {
  for (const state of ["ready", "enabled", "failed"]) assert.equal(states(attach(state)).restart, true, state);
  for (const state of ["stopped", "starting", "restarting"]) assert.equal(states(attach(state)).restart, false, state);
});

test("a disabled button always states why, using the server's sentence", () => {
  const model = lifecycleButtons(attach("ready"));
  const start = model.buttons.find(button => button.key === "start");
  assert.equal(start.disabled, true);
  assert.equal(start.reason, "Already running.");
  assert.deepEqual(Array.from(model.reasons, entry => entry.label), ["Start WDA"]);
  const busy = lifecycleButtons({ ...attach("ready"), inUse: true, ...lifecycleGuidance({ state: "ready", anyRunning: true, inUse: true }) });
  assert.deepEqual(Array.from(busy.reasons, entry => entry.reason), ["Already running.", "Release the phone first.", "Release the phone first."]);
});

test("while one action runs every button is disabled with the same reason (double clicks do nothing)", () => {
  const model = lifecycleButtons(attach("ready"), "restart");
  assert.ok(model.buttons.every(button => button.disabled && button.reason === BUSY));
});

test("with automatic setup off the panel is a disabled panel with one explanation", () => {
  const model = lifecycleButtons(null);
  assert.ok(model.buttons.every(button => button.disabled && button.reason === PROVISIONING_OFF));
  assert.equal(model.note, PROVISIONING_OFF);
});

test("a phone Bodun does not manage shows the server's explanation for all of them", () => {
  const model = lifecycleButtons({ managed: false, ...lifecycleGuidance({ managed: false }) });
  assert.ok(model.buttons.every(button => button.disabled));
  assert.equal(model.note, "Bodun is not managing this phone's control service.");
});

test("an unplugged phone can only be stopped", () => {
  const detached = { managed: true, attached: false, enabled: true, state: "detached", ...lifecycleGuidance({ state: "detached", attached: false }) };
  assert.deepEqual(states(detached), { start: false, stop: true, restart: false, check: true });
});

test("every lifecycle state has a plain label and tone", () => {
  for (const state of ["stopped", "starting", "restarting", "enabled", "ready", "failed", "detached", "unmanaged"]) {
    const label = describeLifecycle({ state });
    assert.ok(label.text && label.tone, state);
  }
  assert.equal(describeLifecycle(null).text, "Automatic setup is off");
});

test("both client modules are loaded before app.js and are in the offline shell", () => {
  const html = fs.readFileSync(new URL("../../../client/index.html", import.meta.url), "utf8");
  const sw = fs.readFileSync(new URL("../../../client/sw.js", import.meta.url), "utf8");
  for (const file of ["cardMessages.js", "deviceCardModel.js"]) {
    assert.ok(html.indexOf(`src="${file}"`) > 0 && html.indexOf(`src="${file}"`) < html.indexOf('src="app.js"'), `${file} loads before app.js`);
    assert.match(sw, new RegExp(`"/${file.replace(".", "\\.")}"`));
  }
});

// ---- while automatic phone setup is paused or checking ------------------------------------------------------

test("with no lifecycle answer, a paused or checking setup is named as such and never as 'turned off'", () => {
  const paused = { state: "paused", code: "setup_paused_cannot_check", message: "Automatic phone setup is paused. x" };
  const checking = { state: "checking", code: "setup_checking", message: "Bodun is checking." };
  for (const [status, expected] of [[paused, /paused/], [checking, /checking its earlier phone connections/]]) {
    const model = lifecycleButtons(null, null, status);
    assert.ok(model.buttons.every(button => button.disabled), status.state);
    for (const button of model.buttons) {
      assert.match(button.reason, expected, `${status.state}: ${button.label}`);
      assert.doesNotMatch(button.reason, /turned off/);
    }
    assert.match(model.note, expected);
  }
});

test("with setup off, running, or no status at all, the old wording is unchanged", () => {
  for (const status of [null, undefined, { state: "off" }, { state: "running" }]) {
    const model = lifecycleButtons(null, null, status);
    assert.ok(model.buttons.every(button => button.reason === PROVISIONING_OFF), JSON.stringify(status));
  }
});

test("a lifecycle answer from the server is never overridden by the status", () => {
  const model = lifecycleButtons({ managed: false, startReason: "Automatic phone setup is paused. See the notice at the top of this page." }, null, { state: "paused" });
  assert.match(model.note, /See the notice at the top of this page/);
  const ready = lifecycleButtons(attach("ready"), null, { state: "paused" });
  assert.equal(ready.buttons.find(button => button.key === "restart").disabled, false);
});

test("the header word for a phone with no lifecycle says setup is paused while it is", () => {
  assert.deepEqual({ ...describeLifecycle(null, { state: "paused" }) }, { text: "Setup paused", tone: "warning" });
  assert.deepEqual({ ...describeLifecycle(null, { state: "checking" }) }, { text: "Checking setup", tone: "warning" });
  assert.deepEqual({ ...describeLifecycle(null) }, { text: "Automatic setup is off", tone: "neutral" });
  assert.deepEqual({ ...describeLifecycle(null, { state: "off" }) }, { text: "Automatic setup is off", tone: "neutral" });
});
