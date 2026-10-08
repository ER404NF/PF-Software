import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Found by the keyboard-only check: the fleet is redrawn about every ten seconds and every redraw builds all the cards
// again, so the control a keyboard user was on disappeared and focus fell back to the top of the page. The redraw now
// remembers which control had focus (its card, its place among the card's controls and its name) and puts focus back.
const context = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { captureFocus, restoreFocus } = context.window.deviceCardModel;
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");

// A tiny stand-in for the page: cards hold controls; a "redraw" replaces every element with a new one of the same name.
function control(name, { disabled = false } = {}) {
  const el = {
    name, disabled, focused: false, card: null,
    getAttribute: attribute => (attribute === "aria-label" ? name : null),
    textContent: name, id: "",
    closest: () => el.card,
    focus() { el.focused = true; },
  };
  return el;
}
function card(deviceId, names, options = {}) {
  const c = { dataset: { deviceId }, controls: names.map(name => control(name, options[name])) };
  for (const el of c.controls) el.card = c;
  c.querySelectorAll = () => c.controls;
  return c;
}
function page(cards) {
  const root = { cards, querySelectorAll: () => cards, contains: el => cards.some(c => c.controls.includes(el)) };
  return root;
}

test("focus comes back to the same control on the same phone after the cards are rebuilt", () => {
  const before = page([card("a", ["Check network", "Start WDA"]), card("b", ["Check network", "Start WDA"])]);
  const active = before.cards[1].controls[1]; // Start WDA on phone b
  const saved = captureFocus(before, active);
  assert.deepEqual({ ...saved }, { deviceId: "b", index: 1, name: "Start WDA" });
  const after = page([card("a", ["Check network", "Start WDA"]), card("b", ["Check network", "Start WDA"])]);
  assert.equal(restoreFocus(after, saved), true);
  assert.equal(after.cards[1].controls[1].focused, true);
  assert.equal(after.cards[0].controls[1].focused, false);
});

test("if the control moved within its card, it is found again by name", () => {
  const before = page([card("a", ["Check network", "Retry setup", "Start WDA"])]);
  const saved = captureFocus(before, before.cards[0].controls[2]);
  const after = page([card("a", ["Check network", "Start WDA"])]);
  assert.equal(restoreFocus(after, saved), true);
  assert.equal(after.cards[0].controls[1].focused, true);
});

test("when the control itself is gone or now off, focus stays on the same phone's card (its first available control)", () => {
  const before = page([card("a", ["Cancel enrollment"])]);
  const saved = captureFocus(before, before.cards[0].controls[0]);
  const gone = page([card("a", ["Check network", "Start WDA"])]);
  assert.equal(restoreFocus(gone, saved), true);
  assert.equal(gone.cards[0].controls[0].focused, true);
  const off = page([card("a", ["Cancel enrollment", "Check network"], { "Cancel enrollment": { disabled: true } })]);
  assert.equal(restoreFocus(off, saved), true);
  assert.equal(off.cards[0].controls[1].focused, true);
  assert.equal(off.cards[0].controls[0].focused, false);
});

test("nothing is focused when the phone left the list or the card has no available control", () => {
  const before = page([card("a", ["Cancel enrollment"])]);
  const saved = captureFocus(before, before.cards[0].controls[0]);
  assert.equal(restoreFocus(page([card("zzz", ["Cancel enrollment"])]), saved), false);
  assert.equal(restoreFocus(page([card("a", ["Only one"], { "Only one": { disabled: true } })]), saved), false);
});

test("focus outside the fleet is left alone", () => {
  const before = page([card("a", ["Check network"])]);
  assert.equal(captureFocus(before, control("Sign out")), null);
  assert.equal(captureFocus(before, null), null);
  assert.equal(restoreFocus(before, null), false);
});

test("the fleet redraw saves focus before clearing the cards and restores it after drawing them, and cards carry their phone's id", () => {
  assert.match(app, /const savedFocus = deviceCardModel\.captureFocus\(fleetGroupsEl, document\.activeElement\)[^;]*;\s*fleetGroupsEl\.innerHTML = "";/);
  assert.match(app, /fleetGroupsEl\.appendChild\(section\);\s*\}\s*deviceCardModel\.restoreFocus\(fleetGroupsEl, savedFocus\);/);
  assert.match(app, /card\.dataset\.deviceId = d\.id;/);
});

test("a button that turns itself off while its request runs (and so loses focus) still gets the keyboard user's place back", () => {
  // Found by pressing Enter on "Cancel enrollment": the button is disabled while the request runs, the browser drops focus to the
  // page, and by the time the fleet is drawn again there is nothing focused to save. The last control focused inside the fleet is
  // remembered, forgotten as soon as focus goes anywhere else or the mouse is used, and used only when focus fell to the page.
  assert.match(app, /fleetGroupsEl\.addEventListener\("focusin", event => \{\s*lastCardFocus = deviceCardModel\.captureFocus\(fleetGroupsEl, event\.target\);\s*\}\);/);
  assert.match(app, /document\.addEventListener\("focusin", event => \{\s*if \(!fleetGroupsEl\.contains\(event\.target\)\) lastCardFocus = null;\s*\}\);/);
  assert.match(app, /document\.addEventListener\("pointerdown", \(\) => \{ lastCardFocus = null; \}\);/);
  assert.match(app, /const savedFocus = deviceCardModel\.captureFocus\(fleetGroupsEl, document\.activeElement\)\s*\?\? \(document\.activeElement === document\.body \? lastCardFocus : null\);/);
});
