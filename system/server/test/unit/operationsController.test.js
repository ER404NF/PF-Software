import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client/operationsController.js"), "utf8"), context);
const { createOperationsController } = context.window;

function fixture() {
  const panels = new Map(["one", "two", "three"].map(id => [id, { id, hidden: true, focused: false,
    focus() { this.focused = true; } }]));
  const links = [...panels.keys()].map(id => ({ dataset: { operationsTarget: id }, hidden: true, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; } }));
  const locationRef = { hash: "" };
  const historyRef = { replaceState(_a, _b, value) { locationRef.hash = value; } };
  const controller = createOperationsController({ links, documentRef: { getElementById: id => panels.get(id) },
    locationRef, historyRef, initialPanelId: "one" });
  return { panels, links, locationRef, controller };
}

test("operations controller exposes exactly one permitted panel and falls back after demotion", () => {
  const f = fixture();
  assert.equal(f.controller.sync(new Map([["one", true], ["two", true], ["three", false]])), "one");
  assert.deepEqual([...f.panels.values()].filter(panel => !panel.hidden).map(panel => panel.id), ["one"]);
  assert.equal(f.controller.sync(new Map([["one", false], ["two", true], ["three", false]])), "two");
  assert.deepEqual([...f.panels.values()].filter(panel => !panel.hidden).map(panel => panel.id), ["two"]);
});

test("operations controller honors permitted deep links and rejects forbidden selection", () => {
  const f = fixture();
  const allowed = new Map([["one", true], ["two", true], ["three", false]]);
  f.locationRef.hash = "#two";
  assert.equal(f.controller.sync(allowed), "two");
  assert.equal(f.controller.select("three", allowed), false);
  assert.equal(f.controller.select("one", allowed), true);
  assert.equal(f.locationRef.hash, "#one");
  assert.equal(f.panels.get("one").focused, true);
});

// ---- Round 2: the clicked panel is always the one shown ----------------------------------------------------------
// Two kinds of address: one that behaves like a browser (replaceState changes the hash) and one that never changes.
const REAL_PANELS = ["command-console-panel", "queue-panel", "pending-panel", "users-panel", "sites-panel", "proxy-pool-panel", "audit-panel"];

function realFixture({ liveAddress = true, hash = "" } = {}) {
  const panels = new Map(REAL_PANELS.map(id => [id, { id, hidden: true, focus() {} }]));
  const links = REAL_PANELS.map(id => ({ dataset: { operationsTarget: id }, hidden: true, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; } }));
  const locationRef = { hash };
  const writes = [];
  const historyRef = { replaceState(_a, _b, value) { writes.push(value); if (liveAddress) locationRef.hash = value; } };
  const controller = createOperationsController({ links, documentRef: { getElementById: id => panels.get(id) }, locationRef, historyRef,
    initialPanelId: REAL_PANELS[0] });
  const visible = () => [...panels.values()].filter(panel => !panel.hidden).map(panel => panel.id);
  const current = () => links.filter(link => link.attributes["aria-current"] === "page").map(link => link.dataset.operationsTarget);
  return { panels, links, locationRef, controller, visible, current, writes };
}
const everything = () => new Map(REAL_PANELS.map(id => [id, true]));
const nothing = () => new Map(REAL_PANELS.map(id => [id, false]));
const only = (...ids) => new Map(REAL_PANELS.map(id => [id, ids.includes(id)]));

for (const liveAddress of [true, false]) {
  for (const startHash of ["", "#queue-panel"]) {
    const label = `address ${liveAddress ? "updates" : "never updates"}, starts ${startHash || "empty"}`;

    test(`a click always shows the clicked panel, after every click in a long sequence (${label})`, () => {
      const f = realFixture({ liveAddress, hash: startHash });
      const allowed = everything();
      f.controller.sync(allowed);
      for (const id of ["queue-panel", "users-panel", "command-console-panel", "users-panel", "queue-panel", "audit-panel", "audit-panel", "sites-panel"]) {
        assert.equal(f.controller.select(id, allowed), true);
        assert.deepEqual(f.visible(), [id], `after clicking ${id}`);
        assert.deepEqual(f.current(), [id], `aria-current after clicking ${id}`);
        assert.equal(f.controller.activePanel(), id);
      }
    });

    test(`every tab to every other tab shows the right panel, all 42 ordered pairs (${label})`, () => {
      let pairs = 0;
      for (const from of REAL_PANELS) {
        for (const to of REAL_PANELS.filter(id => id !== from)) {
          const f = realFixture({ liveAddress, hash: startHash });
          const allowed = everything();
          f.controller.sync(allowed);
          f.controller.select(from, allowed);
          f.controller.select(to, allowed);
          assert.deepEqual(f.visible(), [to], `${from} then ${to}`);
          assert.deepEqual(f.current(), [to], `${from} then ${to}`);
          pairs += 1;
        }
      }
      assert.equal(pairs, 42);
    });

    test(`device-list refreshes between clicks never change the shown panel (${label})`, () => {
      const f = realFixture({ liveAddress, hash: startHash });
      const allowed = everything();
      f.controller.sync(allowed);
      for (const id of ["users-panel", "queue-panel", "sites-panel"]) {
        f.controller.select(id, allowed);
        for (let refresh = 0; refresh < 5; refresh += 1) f.controller.sync(allowed);
        assert.deepEqual(f.visible(), [id]);
      }
    });
  }
}

