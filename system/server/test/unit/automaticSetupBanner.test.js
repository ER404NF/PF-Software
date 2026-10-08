import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// The notice at the top of the Fleet page about automatic phone setup. Everyone sees the status; only people the server marks
// as allowed see Check again. It never uses the page-level message line, and it announces only when the words change.

const client = name => new URL(`../../../client/${name}`, import.meta.url);
const context = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(client("automaticSetupBanner.js"), "utf8"), context);
const { createAutomaticSetupBanner } = context.window;
const indexHtml = fs.readFileSync(client("index.html"), "utf8");
const app = fs.readFileSync(client("app.js"), "utf8");
const css = fs.readFileSync(client("style.css"), "utf8");
const worker = fs.readFileSync(client("sw.js"), "utf8");

function element() {
  const el = {
    hidden: true, textContent: "", disabled: false, dataset: {}, attributes: {}, listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
  };
  return el;
}

function build({ requestJson } = {}) {
  const banner = element(); const text = element(); const button = element(); const result = element();
  button.textContent = "Check again";
  const timers = [];
  const controller = createAutomaticSetupBanner({
    banner, text, button, result, requestJson: requestJson ?? (async () => ({ body: { ok: true, status: { state: "running" } } })),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutFn: () => {},
  });
  return { banner, text, button, result, controller, timers };
}

const paused = (extra = {}) => ({ state: "paused", code: "setup_paused_cannot_check", message: "Automatic phone setup is paused. Bodun could not check.", canCheckAgain: true, ...extra });

test("paused and checking show the banner with the server's words; running, off and an absent field hide it", () => {
  const { banner, text, controller } = build();
  controller.update(paused());
  assert.equal(banner.hidden, false);
  assert.equal(text.textContent, "Automatic phone setup is paused. Bodun could not check.");
  assert.equal(banner.dataset.state, "paused");
  controller.update({ state: "checking", code: "setup_checking", message: "Bodun is checking its earlier phone connections.", canCheckAgain: false });
  assert.equal(banner.hidden, false);
  controller.update({ state: "running", code: "setup_running", message: "Automatic phone setup is running.", canCheckAgain: false });
  assert.equal(banner.hidden, true);
  controller.update(paused());
  controller.update({ state: "off", code: "setup_off", message: "Automatic phone setup is turned off on this Mac.", canCheckAgain: false });
  assert.equal(banner.hidden, true, "off is not a problem to announce");
  controller.update(paused());
  controller.update(undefined);
  assert.equal(banner.hidden, true, "a hub that sends no status (an older version) shows nothing new");
});

test("clearing the notice (sign-out, role change) also empties its words and button, not only hides the box", async () => {
  const { banner, text, button, result, controller } = build();
  controller.update(paused({ canCheckAgain: true }));
  await button.listeners.click();
  assert.ok(text.textContent && result.textContent);
  controller.update(null);
  assert.equal(banner.hidden, true);
  assert.equal(text.textContent, "", "the last person's sentence is gone");
  assert.equal(result.textContent, "", "and so is the last answer");
  assert.equal(button.hidden, true, "and the Check again button is not left switched on");
  controller.update(paused({ canCheckAgain: false }));
  assert.equal(text.textContent, "Automatic phone setup is paused. Bodun could not check.");
  assert.equal(button.hidden, true);
});

test("Check again is shown only when the server says this person may use it", () => {
  const { button, controller } = build();
  controller.update(paused({ canCheckAgain: true }));
  assert.equal(button.hidden, false);
  controller.update(paused({ canCheckAgain: false }));
  assert.equal(button.hidden, true);
  controller.update({ state: "running", code: "setup_running", message: "x", canCheckAgain: true });
  assert.equal(button.hidden, true, "never while nothing is paused");
});

test("an unchanged status is not written again (nothing is announced twice)", () => {
  const { text, controller } = build();
  let writes = 0;
  let value = "";
  Object.defineProperty(text, "textContent", { get: () => value, set: next => { writes += 1; value = next; } });
  controller.update(paused());
  controller.update(paused());
  controller.update(paused());
  assert.equal(writes, 1);
  controller.update(paused({ code: "setup_paused_earlier_session", message: "Automatic phone setup is paused. An earlier Bodun session is still running." }));
  assert.equal(writes, 2);
});

