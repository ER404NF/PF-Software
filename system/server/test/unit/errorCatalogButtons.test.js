import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ERROR_CATALOG } from "../../src/errorCatalog.js";

// Found by the real-click sweep: several "what to do" sentences told the operator to press "Retry Automatic Setup"
// (or "retry automatic setup"), but no button has that name; the phone card's button says "Retry setup". A sentence that
// names a button must name one that exists. One sentence also said "a bounded per-device route rebuild".
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");
const sentences = Object.values(ERROR_CATALOG).map(entry => entry.operatorAction).filter(Boolean);

test("no what-to-do sentence names a retry button that does not exist", () => {
  for (const text of sentences) assert.doesNotMatch(text, /retry automatic setup/i, text);
});

test("WDA guidance names lifecycle actions and only iproxy guidance names its contextual retry", () => {
  assert.equal(sentences.filter(text => /Retry setup/.test(text)).length, 0);
  assert.ok(sentences.some(text => /Start WDA/.test(text)));
  assert.ok(sentences.some(text => /Restart WDA/.test(text)));
  assert.ok(sentences.some(text => /Retry USB tunnel/.test(text)));
  assert.doesNotMatch(app, /button\.textContent = "Retry setup";/);
  assert.match(app, /"Retry USB tunnel"/);
});

test("the what-to-do sentences do not use the internal word 'bounded'", () => {
  for (const text of sentences) assert.doesNotMatch(text, /bounded/i, text);
});
