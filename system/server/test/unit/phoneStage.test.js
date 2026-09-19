import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import vm from "vm";
import { fileURLToPath } from "url";

const source = fs.readFileSync(fileURLToPath(new URL("../../../client/phoneStage.js", import.meta.url)), "utf8");

// The module is a browser script that attaches itself to `window` (here: globalThis).
// Running it in this realm (not a separate vm context) keeps the objects it returns
// comparable with deepStrictEqual.
vm.runInThisContext(source, { filename: "phoneStage.js" });
const { PhoneStage } = globalThis;
const { pointInRect, classifyGesture, wheelDragMessage, scrollDrag, keyAction, TextBatcher } = PhoneStage.helpers;

// ---- fake DOM ------------------------------------------------------------------

class FakeElement {
  constructor(rect = { left: 100, top: 50, width: 200, height: 400 }) {
    this.rect = rect;
    this.listeners = new Map();
    this.children = [];
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
      contains: name => this.classes.has(name),
    };
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.captured = null;
    this.parentElement = null;
  }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]); }
  dispatch(type, event = {}) {
    const fired = { preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false, ...event };
    for (const handler of this.listeners.get(type) ?? []) handler(fired);
    return fired;
  }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture() { this.captured = null; }
  replaceChildren(...nodes) { this.children = nodes; }
  focus() { this.focused = true; this.dispatch("focus"); }
}

function fakeCanvas() {
  const drawn = [];
  const canvas = new FakeElement({ left: 100, top: 50, width: 200, height: 400 });
  canvas.width = 0;
  canvas.height = 0;
  canvas.drawn = drawn;
  canvas.getContext = () => ({ drawImage: (...args) => drawn.push(args), clearRect() {} });
  return canvas;
}

function manualClock() {
  let now = 1000;
  const timers = new Set();
  return {
    now: () => now,
    setTimeoutFn: (fn, ms) => { const timer = { fn, at: now + ms }; timers.add(timer); return timer; },
    clearTimeoutFn: timer => timers.delete(timer),
    advance(ms) {
      now += ms;
      for (const timer of [...timers].filter(item => item.at <= now).sort((a, b) => a.at - b.at)) {
        timers.delete(timer);
        timer.fn();
      }
    },
  };
}

function makeStage({ mode = "control", coarse = false } = {}) {
  const clock = manualClock();
  const screen = new FakeElement();
  const glass = new FakeElement();
  screen.parentElement = glass;
  const home = new FakeElement();
  const dot = new FakeElement();
  dot.parentElement = glass;
  const keyboard = new FakeElement();
  const frame = new FakeElement();
  const sent = [];
  let nextId = 1;
  const stage = new PhoneStage({
    screenEl: screen, frameEl: frame, homeButtonEl: home, dotEl: dot, keyboardEl: keyboard,
    send: message => { sent.push(message); return nextId++; },
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    createCanvas: fakeCanvas,
    decode: async bytes => ({ width: 90, height: 160, bytes, close() {} }),
    coarsePointer: () => coarse,
  });
  stage.setMode(mode);
  return { stage, screen, home, dot, keyboard, frame, sent, clock };
}

// ---- pure helpers -------------------------------------------------------------

test("pointInRect maps client pixels to 0..1 and clamps outside the picture", () => {
  const rect = { left: 100, top: 50, width: 200, height: 400 };
  assert.deepEqual(pointInRect(rect, 200, 250), { x: 0.5, y: 0.5 });
  assert.deepEqual(pointInRect(rect, 0, 9999), { x: 0, y: 1 });
  assert.equal(pointInRect({ left: 0, top: 0, width: 0, height: 10 }, 1, 1), null);
  assert.equal(pointInRect(null, 1, 1), null);
});

test("a short press without movement is a tap; a long one a long press; jitter still counts as a tap", () => {
  const base = { startX: 0.4, startY: 0.6, endX: 0.4, endY: 0.6, startedAt: 0, movedAt: null, maxTravelPx: 2 };
  assert.deepEqual(classifyGesture({ ...base, endedAt: 120 }), { type: "tap", x: 0.4, y: 0.6 });
  assert.deepEqual(classifyGesture({ ...base, endedAt: 900 }), { type: "long_press", x: 0.4, y: 0.6, durationMs: 900 });
  assert.equal(classifyGesture({ ...base, endedAt: 60000 }).durationMs, 5000, "capped");
});

