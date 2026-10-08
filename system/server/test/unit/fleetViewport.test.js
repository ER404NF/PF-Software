import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { captureViewportAnchor, restoreViewportAnchor } = context.window.deviceCardModel;
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");

function card(deviceId, top, height = 300) {
  return {
    dataset: { deviceId },
    top,
    height,
    getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, height: this.height }; },
  };
}

function page(cards, { scrollHeight = 3000 } = {}) {
  return {
    cards,
    ownerDocument: { documentElement: { scrollHeight }, body: { scrollHeight } },
    querySelectorAll: () => cards,
  };
}

function viewport({ scrollY = 700, innerHeight = 800 } = {}) {
  return {
    scrollY, scrollX: 0, innerHeight, calls: [],
    scrollTo(options) { this.calls.push(options); this.scrollY = options.top; },
  };
}

test("background redraw keeps the first visible phone at the same viewport offset when content above changes height", () => {
  const win = viewport();
  const before = page([card("a", -250), card("b", 50), card("c", 350)]);
  const saved = captureViewportAnchor(before, win);
  assert.deepEqual({ ...saved }, { deviceId: "a", offsetTop: -250, scrollY: 700 });

  const after = page([card("a", -90, 460), card("b", 370), card("c", 670)]);
  assert.equal(restoreViewportAnchor(after, saved, win), true);
  assert.equal(win.scrollY, 860);
  assert.equal(win.calls[0].behavior, "auto");
});

test("a surviving current card remains anchored even when another card above grows or shrinks", () => {
  const win = viewport({ scrollY: 1000 });
  const saved = captureViewportAnchor(page([card("a", -500, 400), card("b", -80), card("c", 220)]), win);
  assert.equal(saved.deviceId, "b");
  const after = page([card("a", -700, 600), card("b", 120), card("c", 420)]);
  restoreViewportAnchor(after, saved, win);
  assert.equal(win.scrollY, 1200);
});

test("when the anchored phone disappears the old absolute scroll position is restored within document bounds", () => {
  const win = viewport({ scrollY: 1700, innerHeight: 700 });
  const saved = captureViewportAnchor(page([card("a", -100), card("b", 200)]), win);
  const after = page([card("b", 20)], { scrollHeight: 1800 });
  assert.equal(restoreViewportAnchor(after, saved, win), false);
  assert.equal(win.scrollY, 1100);
});

test("background device lists preserve the viewport, while filter and resize redraws remain intentional", () => {
  assert.match(app, /renderFleetSafely\(msg\.devices, \{ preserveViewport: true \}\)/);
  assert.match(app, /fleetStatusFilterEl\.addEventListener\("change", \(\) => \{\s*void renderFleetSafely\(lastDevices\);/);
  assert.match(app, /function refreshFleetLayout\(\)[\s\S]*void renderFleetSafely\(lastDevices\);/);
  assert.match(app, /deviceCardModel\.captureViewportAnchor\(fleetGroupsEl, window\)/);
  assert.match(app, /deviceCardModel\.restoreViewportAnchor\(fleetGroupsEl, savedViewport, window\)/);
});
