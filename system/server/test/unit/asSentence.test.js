import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Found by the real-click sweep: "daily and weekly assignments require a schedule The assignment was not created."
// (lower case, no full stop). Server messages are shown as sentences wherever the page shows them.
const context = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { asSentence } = context.window.deviceCardModel;
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");

test("a message becomes a sentence: capital letter, full stop", () => {
  assert.equal(asSentence("daily and weekly assignments require a schedule"), "Daily and weekly assignments require a schedule.");
  assert.equal(asSentence("password must be 12-512 characters"), "Password must be 12-512 characters.");
  assert.equal(asSentence("  spaces around  "), "Spaces around.");
});

test("a message that is already a sentence is left alone", () => {
  assert.equal(asSentence("Already done."), "Already done.");
  assert.equal(asSentence("Really?"), "Really?");
  assert.equal(asSentence("Stop!"), "Stop!");
  assert.equal(asSentence("Plain text (see below)."), "Plain text (see below).");
  assert.equal(asSentence("Wait…"), "Wait…");
});

test("empty or odd input never throws", () => {
  assert.equal(asSentence(""), "");
  assert.equal(asSentence(null), "");
  assert.equal(asSentence(undefined), "");
  assert.equal(asSentence("1 phone is busy"), "1 phone is busy.");
});

test("errors from the server are shown as sentences, and an added hint is not glued on without a stop", () => {
  assert.match(app, /const base = deviceCardModel\.asSentence\(body\?\.error \|\| `Bodun rejected the request \(HTTP \$\{response\.status\}\)\.`\);/);
  assert.match(app, /throw new RequestFailure\(action \? `\$\{base\} \$\{action\}` : base,/);
});
