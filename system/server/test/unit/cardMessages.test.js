import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Client scripts are plain browser scripts; load one the way a browser would.
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/cardMessages.js", import.meta.url), "utf8"), context);
const { createCardMessages } = context.window;

function element() { return { textContent: "", hidden: true, dataset: {}, isConnected: true }; }
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeoutFn: fn => { const id = next++; pending.set(id, fn); return id; },
    clearTimeoutFn: id => pending.delete(id),
    fire: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    count: () => pending.size,
  };
}

test("a message is shown on the element bound to that phone and nowhere else", () => {
  const messages = createCardMessages();
  const a = element();
  const b = element();
  messages.attach("phone-a", a);
  messages.attach("phone-b", b);
  messages.show("phone-a", "Retrying setup.", "info");
  assert.equal(a.textContent, "Retrying setup.");
  assert.equal(a.hidden, false);
  assert.equal(a.dataset.tone, "info");
  assert.equal(b.textContent, "");
  assert.equal(b.hidden, true);
});

test("the message survives a re-render: a new element for the same phone shows it at once", () => {
  const messages = createCardMessages();
  messages.show("phone-a", "Port 8101 is used by another program.", "error");
  const rebuilt = element();
  messages.attach("phone-a", rebuilt);
  assert.equal(rebuilt.textContent, "Port 8101 is used by another program.");
  assert.equal(rebuilt.dataset.tone, "error");
});

test("a disconnected old element is dropped and never written to again", () => {
  const messages = createCardMessages();
  const old = element();
  messages.attach("phone-a", old);
  old.isConnected = false;
  messages.show("phone-a", "x", "info");
  assert.equal(old.textContent, "");
});

test("a success fades after its time; an error stays until the next action", () => {
  const timers = fakeTimers();
  const messages = createCardMessages({ ...timers });
  const el = element();
  messages.attach("phone-a", el);
  messages.show("phone-a", "WDA is starting.", "success");
  assert.equal(timers.count(), 1);
  timers.fire();
  assert.equal(el.hidden, true);
  assert.equal(messages.get("phone-a"), null);

  messages.show("phone-a", "Could not stop.", "error");
  assert.equal(timers.count(), 0, "no timer for an error");
  messages.begin("phone-a"); // the operator acts again
  assert.equal(messages.get("phone-a"), null);
});

test("showing a new message replaces the old one and cancels its fade timer", () => {
  const timers = fakeTimers();
  const messages = createCardMessages({ ...timers });
  messages.show("phone-a", "first", "success");
  messages.show("phone-a", "second", "error");
  assert.equal(timers.count(), 0);
  assert.equal(messages.get("phone-a").text, "second");
});

test("clearAll empties every phone (leaving the page)", () => {
  const messages = createCardMessages();
  const a = element();
  messages.attach("phone-a", a);
  messages.show("phone-a", "x", "info");
  messages.show("phone-b", "y", "error");
  messages.clearAll();
  assert.equal(messages.get("phone-a"), null);
  assert.equal(messages.get("phone-b"), null);
  assert.equal(a.hidden, true);
});

test("an unknown tone is treated as info and an empty message clears", () => {
  const messages = createCardMessages();
  assert.equal(messages.show("phone-a", "hello", "loud").tone, "info");
  messages.show("phone-a", "", "info");
  assert.equal(messages.get("phone-a"), null);
});

test("a card that is built before it is placed on the page still gets the current message", () => {
  const messages = createCardMessages();
  messages.show("phone-a", "Port 8101 is used by another program.", "error");
  const building = element();
  building.isConnected = false; // not on the page yet
  messages.attach("phone-a", building);
  assert.equal(building.textContent, "Port 8101 is used by another program.");
  building.isConnected = true;
  messages.show("phone-a", "Next message", "info");
  assert.equal(building.textContent, "Next message");
});

test("forgetting the previous render's elements happens when the next card is attached", () => {
  const messages = createCardMessages();
  const first = element();
  messages.attach("phone-a", first);
  first.isConnected = false;
  const second = element();
  second.isConnected = false;
  messages.attach("phone-a", second);
  second.isConnected = true;
  messages.show("phone-a", "only the new card", "info");
  assert.equal(first.textContent, "");
  assert.equal(second.textContent, "only the new card");
});