test("a page opened on a permitted deep link shows it once, and a later click is not overridden by that link", () => {
  const f = realFixture({ hash: "#users-panel" });
  const allowed = everything();
  assert.equal(f.controller.sync(allowed), "users-panel");
  assert.deepEqual(f.visible(), ["users-panel"]);
  f.controller.select("queue-panel", allowed);
  f.controller.sync(allowed);
  assert.deepEqual(f.visible(), ["queue-panel"]);
});

test("a deep link to a panel the person may not see falls back to the first allowed panel and the address is corrected", () => {
  const f = realFixture({ hash: "#audit-panel" });
  f.controller.sync(only("command-console-panel", "queue-panel"));
  assert.deepEqual(f.visible(), ["command-console-panel"]);
  assert.equal(f.locationRef.hash, "#command-console-panel");
});

test("an address edited by hand after a click is honoured once, and a later click wins again", () => {
  const f = realFixture({ liveAddress: true });
  const allowed = everything();
  f.controller.sync(allowed);
  f.controller.select("queue-panel", allowed);
  f.locationRef.hash = "#sites-panel"; // the person edits the address (a hashchange follows in the browser)
  f.controller.sync(allowed);
  assert.deepEqual(f.visible(), ["sites-panel"]);
  f.controller.sync(allowed);
  assert.deepEqual(f.visible(), ["sites-panel"], "a second sync does not re-adopt or undo it");
  f.controller.select("users-panel", allowed);
  assert.deepEqual(f.visible(), ["users-panel"]);
});

test("demotion falls back to an allowed panel and a later promotion does not snap back to the old address", () => {
  const f = realFixture({ liveAddress: true });
  f.controller.sync(everything());
  f.controller.select("audit-panel", everything());
  f.controller.sync(only("command-console-panel", "queue-panel")); // demoted: audit and the rest are gone
  assert.deepEqual(f.visible(), ["command-console-panel"]);
  f.controller.sync(everything()); // promoted again
  assert.deepEqual(f.visible(), ["command-console-panel"], "no snap-back to the panel left behind");
  f.controller.select("sites-panel", everything());
  assert.deepEqual(f.visible(), ["sites-panel"]);
});

test("a live role change that removes the open panel falls back to the first allowed one and clicks still work", () => {
  const f = realFixture({ liveAddress: false });
  f.controller.sync(everything());
  f.controller.select("users-panel", everything());
  assert.equal(f.controller.sync(only("queue-panel", "audit-panel")), "queue-panel");
  assert.deepEqual(f.visible(), ["queue-panel"]);
  assert.equal(f.controller.select("users-panel", only("queue-panel", "audit-panel")), false, "a forbidden panel is refused");
  assert.deepEqual(f.visible(), ["queue-panel"]);
  f.controller.select("audit-panel", only("queue-panel", "audit-panel"));
  assert.deepEqual(f.visible(), ["audit-panel"]);
});

test("selecting a forbidden or unknown panel changes nothing", () => {
  const f = realFixture({ liveAddress: true });
  const allowed = only("command-console-panel", "queue-panel");
  f.controller.sync(allowed);
  f.controller.select("queue-panel", allowed);
  const writesBefore = f.writes.length;
  assert.equal(f.controller.select("audit-panel", allowed), false);
  assert.equal(f.controller.select("no-such-panel", allowed), false);
  assert.deepEqual(f.visible(), ["queue-panel"]);
  assert.equal(f.writes.length, writesBefore, "the address is not touched");
});

test("signing out and back in keeps the panel that was open", () => {
  for (const liveAddress of [true, false]) {
    const f = realFixture({ liveAddress });
    const allowed = everything();
    f.controller.sync(allowed);
    f.controller.select("queue-panel", allowed);
    f.controller.sync(nothing()); // signed out: nothing is allowed
    assert.deepEqual(f.visible(), [], "nothing is shown while signed out");
    f.controller.sync(allowed); // signed in again
    assert.deepEqual(f.visible(), ["queue-panel"], `the open panel returns (address ${liveAddress ? "updates" : "never updates"})`);
  }
});

test("a deep link waiting while signed out is shown after sign-in", () => {
  const f = realFixture({ hash: "#sites-panel" });
  f.controller.sync(nothing()); // the page loads before sign-in
  assert.deepEqual(f.visible(), []);
  f.controller.sync(everything()); // the person signs in
  assert.deepEqual(f.visible(), ["sites-panel"]);
});

test("an empty address is left alone: nothing is written unless a panel is chosen or a stale address must be corrected", () => {
  const f = realFixture({ hash: "" });
  f.controller.sync(everything());
  f.controller.sync(everything());
  assert.deepEqual(f.writes, []);
});

test("the page listens for address changes so an edited address still switches the panel", () => {
  const app = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client/app.js"), "utf8");
  assert.match(app, /window\.addEventListener\("hashchange", syncOperationsNavigation\);/);
});

test("two address-change events in a row leave the same panel shown", () => {
  const f = realFixture({ liveAddress: true });
  const allowed = everything();
  f.controller.sync(allowed);
  f.controller.select("queue-panel", allowed);
  f.locationRef.hash = "#sites-panel";
  f.controller.sync(allowed);
  f.controller.sync(allowed);
  assert.deepEqual(f.visible(), ["sites-panel"]);
});
