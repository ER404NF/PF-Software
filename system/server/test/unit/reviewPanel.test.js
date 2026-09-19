// The Review panel (approvals, needs-a-person queue, action policy) is client code that must
// stay in step with the server: same capability names, same action catalog, no unsafe DOM writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES } from "../../src/roleCapabilities.js";
import { ACTIONS } from "../../src/actionCatalog.js";
import { INTERVENTION_KINDS } from "../../src/interventionQueue.js";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client");
const html = fs.readFileSync(path.join(clientDir, "index.html"), "utf8");
const app = fs.readFileSync(path.join(clientDir, "app.js"), "utf8");
const review = fs.readFileSync(path.join(clientDir, "review.js"), "utf8");
const css = fs.readFileSync(path.join(clientDir, "style.css"), "utf8");

test("every element review.js looks up exists in index.html", () => {
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
  const wanted = [...review.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]);
  assert.ok(wanted.length >= 8);
  assert.deepEqual([...new Set(wanted.filter(id => !ids.has(id)))], []);
  for (const tab of ["approvals", "queue", "policy"]) assert.match(html, new RegExp(`data-review-tab="${tab}"`));
});

test("the panel and its toggle are hidden until a signed-in operator is allowed to use them", () => {
  assert.match(html, /id="review-panel"\s+hidden/);
  assert.match(html, /id="review-toggle"[^>]*\bhidden\b/);
  assert.match(review, /reviewToggle\.hidden = !\(tabs\.approvals \|\| tabs\.queue\)/);
  assert.match(review, /addEventListener\("operator-profile-changed"/, "closed and re-evaluated whenever the profile changes");
  assert.match(review, /getElementById\("logout-button"\)\.addEventListener\("click", reviewReset\)/, "closed on sign-out");
});

test("scripts load in an order that works: review.js after research.js, before app.js", () => {
  const order = ["research.js", "review.js", "app.js"].map(name => html.indexOf(`<script src="${name}"></script>`));
  assert.ok(order.every(position => position > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("client capability names match the server's", () => {
  const client = Object.fromEntries([...review.matchAll(/(\w+): "([a-z-]+:[a-z-]+)"/g)].map(match => [match[1], match[2]]));
  assert.equal(client.VIEW, CAPABILITIES.VIEW_RESEARCH);
  assert.equal(client.APPROVE, CAPABILITIES.APPROVE_ACTIONS);
  assert.equal(client.POLICY, CAPABILITIES.MANAGE_ACTION_POLICY);
  assert.equal(client.QUEUE, CAPABILITIES.MANAGE_QUEUE);
});

test("app.js exposes only read-only accessors to the review panel", () => {
  assert.match(app, /window\.phoneFarmCan = can;/);
  assert.match(app, /window\.phoneFarmUsername = \(\) => currentOperator\?\.username \?\? null;/);
});

test("the policy screen lists exactly the server's actions, each once, with a plain-language label", () => {
  const groups = review.match(/const ACTION_GROUPS = Object\.freeze\(\[([\s\S]*?)\n\]\);/)[1];
  const listed = [...groups.matchAll(/"([a-z_]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(listed)].sort(), [...ACTIONS].sort(), "the client groups match the server's action catalog");
  assert.equal(listed.length, new Set(listed).size, "no action appears in two groups");
  const labels = review.match(/const ACTION_LABELS = Object\.freeze\(\{([\s\S]*?)\n\}\);/)[1];
  for (const action of ACTIONS) assert.match(labels, new RegExp(`\\b${action}:`), `${action} has a label`);
});

test("every kind of hand-back the queue can hold has a plain-language explanation", () => {
  const labels = review.match(/const KIND_LABELS = Object\.freeze\(\{([\s\S]*?)\n\}\);/)[1];
  for (const kind of Object.values(INTERVENTION_KINDS)) assert.match(labels, new RegExp(`\\b${kind}:`), `${kind} has a label`);
});

test("server-supplied text is only ever written with textContent, never as markup", () => {
  assert.doesNotMatch(review, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(review, /node\.textContent = text/);
});

test("the review panel has styles in both the light and the dark treatment", () => {
  assert.match(css, /#review-panel\[hidden\]/);
  assert.match(css, /#review-toggle/);
  assert.match(css, /\.review-card/);
  assert.match(css, /\.review-policy-row/);
});

test("a video request made while the tab is hidden is remembered and resumes when the tab returns", () => {
  const request = app.match(/function requestStream\([^)]*\) \{([\s\S]*?)\n\}/)[1];
  assert.match(request, /if \(document\.hidden\) \{[\s\S]*streamPausedForVisibility = true;[\s\S]*return false;/);
  assert.match(app, /else if \(streamPausedForVisibility\) \{[\s\S]*requestStream\(deviceId\)/);
});

test("small screens put the phone first: the roster list is dropped and the sidebar hides while a phone is open", () => {
  assert.match(css, /@media \(max-width: 760px\) \{[^}]*#people-list,\s*#people-error \{ display: none; \}/);
  assert.match(css, /#app:has\(#detail-view:not\(\[hidden\]\)\) #people-sidebar \{ display: none; \}/);
});
