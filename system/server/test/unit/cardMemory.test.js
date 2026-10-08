import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Found by the real-click sweep: the fleet is redrawn about every ten seconds, and each redraw built a phone's cards
// from scratch, so an opened "Details" row, the Diagnostics output and the control report all vanished a few seconds
// after the operator opened them. The card now remembers what is open for each phone.
const context = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { createCardMemory } = context.window.deviceCardModel;
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");

test("the memory keeps what was opened for each phone separately", () => {
  const memory = createCardMemory();
  assert.deepEqual({ ...memory.get("a") }, {});
  memory.update("a", { open: true });
  memory.update("a", { diagnostics: "Device id: 1" });
  memory.update("b", { open: false });
  assert.equal(memory.get("a").open, true);
  assert.equal(memory.get("a").diagnostics, "Device id: 1");
  assert.equal(memory.get("b").open, false);
  assert.equal(memory.get("b").diagnostics, undefined);
});

test("clearing a phone forgets it, and pruning forgets phones that are gone", () => {
  const memory = createCardMemory();
  memory.update("a", { open: true });
  memory.update("b", { open: true });
  memory.update("c", { open: true });
  memory.clear("a");
  assert.deepEqual({ ...memory.get("a") }, {});
  memory.prune(new Set(["b"]));
  assert.equal(memory.get("b").open, true);
  assert.deepEqual({ ...memory.get("c") }, {});
});

test("the error panel restores its open state and its Diagnostics output after a redraw", () => {
  assert.match(app, /const errorCardMemory = deviceCardModel\.createCardMemory\(\);/);
  assert.match(app, /details\.open = Boolean\(errorCardMemory\.get\(device\.id\)\.open\);/);
  assert.match(app, /details\.addEventListener\("toggle", \(\) => errorCardMemory\.update\(device\.id, \{ open: details\.open \}\)\);/);
  assert.match(app, /errorCardMemory\.update\(device\.id, \{ diagnostics: output\.textContent \}\);/);
  assert.match(app, /if \(remembered\.diagnostics\) \{\s*output\.textContent = remembered\.diagnostics;\s*output\.hidden = false;/);
});

test("a phone with no error forgets its error panel state", () => {
  assert.match(app, /if \(!error\) \{\s*errorCardMemory\.clear\(device\.id\);\s*return null;/);
});

test("the control report is remembered and drawn again when the panel is rebuilt", () => {
  assert.match(app, /const wdaReportMemory = deviceCardModel\.createCardMemory\(\);/);
  assert.match(app, /wdaReportMemory\.update\(device\.id, \{ diagnostic \}\);/);
  assert.match(app, /const rememberedReport = wdaReportMemory\.get\(device\.id\)\.diagnostic;\s*if \(rememberedReport\) renderControlDiagnostic\(rememberedReport\);/);
});

test("memory of phones that left the fleet is dropped when the fleet is drawn", () => {
  assert.match(app, /errorCardMemory\.prune\(new Set\(devices\.map\(device => device\.id\)\)\);\s*wdaReportMemory\.prune/);
});