test("movement makes a drag; holding still first turns it into a press-and-drag", () => {
  const drag = { startX: 0.5, startY: 0.8, endX: 0.5, endY: 0.2, startedAt: 0, endedAt: 300, maxTravelPx: 200 };
  assert.deepEqual(classifyGesture({ ...drag, movedAt: 40 }), { type: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, holdMs: 50 });
  assert.equal(classifyGesture({ ...drag, movedAt: 700 }).holdMs, 700);
});

test("wheel down moves the finger up, wheel up moves it down, and the drag stays off the screen edges", () => {
  const rect = { left: 0, top: 0, width: 200, height: 400 };
  const down = wheelDragMessage({ dx: 0, dy: 100, pointer: { x: 0.5, y: 0.5 }, rect });
  assert.equal(down.type, "drag");
  assert.ok(down.y2 < down.y1, "finger travels up");
  assert.equal(down.x1, down.x2);
  const up = wheelDragMessage({ dx: 0, dy: -100, pointer: { x: 0.5, y: 0.5 }, rect });
  assert.ok(up.y2 > up.y1, "finger travels down");
  for (const message of [down, up, wheelDragMessage({ dx: 0, dy: 100, pointer: { x: 0.01, y: 0.99 }, rect })]) {
    for (const value of [message.y1, message.y2]) assert.ok(value >= 0.1 && value <= 0.9, `y ${value} clear of the edge`);
    for (const value of [message.x1, message.x2]) assert.ok(value >= 0.12 && value <= 0.88, `x ${value} clear of the edge`);
  }
});

test("a sideways wheel scrolls horizontally, tiny deltas are ignored, and huge ones are capped", () => {
  const rect = { left: 0, top: 0, width: 200, height: 400 };
  const sideways = wheelDragMessage({ dx: 60, dy: 5, pointer: { x: 0.5, y: 0.5 }, rect });
  assert.equal(sideways.y1, sideways.y2);
  assert.ok(sideways.x2 < sideways.x1);
  assert.equal(wheelDragMessage({ dx: 0, dy: 0.2, pointer: { x: 0.5, y: 0.5 }, rect }), null);
  const huge = wheelDragMessage({ dx: 0, dy: 100000, pointer: { x: 0.5, y: 0.5 }, rect });
  assert.ok(Math.abs(huge.y1 - huge.y2) <= 0.5 + 1e-9);
});

test("scrollDrag never produces a zero-length drag", () => {
  const message = scrollDrag({ vertical: true, fingerSign: -1, amount: 0, pointer: { x: 0.5, y: 0.5 } });
  assert.ok(Math.abs(message.y1 - message.y2) >= 0.05 - 1e-9);
});

test("keyAction maps phone keys and leaves browser shortcuts and printable keys alone", () => {
  assert.deepEqual(keyAction({ key: "Backspace" }), { text: "\b" });
  assert.deepEqual(keyAction({ key: "Enter" }), { text: "\n" });
  assert.equal(keyAction({ key: "ArrowDown" }).scroll.fingerSign, -1);
  assert.equal(keyAction({ key: "ArrowUp" }).scroll.fingerSign, 1);
  assert.equal(keyAction({ key: "PageDown" }).scroll.amount, 0.6);
  assert.equal(keyAction({ key: "a" }), null, "printable keys go through beforeinput");
  assert.equal(keyAction({ key: "r", ctrlKey: true }), null);
  assert.equal(keyAction({ key: "Backspace", metaKey: true }), null);
  assert.equal(keyAction({ key: "Tab" }), null, "Tab must stay free so keyboard users can leave the stage");
});

test("TextBatcher coalesces quick typing into one ordered message and splits long text", () => {
  const clock = manualClock();
  const sent = [];
  const batcher = new TextBatcher({ send: message => sent.push(message), setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, chunk: 5 });
  for (const char of "ab") batcher.push(char);
  assert.equal(sent.length, 0);
  clock.advance(40);
  assert.deepEqual(sent, [{ type: "type_text", text: "ab" }]);
  batcher.push("0123456789AB"); // longer than one chunk: flushed at once, in order
  assert.deepEqual(sent.slice(1).map(message => message.text), ["01234", "56789", "AB"]);
});

// ---- the stage ------------------------------------------------------------------

