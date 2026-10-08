import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const css = fs.readFileSync(new URL("../../../client/style.css", import.meta.url), "utf8");

// The size each selector ends up with: the last font-size written for it anywhere in the stylesheet.
function finalFontSizes() {
  const sizes = new Map();
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const size = rule[2].match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    if (!size) continue;
    for (const selector of rule[1].split(",")) sizes.set(selector.trim().replace(/\s+/g, " "), Number(size[1]));
  }
  return sizes;
}

const OPERATIONAL = /#fleet-toolbar label|\.user-state|device-card|device-access|device-safe|device-fact|device-error|device-attention|component-health|wda-lifecycle|wda-diagnostic|network-routing|proxy-pool|proxy-switch|mode-pill|mine-badge|controller-mode|card-message|ai-control-button|#fleet-summary/;

test("operational text on the fleet cards is at least 12px", () => {
  const small = [...finalFontSizes()].filter(([selector, size]) => OPERATIONAL.test(selector) && size < 12);
  assert.deepEqual(small, []);
});

test("cards line up at the top of their row and cannot push their neighbours around", () => {
  assert.match(css, /\.fleet-grid \{ align-items: start; \}/);
  assert.match(css, /\.device-card \{ min-width: 0; \}/);
});

test("buttons inside a card wrap their text instead of spilling past the card edge", () => {
  assert.match(css, /\.network-routing-panel button[^{]*\{[^}]*white-space: normal/);
  assert.match(css, /\.network-routing-panel[^{]*\{[^}]*max-width: 100%/);
});

const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");

test("the fleet header has ten tiles in two even rows, without a Total that repeats Physical devices", () => {
  const block = app.slice(app.indexOf("function renderFleetSummary"), app.indexOf("function systemHealthCounts"));
  assert.doesNotMatch(block, /\["Total"/);
  assert.equal((block.match(/^\s+\["[A-Za-z ]+", /gm) || []).length, 10);
  assert.match(css, /#fleet-summary \{[^}]*repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /#fleet-toolbar > label \{ justify-self: start; \}/);
});

test("a phone's card names the proxy assigned from the Proxies tab and never says 'No egress assigned' over it", () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
  const { egressLabel } = context.window.deviceCardModel;
  assert.equal(egressLabel({ poolProxy: { country: "US", label: "1", provider: "Oxylabs" }, network: {} }), "US 1 (Oxylabs)");
  assert.equal(egressLabel({ poolProxy: null, network: {} }), "No egress assigned");
  assert.equal(egressLabel({ poolProxy: null, network: { providerLabel: "Home gateway" } }), "Home gateway");
  assert.equal(egressLabel({ poolProxy: { label: "US 1" }, network: {} }, { proxyDisabled: true }), "Proxy disabled");
  assert.match(app, /deviceCardModel\.egressLabel\(d, \{ proxyDisabled, knownProviders: proxyPoolController\.getProviderLabels\(\) \}\)/);
  assert.match(css, /\.proxy-pool-picker \{ grid-template-columns: minmax\(0, 1fr\); gap: 5px; \}/);
});

const privacyPage = fs.readFileSync(new URL("../../../client/account-deletion.html", import.meta.url), "utf8");
const indexHtml = fs.readFileSync(new URL("../../../client/index.html", import.meta.url), "utf8");

test("the Privacy link in the header is a pill like the other header buttons, not a default blue link", () => {
  assert.match(indexHtml, /<a id="privacy-link" class="header-pill" href="\/account-deletion\.html">Privacy<\/a>/);
  assert.match(css, /#top-bar-right \.header-pill \{[^}]*border-radius: 6px/);
});

test("the Privacy Center applies the saved theme before it paints and uses the theme colours", () => {
  assert.ok(privacyPage.indexOf('/theme-bootstrap.js') !== -1 && privacyPage.indexOf('/theme-bootstrap.js') < privacyPage.indexOf('/style.css'));
  assert.match(css, /\.privacy-page \{ color: var\(--ink\); background: var\(--canvas\); \}/);
  assert.match(css, /\.privacy-form \{[^}]*background: var\(--surface-solid\)/);
});

test("Cancel and return to Bodun stays readable on hover (dark text on a light surface in both themes)", () => {
  assert.match(css, /\.privacy-button\.secondary:hover:not\(:disabled\) \{[^}]*background: var\(--soft-strong\); color: var\(--ink\)/);
});

test("the 'Type DELETE MY ACCOUNT' label is one line of text, not split into grid cells", () => {
  assert.match(privacyPage, /<span class="privacy-field-label">Type <strong>DELETE MY ACCOUNT<\/strong> to confirm<\/span>/);
  assert.match(css, /\.privacy-field-label \{ display: block; \}/);
});

test("every page shares one content width, centred on wide screens, with the scrollbar space always reserved", () => {
  assert.match(css, /html \{ scrollbar-gutter: stable; \}/);
  assert.match(css, /:root \{ --content-max: \d+px; \}/);
  for (const view of ["#fleet-view", "#detail-view", "#assignments-view", "#admin-view"]) {
    assert.ok(css.includes(view), `${view} is styled`);
  }
  assert.match(css, /#fleet-view > \*, #detail-view > \*, #assignments-view > \*, #admin-view > \* \{\s*max-width: var\(--content-max\);\s*margin-left: auto;\s*margin-right: auto;/);
});

test("switching theme happens in one paint (transitions are paused for that moment)", () => {
  assert.match(app, /root\.classList\.add\("theme-switching"\)/);
  assert.match(app, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => root\.classList\.remove\("theme-switching"\)\)\)/);
  assert.match(css, /html\.theme-switching \*[^{]*\{ transition: none !important;/);
});

test("the three navigation entries use the same kind of icon, and none of them is a tick that reads as 'done'", () => {
  const nav = indexHtml.slice(indexHtml.indexOf('id="admin-nav"'), indexHtml.indexOf('id="people-heading"'));
  assert.equal((nav.match(/class="nav-icon"/g) || []).length, 3);
  assert.doesNotMatch(nav, /&#10003;/);
  assert.equal((nav.match(/stroke-width="1\.4"/g) || []).length, 3);
});

test("the proxy form uses the same placeholders throughout and keeps Test Proxy beside Add proxy", () => {
  for (const placeholder of ["Provider name", "Host name", "Port number", "Username", "Password", "US", "Optional name, e.g. US pool 1"]) {
    assert.ok(indexHtml.includes(`placeholder="${placeholder}"`), placeholder);
  }
  assert.match(indexHtml, /<div class="user-form-footer">\s*<button type="button" id="proxy-pool-test-button"[^>]*>Test Proxy<\/button>\s*<button type="submit">Add proxy<\/button>\s*<\/div>/);
  assert.match(indexHtml, /id="proxy-pool-password" type="password"/, "the password stays masked");
});

test("the status chip rows leave room for the longest label ('Not checked') beside the longest name", () => {
  assert.match(css, /\.component-health-row \{ padding: 5px 6px; gap: 4px; \}/);
});

test("no page keeps its own private width: Fleet, Assignments, Operations and the phone view all use the shared one", () => {
  assert.doesNotMatch(css, /max-width:\s*1120px/);
  assert.doesNotMatch(css, /#(fleet-toolbar|fleet-groups|select-error|fleet-empty|fleet-intro)[^{]*\{[^}]*max-width:\s*1180px/);
});

test("the network enrollment panel spans the full card width so its button cannot overflow the border", () => {
  assert.match(css, /\.device-card-tools \.network-routing-panel \{ grid-column: 1 \/ -1; grid-template-columns: minmax\(0, 1fr\); \}/);
});

test("a lone button in the card tools (for example Check network) takes the full row instead of half of it", () => {
  assert.match(css, /\.device-card-tools > button \{ grid-column: 1 \/ -1; \}/);
});

test("the page chrome (header, version badge, sidebar labels, people lines) is at least 12px", () => {
  const sizes = finalFontSizes();
  const chrome = [
    ".brand-copy span", ".app-version", "#connection-status.connection-state", "#theme-toggle", "#logout-button",
    "#research-toggle", "#review-toggle", "#role-badge", ".sidebar-label", "#people-summary", ".person-details span",
  ];
  const small = chrome.filter(selector => !(sizes.get(selector) >= 12)).map(selector => `${selector}: ${sizes.get(selector)}`);
  assert.deepEqual(small, []);
});

test("the version badge sits in the right-hand header group and is never squeezed or cut off", () => {
  const right = indexHtml.slice(indexHtml.indexOf('id="top-bar-right"'), indexHtml.indexOf("</header>"));
  const left = indexHtml.slice(indexHtml.indexOf('id="top-bar-left"'), indexHtml.indexOf('id="top-bar-right"'));
  assert.match(right, /id="app-version"/);
  assert.doesNotMatch(left, /id="app-version"/);
  assert.match(css, /\.app-version \{ flex: none; white-space: nowrap; \}/);
  assert.doesNotMatch(css, /\.app-version \{[^}]*text-overflow: ellipsis/);
});

test("the Operations panels (hint lines, tables, presence and audit lines, command output) are at least 12px", () => {
  const sizes = finalFontSizes();
  const panels = [
    ".admin-panel-heading span", ".admin-table th", ".admin-table td", ".user-presence",
    ".user-card details summary", ".user-card details li", "#command-output", "#stream-status",
    ".assignment-status", ".assignment-recurrence", ".assignment-manage-grid > label", ".assignment-manage-grid > button", ".assignment-manage button",
    ".assignment-card details", ".assignment-card details li",
  ];
  const small = panels.filter(selector => !(sizes.get(selector) >= 12)).map(selector => `${selector}: ${sizes.get(selector)}`);
  assert.deepEqual(small, []);
});

test("the Privacy page labels are at least 12px and the teal label is readable on both themes", () => {
  const sizes = finalFontSizes();
  for (const selector of [".privacy-card-kicker", ".privacy-export small"]) assert.ok(sizes.get(selector) >= 12, `${selector}: ${sizes.get(selector)}`);
  assert.match(css, /\.privacy-form \.privacy-card-kicker \{ color: #1a7073; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \.privacy-form \.privacy-card-kicker \{ color: #7fd3d5; \}/);
});

test("the sign-in, application and recovery screens (brand sub-label, field labels) are at least 12px", () => {
  const sizes = finalFontSizes();
  for (const selector of [".login-brand span:not(.brand-mark)", ".login-field", ".recovery-complete-fields legend"]) assert.ok(sizes.get(selector) >= 12, `${selector}: ${sizes.get(selector)}`);
});

test("light theme: the card colours that were made for the dark page have readable light-theme versions", () => {
  const light = ':root:not([data-theme="dark"])';
  for (const selector of [
    ".component-health-row span", ".open-files-button", ".device-card-tools .wda-stop-button", ".device-card-tools .wda-start-button",
    '.wda-lifecycle-copy span[data-tone="healthy"]', '.wda-lifecycle-copy span[data-tone="warning"]', '.wda-lifecycle-copy span[data-tone="error"]',
    '.card-message[data-tone="error"]', '.card-message[data-tone="success"]',
    ".user-form button.destructive-action", ".user-form button.danger", ".user-actions-menu button.danger", '#proxy-pool-message[data-tone="error"]',
    ".privacy-eyebrow", ".privacy-promise-mark",
  ]) assert.ok(css.includes(`${light} ${selector} {`), `no light-theme rule for ${selector}`);
});

test("message lines read on the light theme, and a confirmation note under an assignment is green rather than error red", () => {
  const light = ':root:not([data-theme="dark"])';
  for (const selector of [
    "#select-error", "#people-error", "#login-error", "#signup-message", "#two-factor-message", "#recovery-message",
    "#assignments-message", "#users-message", "#detail-message", ".assignment-card-message", ".network-routing-inline-error", "#file-list button",
    '.assignment-card-message[data-tone="success"]',
  ]) assert.ok(css.includes(`${light} ${selector} {`), `no light-theme rule for ${selector}`);
  assert.match(css, /\n\.assignment-card-message\[data-tone="success"\] \{ color: var\(--online\); \}/);
});
