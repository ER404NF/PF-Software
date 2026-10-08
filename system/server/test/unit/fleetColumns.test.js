import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Found by the broken-phone demo: with five phones the fleet grid always used four columns, which at a 1180px window
// is wider than the page, so cards were cut off at the sides.
const context = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { fleetColumnCount } = context.window.deviceCardModel;
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");

test("the fleet uses as many columns as fit, never more than four and never more than there are phones", () => {
  assert.equal(fleetColumnCount(1, 5000), 1);
  assert.equal(fleetColumnCount(2, 5000), 2);
  assert.equal(fleetColumnCount(9, 5000), 4);
  assert.equal(fleetColumnCount(5, 1360), 4, "the wide window keeps four");
  assert.equal(fleetColumnCount(5, 865), 3, "the 1180px window fits three");
  assert.equal(fleetColumnCount(5, 994), 4, "exactly four cards and their gaps");
  assert.equal(fleetColumnCount(5, 993), 3);
  assert.equal(fleetColumnCount(5, 480), 1);
});

test("an unknown or tiny width still gives one column, and a hidden page falls back to a sensible count", () => {
  assert.equal(fleetColumnCount(3, 0), 3, "a hidden view has no width yet: assume a wide window");
  assert.equal(fleetColumnCount(3, undefined), 3);
  assert.equal(fleetColumnCount(0, 1000), 1);
  assert.equal(fleetColumnCount(4, 100), 1);
});

test("the page counts columns from the width available and redraws when the window crosses a threshold", () => {
  assert.match(app, /deviceCardModel\.fleetColumnCount\(groupDevices\.length, fleetGroupsEl\.clientWidth\)/);
  assert.match(app, /window\.addEventListener\("resize", refreshFleetLayout\)/);
  assert.match(app, /function refreshFleetLayout\(\)/);
});