test("a click becomes a tap at the right screen position, and a second quick click a double tap", () => {
  const { screen, sent, clock } = makeStage();
  const press = (x, y, hold = 40) => {
    screen.dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y });
    clock.advance(hold);
    screen.dispatch("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y });
  };
  press(200, 250); // centre of a 200x400 picture at (100,50)
  assert.deepEqual(sent, [{ type: "tap", x: 0.5, y: 0.5 }]);
  clock.advance(150);
  press(202, 251);
  assert.equal(sent[1].type, "double_tap");
  clock.advance(500);
  press(200, 250);
  assert.equal(sent[2].type, "tap", "a third click starts over");
});

test("a slow second click is another tap, not a double tap", () => {
  const { screen, sent, clock } = makeStage();
  const press = () => {
    screen.dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 250 });
    clock.advance(30);
    screen.dispatch("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 250 });
  };
  press();
  clock.advance(800);
  press();
  assert.deepEqual(sent.map(message => message.type), ["tap", "tap"]);
});

test("holding the mouse down then releasing is a long press with the real hold time", () => {
  const { screen, sent, clock, dot } = makeStage();
  screen.dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 150, clientY: 100 });
  clock.advance(700);
  assert.ok(dot.classes.has("holding"), "the touch dot grows while held");
  screen.dispatch("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 150, clientY: 100 });
  assert.equal(sent[0].type, "long_press");
  assert.equal(sent[0].durationMs, 700);
});

test("dragging sends the start and end of the drag; the touch dot follows the pointer", () => {
  const { screen, sent, clock, dot } = makeStage();
  screen.dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 400 });
  assert.equal(dot.hidden, false);
  clock.advance(20);
  screen.dispatch("pointermove", { pointerId: 1, clientX: 200, clientY: 300 });
  assert.equal(dot.style.transform, "translate(100px, 250px)", "relative to the glass");
  clock.advance(60);
  screen.dispatch("pointermove", { pointerId: 1, clientX: 200, clientY: 100 });
  screen.dispatch("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 100 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "drag");
  assert.deepEqual([sent[0].x1, sent[0].y1, sent[0].x2, sent[0].y2], [0.5, 0.875, 0.5, 0.125]);
  assert.equal(sent[0].holdMs, 50);
  clock.advance(200);
  assert.equal(dot.hidden, true);
});

test("right click and cancelled pointers send nothing", () => {
  const { screen, sent } = makeStage();
  screen.dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", button: 2, clientX: 200, clientY: 250 });
  screen.dispatch("pointerup", { pointerId: 1, pointerType: "mouse", button: 2, clientX: 200, clientY: 250 });
  screen.dispatch("pointerdown", { pointerId: 2, pointerType: "mouse", button: 0, clientX: 200, clientY: 250 });
  screen.dispatch("pointercancel", { pointerId: 2 });
  screen.dispatch("pointerup", { pointerId: 2, pointerType: "mouse", button: 0, clientX: 200, clientY: 250 });
  assert.deepEqual(sent, []);
});

test("watchers and idle stages cannot send input and the page keeps its own scrolling", () => {
  for (const mode of ["watch", "idle"]) {
    const { screen, home, sent, clock } = makeStage({ mode });
    screen.dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 250 });
    screen.dispatch("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 250 });
    const wheel = screen.dispatch("wheel", { deltaY: 100, deltaMode: 0, clientX: 200, clientY: 250 });
    assert.equal(wheel.defaultPrevented, false, `${mode}: the page may scroll`);
    home.dispatch("click");
    clock.advance(500);
    assert.deepEqual(sent, [], mode);
    assert.equal(home.disabled, true);
  }
});

test("wheel scrolling is throttled to one drag at a time and continues once the phone acknowledges", () => {
  const { screen, sent, clock, stage } = makeStage();
  const wheel = deltaY => screen.dispatch("wheel", { deltaY, deltaMode: 0, clientX: 200, clientY: 250 });
  assert.equal(wheel(40).defaultPrevented, true, "the page must not scroll while controlling");
  wheel(40);
  wheel(40);
  assert.equal(sent.length, 0, "coalescing window");
  clock.advance(70);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "drag");
  const firstSpan = Math.abs(sent[0].y1 - sent[0].y2);
  assert.ok(Math.abs(firstSpan - 120 / 400) < 1e-9, "three wheel ticks merged into one drag");

  wheel(40);
  wheel(40);
  clock.advance(500);
  assert.equal(sent.length, 1, "still waiting for the phone to finish the first drag");
  stage.actionSettled(1);
  clock.advance(70);
  assert.equal(sent.length, 2, "the queued wheel movement goes out after the acknowledgement");
  assert.ok(Math.abs(Math.abs(sent[1].y1 - sent[1].y2) - 80 / 400) < 1e-9);
});

