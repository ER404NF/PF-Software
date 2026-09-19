import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamHub } from "../../src/streamHub.js";

// A device whose upstream we drive by hand.
function fakeDevice(id = "dev-1") {
  const device = {
    id,
    supportsStream: true,
    opened: 0,
    closed: 0,
    emit: null,
    setState: null,
    openStream({ onFrame, onState }) {
      device.opened += 1;
      device.emit = onFrame;
      device.setState = onState;
      return { close: () => { device.closed += 1; } };
    },
  };
  return device;
}

// Deterministic timers so "3 seconds later" needs no real waiting.
function manualTimers() {
  let now = 0;
  const pending = [];
  return {
    now: () => now,
    setTimeoutFn: (fn, ms) => { const timer = { fn, at: now + ms, cancelled: false, unref() {} }; pending.push(timer); return timer; },
    clearTimeoutFn: timer => { if (timer) timer.cancelled = true; },
    advance(ms) {
      now += ms;
      for (const timer of pending.filter(item => !item.cancelled && item.at <= now)) { timer.cancelled = true; timer.fn(); }
    },
  };
}

test("only stream-capable devices can be subscribed", () => {
  const hub = new StreamHub();
  assert.equal(hub.subscribe({ id: "mock" }, { onFrame() {} }), null);
  assert.equal(hub.subscribe({ id: "x", supportsStream: false, openStream() {} }, { onFrame() {} }), null);
});

test("many viewers share ONE upstream, and each receives every frame", () => {
  const hub = new StreamHub();
  const device = fakeDevice();
  const a = [];
  const b = [];
  hub.subscribe(device, { onFrame: frame => a.push(frame) });
  hub.subscribe(device, { onFrame: frame => b.push(frame) });
  assert.equal(device.opened, 1);
  device.emit(Buffer.from("f1"));
  device.emit(Buffer.from("f2"));
  assert.deepEqual(a.map(String), ["f1", "f2"]);
  assert.deepEqual(b.map(String), ["f1", "f2"]);
  assert.equal(hub.stats("dev-1").viewers, 2);
});

test("a late viewer immediately gets the newest frame instead of a blank screen", () => {
  const hub = new StreamHub();
  const device = fakeDevice();
  hub.subscribe(device, { onFrame() {} });
  device.emit(Buffer.from("old"));
  device.emit(Buffer.from("newest"));
  const late = [];
  hub.subscribe(device, { onFrame: frame => late.push(String(frame)) });
  assert.deepEqual(late, ["newest"]);
});

test("a viewer that throws never disturbs the phone or the other viewers", () => {
  const hub = new StreamHub();
  const device = fakeDevice();
  const good = [];
  hub.subscribe(device, { onFrame() { throw new Error("slow client exploded"); } });
  hub.subscribe(device, { onFrame: frame => good.push(String(frame)) });
  assert.doesNotThrow(() => device.emit(Buffer.from("x")));
  assert.deepEqual(good, ["x"]);
});

test("the upstream closes only after the last viewer leaves and a grace period passes", () => {
  const timers = manualTimers();
  const hub = new StreamHub({ ...timers, idleCloseMs: 3000 });
  const device = fakeDevice();
  const first = hub.subscribe(device, { onFrame() {} });
  const second = hub.subscribe(device, { onFrame() {} });
  first.unsubscribe();
  timers.advance(10_000);
  assert.equal(device.closed, 0, "still one viewer");
  second.unsubscribe();
  timers.advance(2999);
  assert.equal(device.closed, 0, "inside the grace period");
  timers.advance(2);
  assert.equal(device.closed, 1);
  assert.equal(hub.stats("dev-1").state, "idle");
});

test("re-subscribing inside the grace period reuses the same upstream", () => {
  const timers = manualTimers();
  const hub = new StreamHub({ ...timers, idleCloseMs: 3000 });
  const device = fakeDevice();
  hub.subscribe(device, { onFrame() {} }).unsubscribe();
  timers.advance(1000);
  hub.subscribe(device, { onFrame() {} });
  timers.advance(60_000);
  assert.equal(device.opened, 1);
  assert.equal(device.closed, 0);
});

test("after the upstream closed, a new viewer opens a fresh one", () => {
  const timers = manualTimers();
  const hub = new StreamHub({ ...timers, idleCloseMs: 100 });
  const device = fakeDevice();
  hub.subscribe(device, { onFrame() {} }).unsubscribe();
  timers.advance(200);
  hub.subscribe(device, { onFrame() {} });
  assert.equal(device.opened, 2);
});

test("state changes reach every viewer, and the first frame flips the state to live", () => {
  const hub = new StreamHub();
  const device = fakeDevice();
  const states = [];
  hub.subscribe(device, { onFrame() {}, onState: (state, detail) => states.push([state, detail ?? null]) });
  device.setState("reconnecting", "usb dropped");
  device.emit(Buffer.from("x"));
  assert.deepEqual(states, [["connecting", null], ["reconnecting", "usb dropped"], ["live", null]]);
});

test("frame rate is measured over a sliding window", () => {
  const timers = manualTimers();
  const hub = new StreamHub({ ...timers });
  const device = fakeDevice();
  hub.subscribe(device, { onFrame() {} });
  for (let i = 0; i < 30; i += 1) { timers.advance(100); device.emit(Buffer.from("x")); }
  assert.ok(hub.stats("dev-1").fps >= 8 && hub.stats("dev-1").fps <= 12, `fps was ${hub.stats("dev-1").fps}`);
});

test("closeAll drops every upstream immediately", () => {
  const hub = new StreamHub();
  const a = fakeDevice("a");
  const b = fakeDevice("b");
  hub.subscribe(a, { onFrame() {} });
  hub.subscribe(b, { onFrame() {} });
  hub.closeAll();
  assert.equal(a.closed + b.closed, 2);
});

test("a re-provisioned device replaces the old upstream and tells its viewers", () => {
  const hub = new StreamHub();
  const oldDevice = fakeDevice("phone");
  const states = [];
  hub.subscribe(oldDevice, { onFrame() {}, onState: (state, detail) => states.push([state, detail ?? null]) });
  const newDevice = fakeDevice("phone");
  const fresh = [];
  hub.subscribe(newDevice, { onFrame: frame => fresh.push(String(frame)) });
  assert.equal(oldDevice.closed, 1, "old upstream closed");
  assert.equal(newDevice.opened, 1);
  assert.deepEqual(states.at(-1), ["closed", "device replaced"]);
  newDevice.emit(Buffer.from("x"));
  assert.deepEqual(fresh, ["x"]);
});
