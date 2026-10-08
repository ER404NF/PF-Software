import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// A broken phone's card said the same sentence twice: once in the "Needs attention" block and again in the
// collapsed error row. The row keeps only what the block did not already say.
const context = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { errorRows } = context.window.deviceCardModel;
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../../../client/style.css", import.meta.url), "utf8");
const privacyPage = fs.readFileSync(new URL("../../../client/account-deletion.html", import.meta.url), "utf8");

const I205 = {
  code: "I205", name: "iproxy local port already in use",
  why: "Another program (proxy-tool, process 7421) is using port 38100. Close it, then try again. Bodun will not stop other programs.",
  operatorAction: "Close that program, then use Retry setup. Bodun will not stop other programs.",
  safeState: "Device control remains unavailable.",
};
const labels = rows => Array.from(rows, row => row[0]);

test("without an attention block every row is kept (the phone's detail view)", () => {
  assert.deepEqual(labels(errorRows(I205, "")), ["Error name", "Why", "How to fix", "Error code", "Safe state"]);
  assert.deepEqual(labels(errorRows(I205)), ["Error name", "Why", "How to fix", "Error code", "Safe state"]);
});

test("a row that the attention block already says is dropped; the rest stay", () => {
  const shown = I205.why;
  assert.deepEqual(labels(errorRows(I205, shown)), ["Error name", "How to fix", "Error code", "Safe state"]);
});

test("the usual shape of the attention text (name, then the action) removes both of those rows", () => {
  const shown = `${I205.name}. ${I205.operatorAction}`;
  assert.deepEqual(labels(errorRows(I205, shown)), ["Why", "Error code", "Safe state"]);
});

test("case, spacing and a final full stop do not matter when comparing", () => {
  assert.deepEqual(labels(errorRows({ name: "Port in use", why: "It is busy.", code: "X1" }, "  PORT   IN USE. it is busy ")), ["Error code"]);
});

test("attention text that is a DIFFERENT sentence from the error removes nothing", () => {
  assert.deepEqual(labels(errorRows(I205, "Setting up WDA and the device tunnel automatically.")), ["Error name", "Why", "How to fix", "Error code", "Safe state"]);
});

test("empty fields never become empty rows", () => {
  assert.deepEqual(labels(errorRows({ code: "Z9", name: "", why: null }, "")), ["Error code"]);
});

test("the card passes the attention text only when that block is on the card, and titles the row 'Details' only then", () => {
  assert.match(app, /deviceCardModel\.errorRows\(error, shownText\)/);
  assert.match(app, /buildDeviceErrorCard\(d, null, attentionText\)/);
  assert.match(app, /heading\.textContent = shownText \? "Details"/);
});

test("the Privacy Center uses the app font for its headlines (no serif display font)", () => {
  assert.doesNotMatch(css, /Georgia|Times New Roman/);
  assert.match(css, /\.privacy-hero h1 \{[^}]*max-width: 14ch/);
  assert.match(privacyPage, /theme-bootstrap/);
});

test("the attention block and the error row have light-theme colours, not only the dark ones", () => {
  assert.match(css, /:root:not\(\[data-theme="dark"\]\) \.device-attention \{/);
  assert.match(css, /:root:not\(\[data-theme="dark"\]\) \.device-error-card \{/);
});

test("regression: the attention block's own elements never reuse the name that carries the attention text (it threw before the fleet could draw)", () => {
  const start = app.indexOf("let attentionText");
  const block = app.slice(start, app.indexOf("const errorCard = buildDeviceErrorCard(d, null, attentionText)"));
  assert.doesNotMatch(block, /const attentionText\b/);
  assert.match(block, /attentionText = presentation\.message;/);
});

test("regression: the empty-fleet note always says why, never the leftover 'Refreshing fleet access…'", () => {
  const block = app.slice(app.indexOf("function renderFleet("), app.indexOf("function sayOnCard") > 0 ? app.indexOf("// Where the result of an action on a phone's card goes") : app.length);
  assert.match(block, /fleetEmptyEl\.hidden = visibleDevices\.length > 0;/);
  assert.match(block, /fleetEmptyEl\.textContent = devices\.length === 0 \? "No phones are available to you yet\." : "No phones match this filter\.";/);
});