test("a wheel drag the phone never acknowledges cannot freeze scrolling forever", () => {
  const { screen, sent, clock } = makeStage();
  screen.dispatch("wheel", { deltaY: 40, deltaMode: 0, clientX: 200, clientY: 250 });
  clock.advance(70);
  assert.equal(sent.length, 1);
  screen.dispatch("wheel", { deltaY: 40, deltaMode: 0, clientX: 200, clientY: 250 });
  clock.advance(3000); // the in-flight timeout releases the wheel
  clock.advance(100);
  assert.equal(sent.length, 2);
});

test("shift + wheel scrolls sideways and line-mode wheels are converted to pixels", () => {
  const { screen, sent, clock } = makeStage();
  screen.dispatch("wheel", { deltaY: 3, deltaMode: 1, shiftKey: true, clientX: 200, clientY: 250 });
  clock.advance(70);
  assert.equal(sent[0].y1, sent[0].y2, "horizontal");
  assert.ok(sent[0].x2 < sent[0].x1);
});

test("the home button sends home and flashes; it is disabled until a phone is controlled", () => {
  const { home, sent, clock, stage } = makeStage({ mode: "idle" });
  assert.equal(home.disabled, true);
  stage.setMode("control");
  assert.equal(home.disabled, false);
  home.dispatch("click");
  assert.deepEqual(sent, [{ type: "home" }]);
  assert.ok(home.classes.has("pressed"));
  clock.advance(200);
  assert.ok(!home.classes.has("pressed"));
});

test("typing goes through the hidden field: characters batch up, Backspace and Enter map to phone keys", () => {
  const { keyboard, sent, clock } = makeStage();
  keyboard.dispatch("beforeinput", { inputType: "insertText", data: "h" });
  keyboard.dispatch("beforeinput", { inputType: "insertText", data: "i" });
  const backspace = keyboard.dispatch("keydown", { key: "Backspace" });
  assert.equal(backspace.defaultPrevented, true);
  keyboard.dispatch("keydown", { key: "Enter" });
  clock.advance(50);
  assert.deepEqual(sent, [{ type: "type_text", text: "hi\b\n" }]);
});

test("paste, IME composition and Windows line endings are handled", () => {
  const { keyboard, sent, clock } = makeStage();
  keyboard.dispatch("paste", { clipboardData: { getData: () => "line1\r\nline2" } });
  keyboard.dispatch("compositionend", { data: "é" });
  assert.equal(keyboard.value, "");
  clock.advance(50);
  assert.deepEqual(sent, [{ type: "type_text", text: "line1\nline2é" }]);
  keyboard.dispatch("beforeinput", { inputType: "insertCompositionText", data: "x", isComposing: true });
  keyboard.dispatch("keydown", { key: "Backspace", isComposing: true });
  clock.advance(50);
  assert.equal(sent.length, 1, "in-progress composition is not sent early");
});

test("arrow keys scroll the phone and browser shortcuts still work", () => {
  const { keyboard, sent } = makeStage();
  const down = keyboard.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(down.defaultPrevented, true);
  assert.equal(sent[0].type, "drag");
  assert.ok(sent[0].y2 < sent[0].y1);
  const reload = keyboard.dispatch("keydown", { key: "r", ctrlKey: true });
  assert.equal(reload.defaultPrevented, false);
  assert.equal(sent.length, 1);
});

test("typing is ignored unless the phone is controlled", () => {
  const { keyboard, sent, clock } = makeStage({ mode: "watch" });
  keyboard.dispatch("beforeinput", { inputType: "insertText", data: "x" });
  keyboard.dispatch("keydown", { key: "Enter" });
  clock.advance(100);
  assert.deepEqual(sent, []);
});

test("clicking with a mouse focuses the keyboard field; a touch tap does not pop the on-screen keyboard", () => {
  const mouse = makeStage();
  mouse.screen.dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 250 });
  assert.equal(mouse.keyboard.focused, true);
  assert.ok(mouse.frame.classes.has("keyboard-active"));

  const touch = makeStage({ coarse: true });
  touch.screen.dispatch("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 200, clientY: 250 });
  assert.notEqual(touch.keyboard.focused, true);
});

// ---- picture --------------------------------------------------------------------