test("pressing Check again asks the server once, shows 'Checking…' on the button only, and reports the answer in the banner", async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { button, result, text, controller } = build({
    requestJson: async (url, options) => { calls.push([url, options.method]); await gate; return { body: { ok: true, status: { state: "paused" } } }; },
  });
  controller.update(paused());
  const before = text.textContent;
  const pressed = button.listeners.click();
  assert.equal(button.textContent, "Checking…");
  assert.equal(button.disabled, false, "a really disabled button drops keyboard focus, so a keyboard user would lose their place");
  assert.equal(button.attributes["aria-disabled"], "true", "it is marked busy for assistive technology instead");
  button.listeners.click(); // a second press while the first runs
  assert.equal(calls.length, 1, "pressed twice, asked once");
  release();
  await pressed;
  assert.deepEqual(calls, [["/api/admin/automatic-setup/check", "POST"]]);
  assert.equal(button.textContent, "Check again");
  assert.equal(button.disabled, false);
  assert.equal(button.attributes["aria-disabled"], "false");
  assert.match(result.textContent, /still paused/);
  assert.equal(text.textContent, before, "the status text itself changes only through the server's update");
});

test("when the check finds setup running, the answer says so", async () => {
  const { button, result, controller } = build();
  controller.update(paused());
  await button.listeners.click();
  assert.match(result.textContent, /running/);
});

test("a failed check shows the server's plain sentence in the banner and re-enables the button", async () => {
  const { button, result, controller } = build({ requestJson: async () => { throw new Error("Bodun is shutting down. Try again after it has restarted."); } });
  controller.update(paused());
  await button.listeners.click();
  assert.equal(result.textContent, "Bodun is shutting down. Try again after it has restarted.");
  assert.equal(button.disabled, false);
});

test("the answer line fades after a while and is cleared when the words change", async () => {
  const { button, result, timers, controller } = build();
  controller.update(paused());
  await button.listeners.click();
  assert.ok(result.textContent);
  assert.equal(timers.at(-1).ms, 10_000);
  timers.at(-1).fn();
  assert.equal(result.textContent, "");
  await button.listeners.click();
  controller.update(paused({ code: "setup_paused_earlier_session", message: "a different reason" }));
  assert.equal(result.textContent, "");
});

// ---- markup and wiring ----------------------------------------------------------------------------------------

test("the banner is a keyboard-reachable, politely announced region on the Fleet page, before the fleet", () => {
  const block = indexHtml.slice(indexHtml.indexOf('id="automatic-setup-banner"') - 40, indexHtml.indexOf('id="fleet-toolbar"'));
  assert.match(block, /<div id="automatic-setup-banner"[^>]*role="region"[^>]*aria-label="Automatic phone setup"[^>]*tabindex="0"[^>]*hidden/);
  assert.match(block, /<p id="automatic-setup-text"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(block, /<button type="button" id="automatic-setup-check"[^>]*hidden>Check again<\/button>/);
  assert.match(block, /<p id="automatic-setup-result"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(indexHtml.indexOf('id="automatic-setup-banner"') < indexHtml.indexOf('id="fleet-groups"'));
});

test("the page loads the banner script before app.js, and the offline shell lists it with a new cache name", () => {
  assert.ok(indexHtml.indexOf('src="automaticSetupBanner.js"') > 0);
  assert.ok(indexHtml.indexOf('src="automaticSetupBanner.js"') < indexHtml.indexOf('src="app.js"'));
  assert.match(worker, /"\/automaticSetupBanner\.js"/);
  assert.match(worker, /const CACHE = "phone-farm-shell-v2";/);
});

test("app.js hands every device list's status to the banner and the cards, and the banner never writes to the page-level line", () => {
  assert.match(app, /window\.createAutomaticSetupBanner\(\{/);
  assert.match(app, /automaticSetupStatus = msg\.automaticSetup \?\? null;\s*automaticSetupBanner\.update\(automaticSetupStatus\);\s*renderFleetSafely\(msg\.devices, \{ preserveViewport: true \}\);/);
  assert.match(app, /deviceCardModel\.lifecycleButtons\(device\.wdaLifecycle, wdaInFlight\.get\(device\.id\) \?\? null, automaticSetupStatus\)/);
  const module = fs.readFileSync(client("automaticSetupBanner.js"), "utf8");
  assert.doesNotMatch(module, /select-error|selectError/);
});

test("the banner has its own look, readable in both themes, and a visible focus ring", () => {
  assert.match(css, /#automatic-setup-banner\s*\{/);
  assert.match(css, /#automatic-setup-banner:focus-visible/);
  assert.match(css, /:root:not\(\[data-theme="dark"\]\) #automatic-setup-banner\s*\{/);
});

function bodyOf(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = app.indexOf("\nfunction ", start + 1);
  return app.slice(start, end);
}

test("the notice and its Check again permission are cleared on sign-out and when access is refreshed after a role change", () => {
  for (const name of ["clearLocalAuthenticatedState", "applyLiveOperatorProfile"]) {
    assert.match(bodyOf(name), /automaticSetupStatus = null;[^\n]*\n\s*automaticSetupBanner\.update\(null\);/, `${name} must not leave the previous person's status or button on the page`);
  }
});
