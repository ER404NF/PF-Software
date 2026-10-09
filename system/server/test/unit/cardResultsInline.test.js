import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../../../client/index.html", import.meta.url), "utf8");

// The source of a top-level function, from its declaration to the next top-level declaration.
function body(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  const rest = app.slice(start + 10);
  const end = rest.search(/\n(?:async function |function |const |let |\/\/ )/);
  return app.slice(start, start + 10 + (end < 0 ? rest.length : end));
}

// Every function that handles a click on a fleet card must show its result on that card.
const CARD_BUILDERS = [
  "buildProxySwitch", "buildNetworkCheckButton", "buildWdaLifecyclePanel",
  "buildProxyPoolPicker", "triggerRoutingAction", "cancelEnrollment", "retryDeviceDiagnostic",
  "buildDeviceErrorCard", "buildNetworkRoutingPanel", "requestDeviceOpen", "requestDeviceWatch",
];

test("no card-level handler writes its result to the shared page-top line", () => {
  for (const name of CARD_BUILDERS) {
    const source = body(name);
    // requestDeviceOpen/Watch keep the page line only to clear it, and as the fallback when there is no phone
    // to attach the reason to
    const uses = [...source.matchAll(/selectErrorEl/g)].length;
    const allowed = { requestDeviceOpen: 1, requestDeviceWatch: 2 }[name] ?? 0;
    assert.ok(uses <= allowed, `${name} uses the page-level line ${uses} time(s), at most ${allowed} allowed`);
  }
});

test("every card has its own live message line, bound to its phone", () => {
  assert.match(app, /const cardMessage = document\.createElement\("p"\);[\s\S]*cardMessages\.attach\(d\.id, cardMessage\);/);
  assert.match(app, /cardMessage\.setAttribute\("aria-live", "polite"\)/);
});

test("the page-level line is a live region, fades after a few seconds and is cleared when the page changes", () => {
  assert.match(html, /<p id="select-error" role="status" aria-live="polite"><\/p>/);
  assert.match(app, /const PAGE_MESSAGE_TTL_MS = 8000;/);
  assert.match(app, /new MutationObserver\(/);
  assert.match(app, /lastNavView !== currentView\) \{ clearPageMessage\(\); cardMessages\.clearAll\(\); \}/);
});

test("the enrollment instruction says System Settings, never System Preferences", () => {
  assert.doesNotMatch(app, /System Preferences/);
  assert.match(app, /Open System Settings, then General, then Sharing\./);
});

test("the enrollment card offers Cancel, a countdown and a reason for a blocked Start", () => {
  const panel = body("buildNetworkRoutingPanel");
  assert.match(panel, /Cancel enrollment/);
  assert.match(panel, /routing-countdown/);
  assert.match(panel, /routing-reason/);
  assert.match(body("networkRoutingNextAction"), /Another phone \(\$\{enrollment\.otherLabel\}\) is being set up for networking\. Cancel it or wait/);
  assert.match(app, /\/network-enrollment`, \{ method: "DELETE" \}/);
});
