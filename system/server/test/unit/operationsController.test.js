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
