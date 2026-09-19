import { test } from "node:test";
import assert from "node:assert/strict";
import { MockDevice } from "../../src/mockDevice.js";

function openApp(device) {
  device.tap(70 / 375, 120 / 667); // the Instagram icon
  assert.equal(device.screen, "app");
}

test("dragging up scrolls the feed down and the live view shows it", () => {
  const device = new MockDevice("mock-1", "Mock");
  openApp(device);
  const before = device.renderSvg();
  device.drag(0.5, 0.8, 0.5, 0.3);
  assert.equal(device.lastSwipe, "up");
  assert.ok(device.scrollY > 0);
  assert.notEqual(device.renderSvg(), before);
  device.drag(0.5, 0.2, 0.5, 0.9);
  assert.equal(device.lastSwipe, "down");
  assert.equal(device.scrollY, 0, "cannot scroll above the top");
});

test("typing supports backspace like a real keyboard", () => {
  const device = new MockDevice("mock-1", "Mock");
  device.typeText("hello");
  device.typeText("\b\bp");
  assert.equal(device.typedText, "help");
});

test("long press and double tap are recorded; double tap still opens an app once", () => {
  const device = new MockDevice("mock-1", "Mock");
  device.longPress(0.5, 0.5);
  assert.equal(device.lastGesture, "long-press");
  device.doubleTap(70 / 375, 120 / 667);
  assert.equal(device.lastGesture, "double-tap");
  assert.equal(device.screen, "app");
});

test("the mock streams a frame immediately and again on every change", () => {
  const device = new MockDevice("mock-1", "Mock");
  const frames = [];
  const states = [];
  const stream = device.openStream({ onFrame: frame => frames.push(frame.toString()), onState: state => states.push(state) });
  assert.equal(frames.length, 1);
  assert.ok(frames[0].startsWith("<svg"));
  device.tap(70 / 375, 120 / 667);
  device.pressHome();
  assert.equal(frames.length, 3);
  stream.close();
  device.tap(70 / 375, 120 / 667);
  assert.equal(frames.length, 3, "nothing after close");
  assert.deepEqual(states, ["connecting", "live", "closed"]);
});

test("every screen the mock streams is well-formed XML (a browser decodes it as a standalone SVG image)", () => {
  const device = new MockDevice("mock-1", "Mock");
  const screens = [device.renderSvg()];
  device.tap(70 / 375, 120 / 667);
  device.typeText("a<b>&\"'");
  device.drag(0.5, 0.8, 0.5, 0.3);
  screens.push(device.renderSvg());
  for (const svg of screens) {
    // HTML-only entities such as &larr; are not valid XML and make the image fail to load.
    const entities = [...svg.matchAll(/&([A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9A-Fa-f]+);/g)].map(match => match[1]);
    for (const entity of entities) assert.match(entity, /^(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+)$/, `&${entity}; is not valid in an SVG image`);
    assert.doesNotMatch(svg, /&(?![A-Za-z#][A-Za-z0-9]*;)/, "a bare ampersand is invalid XML");
    assert.match(svg, /^<svg [^>]*width="375"[^>]*height="667"/, "an explicit size gives the canvas its dimensions");
  }
});