test("binary frames for the current stream are drawn; stale streams and runts are ignored", async () => {
  const { stage, screen, frame } = makeStage();
  const packet = (streamId, kind = 2, body = [1, 2, 3]) => {
    const bytes = new Uint8Array(5 + body.length);
    bytes[0] = kind;
    new DataView(bytes.buffer).setUint32(1, streamId);
    bytes.set(body, 5);
    return bytes;
  };
  assert.equal(stage.handleBinary(packet(4)), false, "no stream yet");
  stage.setStream(4);
  assert.equal(stage.handleBinary(packet(3)), false, "an old stream's frame");
  assert.equal(stage.handleBinary(new Uint8Array([2, 0, 0, 0, 4])), false, "no image bytes");
  assert.equal(stage.handleBinary(packet(4)), true);
  await new Promise(resolve => setTimeout(resolve, 5));
  const canvas = screen.children[0];
  assert.equal(canvas.width, 90);
  assert.equal(canvas.height, 160);
  assert.equal(canvas.drawn.length, 1);
  assert.ok(frame.classes.has("has-picture"));
});

test("while a frame is decoding, only the newest waiting frame is kept", async () => {
  const clock = manualClock();
  const screen = new FakeElement();
  const decoded = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const stage = new PhoneStage({
    screenEl: screen, send: () => 1, ...clock, createCanvas: fakeCanvas,
    decode: async bytes => { decoded.push(bytes[0]); await gate; return { width: 10, height: 10, close() {} }; },
  });
  stage.showFrame(new Uint8Array([1]), 2);
  stage.showFrame(new Uint8Array([2]), 2);
  stage.showFrame(new Uint8Array([3]), 2);
  release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(decoded, [1, 3], "frame 2 was superseded before it was ever decoded");
  assert.equal(screen.children[0].drawn.length, 2);
});

test("a frame that fails to decode is skipped and the next one still paints", async () => {
  const clock = manualClock();
  const screen = new FakeElement();
  let calls = 0;
  const stage = new PhoneStage({
    screenEl: screen, send: () => 1, ...clock, createCanvas: fakeCanvas,
    decode: async () => { calls += 1; if (calls === 1) throw new Error("corrupt"); return { width: 10, height: 10, close() {} }; },
  });
  stage.showFrame(new Uint8Array([1]), 2);
  await new Promise(resolve => setTimeout(resolve, 5));
  stage.showFrame(new Uint8Array([2]), 2);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(screen.children[0].drawn.length, 1);
});

test("a screenshot from the JSON protocol is drawn on the same canvas (SVG and base64 images)", async () => {
  const seen = [];
  const clock = manualClock();
  const screen = new FakeElement();
  const stage = new PhoneStage({
    screenEl: screen, send: () => 1, ...clock, createCanvas: fakeCanvas,
    decode: async (bytes, kind) => { seen.push({ kind, length: bytes.length }); return { width: 10, height: 10, close() {} }; },
  });
  stage.showLegacyFrame({ kind: "svg", data: "<svg/>" });
  await new Promise(resolve => setTimeout(resolve, 5));
  stage.showLegacyFrame({ kind: "image", mime: "image/png", data: Buffer.from([1, 2, 3, 4]).toString("base64") });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(seen, [{ kind: 3, length: 6 }, { kind: 2, length: 4 }]);
});

test("leaving control mode drops half-finished gestures", () => {
  const { stage, screen, sent } = makeStage();
  screen.dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 250 });
  stage.setMode("idle");
  screen.dispatch("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 200, clientY: 250 });
  assert.deepEqual(sent, []);
});

test("a run of undecodable frames is reported once, and a good frame clears the count", async () => {
  const clock = manualClock();
  const screen = new FakeElement();
  const statuses = [];
  let broken = true;
  const stage = new PhoneStage({
    screenEl: screen, send: () => 1, ...clock, createCanvas: fakeCanvas,
    onStatus: (kind, value) => statuses.push([kind, value]),
    decode: async () => { if (broken) throw new Error("bad image"); return { width: 10, height: 10, close() {} }; },
  });
  for (let index = 0; index < 8; index += 1) {
    stage.showFrame(new Uint8Array([index]), 3);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.deepEqual(statuses, [["decode-error", 5]], "reported exactly once, at the fifth failure");
  broken = false;
  stage.showFrame(new Uint8Array([9]), 3);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(stage.decodeFailures, 0);
  assert.equal(stage.hasPicture, true);
});
